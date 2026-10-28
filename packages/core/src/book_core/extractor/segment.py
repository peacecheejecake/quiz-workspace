"""Deterministic, rule-based pre-extraction of a question paper (no LLM).

Walks the parsed blocks in reading order, split into lines (Docling emits one block per printed
line, the ideal fixture documents one block per question), and segments:

- questions by numbering (``1.``, ``1번``, ``문 1.``, ``Q1.``), or a bare number (``01 ...``) on a
  heading line or a line with a question cue (``?``, ``시오``, an answer blank ``( )``); a bare
  number that ends up with neither options, a cue nor an answer is a section heading, not a
  question;
- options (``①``-``⑩``, ``A.``/``A)``, ``(1)``/``(A)``, ``1)``, ``a)``), continuation lines, and
  options printed as table rows (``① | 6개월 | 1년``; header rows above them belong to the stem);
- figures: image blocks inside a question's span plus their caption (``[그림 1]``, ``Figure 1``),
  or a labelled figure elsewhere that the stem refers to;
- an inline answer printed right after a question (``정답: ②``, ``[정답] ②``, ``Answer: B``): it
  answers that question only (repeated numbers per chapter are fine), and the printed text after
  it up to the next question or heading is the question's explanation (해설), never options;
- the answer key: lines after an answer-key heading (``정답``, ``Answer key``), or a run of
  numbered lines that repeat earlier question numbers with short bodies (``1. ②``), including
  ``N. answer`` entries packed on one line and two-column / two-row tables.

Question types are heuristic: options -> MCQ (multi-select when the stem asks for all/several
correct options), otherwise ESSAY for writing cues (서술하시오, 설명하시오, explain, ...) or a large
blank answer area below the question, else SHORT_ANSWER.

Nothing here invents content: every stem/option/answer string is copied from the source lines.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from book_core.contracts import BBox, Block, BlockType, QuestionType, SourceLocation
from book_core.question.labels import CIRCLED_DIGITS, split_option_line
from book_core.structure.numbering import NumberingKind, parse_numbering

_QUESTION_START = re.compile(
    r"^\s*(?:문(?:제)?\s*|Q\s*)?(?P<num>\d{1,3})\s*(?:\.|번[.)]?)(?!\d)\s*(?P<body>\S.*)$"
)
_ANSWER_KEY_HEADING = re.compile(
    r"^\s*[\[<(]?\s*(?:정답(?:\s*(?:및|과)\s*해설)?|정답표|빠른\s*정답|답안|"
    r"answer\s*key|answers)\s*[\]>)]?\s*:?\s*$",
    re.IGNORECASE,
)
_ANSWER_ENTRY = re.compile(
    r"(?P<num>\d{1,3})\s*(?:\.|번[.)]?|\))\s*(?P<ans>.+?)(?=\s+\d{1,3}\s*(?:\.|번[.)]?|\))\s|$)"
)
_CAPTION = re.compile(
    r"^\s*[\[<(]?\s*(?P<label>(?:그림|도표|표|Figure|Fig\.?|Table)\s*\d+)\s*[\]>)]?",
    re.IGNORECASE,
)
_FIGURE_REF = re.compile(
    r"[\[<(]?\s*(?P<label>(?:그림|도표|Figure|Fig\.?)\s*\d+)\s*[\]>)]?", re.IGNORECASE
)
_MULTI_CUES = re.compile(
    r"모두\s*(?:고르|골라|찾)|(?:두|세|2|3)\s*개(?:를)?\s*(?:고르|골라)|있는\s*대로\s*고르|"
    r"all\s+that\s+apply|select\s+all|choose\s+all|choose\s+(?:two|three)|select\s+(?:two|three)",
    re.IGNORECASE,
)
_ESSAY_CUES = re.compile(
    r"서술하(?:시오|라)|논술하(?:시오|라)|설명하(?:시오|라)|논하(?:시오|라)|"
    r"\b(?:explain|describe|discuss|justify)\b",
    re.IGNORECASE,
)
_BARE_QUESTION_START = re.compile(r"^\s*(?P<num>\d{1,3})\s+(?P<body>\S.*)$")
_QUESTION_CUE = re.compile(r"[?\uff1f]|시오|하라|\(\s*\)\s*$")
_INLINE_ANSWER = re.compile(
    r"^\s*(?:[\[<(]\s*정답\s*[\]>)]\s*[:\uff1a]?|정답\s*[:\uff1a]|answer\s*[:\uff1a])\s*(?P<ans>\S.*)$",
    re.IGNORECASE,
)
_QUESTION_END_CUES = re.compile(
    r"[?\uff1f]\s*(?:\(\s*\)\s*)?$|시오\.?\s*$|하라\.?\s*$|\b(?:is|are|which)\b.*$"
)
_INLINE_CIRCLED = re.compile(r"(?<=\s)①")
_MAX_ANSWER_KEY_BODY = 40
_ANSWER_AREA_MIN_GAP = 60.0
"""Blank vertical space (PDF points) below a question without options that marks an answer
box/area; plain question spacing in typical papers is 20-35 pt."""


@dataclass(frozen=True, slots=True)
class SourceLine:
    """One printed line and the block it came from."""

    text: str
    block: Block
    block_index: int


@dataclass(slots=True)
class RawOption:
    label: str
    text: str
    lines: list[SourceLine]


@dataclass(slots=True)
class RawFigure:
    label: str | None
    image: Block | None
    caption: SourceLine | None


@dataclass(slots=True)
class RawQuestion:
    number: int
    stem_lines: list[SourceLine]
    stem_parts: list[str]
    options: list[RawOption] = field(default_factory=list)
    figures: list[RawFigure] = field(default_factory=list)
    trailing: list[SourceLine] = field(default_factory=list)
    block_indices: list[int] = field(default_factory=list)
    bare_number: bool = False
    """Numbered without a period (``01 ...``): kept only if it turns out to be a question."""
    answer: list[AnswerKeyEntry] = field(default_factory=list)
    """The inline answer line printed right after this question (``정답: ②``)."""
    explanation_lines: list[SourceLine] = field(default_factory=list)
    explanation_closed: bool = False
    chapter: int = 0
    """Index of the top-level chapter it was segmented in (``segment_chapters``)."""

    @property
    def stem(self) -> str:
        return " ".join(p for p in self.stem_parts if p).strip()

    @property
    def figure_labels(self) -> list[str]:
        return sorted({_norm_label(m.group("label")) for m in _FIGURE_REF.finditer(self.stem)})

    @property
    def answered(self) -> bool:
        """The inline answer was read: what follows is explanation, not the question."""
        return bool(self.answer)

    @property
    def explanation(self) -> str | None:
        text = "\n".join(line.text for line in self.explanation_lines).strip()
        return text or None

    def is_question(self) -> bool:
        return not self.bare_number or bool(
            self.options or self.answer or _QUESTION_CUE.search(self.stem)
        )


@dataclass(frozen=True, slots=True)
class AnswerKeyEntry:
    number: int
    text: str
    line: SourceLine
    chapter: int = 0


@dataclass(slots=True)
class Segmentation:
    questions: list[RawQuestion]
    answer_key: list[AnswerKeyEntry]
    loose_figures: list[RawFigure]
    unparsed_answer_lines: int = 0
    ambiguous_answer_tables: int = 0


def _norm_label(label: str) -> str:
    return re.sub(r"\s+", "", label).lower().replace("fig.", "figure").replace("fig", "figure")


def _lines(blocks: Sequence[Block]) -> list[tuple[int, Block, list[str]]]:
    out = []
    for index, block in enumerate(blocks):
        if block.type in (BlockType.TEXT, BlockType.HEADING, BlockType.FORMULA):
            lines = [line.strip() for line in block.text.split("\n") if line.strip()]
            out.append((index, block, lines))
        else:
            out.append((index, block, []))
    return out


def _looks_like_answer(body: str) -> bool:
    body = body.strip()
    return len(body) <= _MAX_ANSWER_KEY_BODY and not _QUESTION_END_CUES.search(body)


def _answer_entries(line: SourceLine) -> list[AnswerKeyEntry]:
    return [
        AnswerKeyEntry(number=int(m.group("num")), text=m.group("ans").strip(), line=line)
        for m in _ANSWER_ENTRY.finditer(line.text)
        if m.group("ans").strip()
    ]


_NUMBER_LABEL = re.compile(r"^(?:번호|문항|문제|no\.?|number|q)$", re.IGNORECASE)
_ANSWER_LABEL = re.compile(r"^(?:정답|답|answer|answers|ans\.?)$", re.IGNORECASE)


def _cell_number(cell: str) -> int | None:
    """A question number cell (``3``, ``3.``, ``3번``, fullwidth digits), else ``None``.

    Decimal digits only: ``str.isdigit`` also accepts circled digits and superscripts, which
    ``int`` rejects, and a circled digit in a table is an answer, never a question number.
    """
    cell = cell.strip().rstrip(".번").strip()
    return int(cell) if cell.isdecimal() and len(cell) <= 4 else None


def _increasing(cells: Sequence[str], after: int) -> int | None:
    """Last number when the non-empty ``cells`` are all numbers strictly increasing from
    ``after`` (trailing blanks allowed), else ``None``."""
    values = [c for c in cells if c.strip()]
    if not values or any(c.strip() == "" for c in cells[: len(values)]):
        return None
    last = after
    for cell in values:
        number = _cell_number(cell)
        if number is None or number <= last:
            return None
        last = number
    return last


def _pairs_vertical(
    rows: Sequence[Sequence[str]], number_cols: Sequence[int]
) -> list[tuple[str, str]]:
    return [
        (row[c], row[c + 1])
        for c in number_cols
        for row in rows
        if c + 1 < len(row) and row[c].strip() and row[c + 1].strip()
    ]


def _pairs_horizontal(
    rows: Sequence[Sequence[str]], number_rows: Sequence[int], first_col: int
) -> list[tuple[str, str]]:
    return [
        (rows[r][c], rows[r + 1][c])
        for r in number_rows
        if r + 1 < len(rows)
        for c in range(first_col, len(rows[r]))
        if rows[r][c].strip() and rows[r + 1][c].strip()
    ]


def _table_orientation(
    rows: Sequence[Sequence[str]],
) -> tuple[str, list[tuple[str, str]]]:
    """``("vertical" | "horizontal", (number, answer) pairs)``, ``("ambiguous", [])`` or
    ``("unknown", [])``.

    Header labels (번호/정답, No./Answer) decide first: labels across the first row mean one
    question per row, labels down the first column one question per column. Without labels the
    question-number sequence decides: number columns (every other column) increasing down the
    rows versus number rows (every other row) increasing across. When both readings are
    consistent the table is ambiguous and nothing is applied (wrong answers are worse than none).
    """
    width = len(rows[0])
    header = rows[0]
    first_col = [row[0] for row in rows]
    by_row = any(_NUMBER_LABEL.match(c.strip()) for c in header) and any(
        _ANSWER_LABEL.match(c.strip()) for c in header
    )
    by_col = any(_NUMBER_LABEL.match(c.strip()) for c in first_col) and any(
        _ANSWER_LABEL.match(c.strip()) for c in first_col
    )
    if by_row and not by_col:
        cols = [i for i, c in enumerate(header) if _NUMBER_LABEL.match(c.strip())]
        cols = [c for c in cols if c + 1 < width and _ANSWER_LABEL.match(header[c + 1].strip())]
        return ("vertical", _pairs_vertical(rows[1:], cols)) if cols else ("unknown", [])
    if by_col and not by_row:
        number_rows = [
            i
            for i, c in enumerate(first_col)
            if _NUMBER_LABEL.match(c.strip())
            and i + 1 < len(rows)
            and _ANSWER_LABEL.match(first_col[i + 1].strip())
        ]
        if not number_rows:
            return "unknown", []
        return "horizontal", _pairs_horizontal(rows, number_rows, 1)
    if by_row and by_col:
        return "ambiguous", []

    vertical = width % 2 == 0
    last = 0
    for c in range(0, width, 2):
        found = _increasing([row[c] for row in rows], last) if vertical else None
        if found is None:
            vertical = False
            break
        last = found
    horizontal = len(rows) % 2 == 0
    last = 0
    for r in range(0, len(rows), 2):
        found = _increasing(rows[r], last) if horizontal else None
        if found is None:
            horizontal = False
            break
        last = found
    if vertical and horizontal:
        return "ambiguous", []
    if vertical:
        return "vertical", _pairs_vertical(rows, range(0, width, 2))
    if horizontal:
        return "horizontal", _pairs_horizontal(rows, range(0, len(rows), 2), 0)
    return "unknown", []


def _table_answer_entries(block: Block, index: int) -> tuple[list[AnswerKeyEntry], bool]:
    """Answer-key entries of a table block and whether its orientation was ambiguous."""
    if block.table is None:
        return [], False
    rows = [[cell.strip() for cell in row] for row in block.table.rows]
    orientation, pairs = _table_orientation(rows)
    line = SourceLine(text=block.text, block=block, block_index=index)
    entries = [
        AnswerKeyEntry(number=number, text=answer.strip(), line=line)
        for raw_number, answer in pairs
        if (number := _cell_number(raw_number)) is not None
    ]
    return entries, orientation == "ambiguous"


def _table_options(
    block: Block, index: int, *, min_rows: int = 2
) -> tuple[list[str], list[RawOption]]:
    """``(header parts, options)`` of a table whose rows start with circled option labels (at
    least ``min_rows``); ``([], [])`` for any other table. Cells are joined as printed
    (`` | ``)."""
    if block.table is None:
        return [], []
    rows = [[cell.strip() for cell in row] for row in block.table.rows]
    labelled = [i for i, row in enumerate(rows) if len(row[0]) == 1 and row[0] in CIRCLED_DIGITS]
    if len(labelled) < min_rows:
        return [], []
    line = SourceLine(text=block.text, block=block, block_index=index)
    header = [" | ".join(c for c in row if c) for row in rows[: labelled[0]]]
    options = [
        RawOption(label=rows[i][0], text=" | ".join(c for c in rows[i][1:] if c), lines=[line])
        for i in labelled
    ]
    return [h for h in header if h], options


def _split_inline_options(text: str) -> tuple[str, list[tuple[str, str]]]:
    """A stem line that continues with circled options (``...는? ① 응결 ② 증발``), as a parser
    may merge a question into one paragraph: ``(stem part, options)``."""
    match = _INLINE_CIRCLED.search(text)
    if match is None:
        return text, []
    options = split_option_line(text[match.start() :].strip()) or []
    return text[: match.start()].strip(), options


def _question_start(text: str, block: Block) -> re.Match[str] | None:
    """``1.``-style numbering anywhere; a bare ``01 ...`` number on a heading line or a line
    with a question cue (a numbered sentence in running text is not a question)."""
    start = _QUESTION_START.match(text)
    if start is not None:
        return start
    bare = _BARE_QUESTION_START.match(text)
    if bare is not None and (
        block.type is BlockType.HEADING or _QUESTION_CUE.search(bare.group("body"))
    ):
        return bare
    return None


def _inline_answer(text: str) -> str | None:
    match = _INLINE_ANSWER.match(text)
    if match is None:
        return None
    answer = match.group("ans").strip().rstrip(".").strip()
    return answer if answer and len(answer) <= _MAX_ANSWER_KEY_BODY else None


@dataclass(frozen=True, slots=True)
class _Event:
    """A printed line (``text``) or a non-text block (``text is None``) in reading order."""

    index: int
    block: Block
    text: str | None


def _flatten(blocks: Sequence[Block]) -> list[_Event]:
    events: list[_Event] = []
    for index, block, lines in _lines(blocks):
        if not lines:
            events.append(_Event(index, block, None))
        events += [_Event(index, block, text) for text in lines]
    return events


def _span_blocks(events: Sequence[_Event], start: int) -> list[Block]:
    """The blocks a numbered line at ``events[start]`` would own, trimmed to the lines in that
    span: up to the next numbered line, the answer-key heading, a heading that is not an
    inline answer line (a section title ends an explanation), or the end."""
    span: list[_Event] = [events[start]]
    for event in events[start + 1 :]:
        text = event.text
        if text is not None and (
            _ANSWER_KEY_HEADING.match(text)
            or _question_start(text, event.block) is not None
            or (event.block.type is BlockType.HEADING and _inline_answer(text) is None)
        ):
            break
        span.append(event)
    order: list[tuple[int, Block]] = []
    lines: dict[int, list[str]] = {}
    for event in span:
        if event.text is None:
            order.append((event.index, event.block))
            continue
        if event.index not in lines:
            lines[event.index] = []
            order.append((event.index, event.block))
        lines[event.index].append(event.text)
    return [
        block.model_copy(update={"text": "\n".join(lines[index])}) if index in lines else block
        for index, block in order
    ]


def _asks_something(events: Sequence[_Event], start: int) -> bool:
    """Whether a numbered line inside an explanation opens a question. Decided by a dry run of
    ``segment`` itself over the span the line would own (so every option layout the normal path
    reads counts the same): a question with options, an inline answer or a question cue."""
    found = segment(_span_blocks(events, start)).questions
    return bool(found) and bool(
        found[0].options or found[0].answer or _QUESTION_CUE.search(found[0].stem)
    )


def segment(blocks: Sequence[Block]) -> Segmentation:
    questions: list[RawQuestion] = []
    answer_key: list[AnswerKeyEntry] = []
    loose_figures: list[RawFigure] = []
    caption_owner: dict[str, RawFigure] = {}
    in_answer_key = False
    current: RawQuestion | None = None
    seen_numbers: set[int] = set()
    unparsed = 0
    ambiguous_tables = 0
    inline_answers = False
    flat = _flatten(blocks)
    position = 0

    for index, block, lines in _lines(blocks):
        position += 0 if lines else 1
        if block.type is BlockType.IMAGE:
            figure = RawFigure(label=None, image=block, caption=None)
            if block.caption_block_id is not None:
                caption_owner[block.caption_block_id] = figure
            if current is not None and not in_answer_key and not current.answered:
                current.figures.append(figure)
                current.block_indices.append(index)
            else:
                loose_figures.append(figure)
            continue
        if block.type is BlockType.TABLE:
            if in_answer_key:
                found, ambiguous = _table_answer_entries(block, index)
                answer_key += found
                if ambiguous:
                    ambiguous_tables += 1
                elif not found:
                    unparsed += 1
            elif current is not None and not current.answered:
                current.block_indices.append(index)
                # An option table split across pages comes as several tables: a later one
                # (even a single row) continues the options; only the first one's header rows
                # belong to the stem.
                continues = bool(current.options)
                header, table_options = _table_options(block, index, min_rows=1 if continues else 2)
                if table_options:
                    if not continues:
                        current.stem_parts += header
                        current.stem_lines += [table_options[0].lines[0]] if header else []
                    current.options += table_options
            continue

        for text in lines:
            position += 1
            line = SourceLine(text=text, block=block, block_index=index)
            if _ANSWER_KEY_HEADING.match(text):
                in_answer_key = True
                current = None
                continue
            if in_answer_key:
                found = _answer_entries(line)
                answer_key += found
                unparsed += 0 if found else 1
                continue

            owner = caption_owner.get(block.id)
            caption = None if _QUESTION_END_CUES.search(text) else _CAPTION.match(text)
            if owner is not None and owner.caption is None:
                owner.caption = line
                owner.label = _norm_label(caption.group("label")) if caption else None
                if (
                    current is not None
                    and not current.answered
                    and index not in current.block_indices
                ):
                    current.block_indices.append(index)
                continue

            start = _question_start(text, block)
            if (
                start is not None
                and current is not None
                and current.answered
                and block.type is not BlockType.HEADING
                and not _QUESTION_CUE.search(start.group("body"))
                and not _asks_something(flat, position - 1)
            ):
                # A numbered line inside a printed explanation (``1. 첫째 이유``) is part of it
                # unless what it opens asks something; either way the lines then take the
                # normal path (explanation, or a new question).
                start = None
            if start is not None:
                number = int(start.group("num"))
                body = start.group("body")
                if (
                    questions
                    and not inline_answers
                    and number in seen_numbers
                    and number <= max(seen_numbers)
                    and _looks_like_answer(body)
                ):
                    in_answer_key = True
                    current = None
                    answer_key += _answer_entries(line)
                    continue
                head, inline = _split_inline_options(body)
                current = RawQuestion(
                    number=number,
                    stem_lines=[line],
                    stem_parts=[head],
                    bare_number=start.re is _BARE_QUESTION_START,
                )
                current.options += [RawOption(label=lb, text=t, lines=[line]) for lb, t in inline]
                current.block_indices.append(index)
                questions.append(current)
                seen_numbers.add(number)
                continue
            if current is None:
                if caption is not None:  # a shared figure printed before its questions
                    label = _norm_label(caption.group("label"))
                    pending = next(
                        (f for f in reversed(loose_figures) if f.caption is None and f.image),
                        None,
                    )
                    if pending is not None:
                        pending.caption, pending.label = line, label
                    else:
                        loose_figures.append(RawFigure(label=label, image=None, caption=line))
                continue  # title, instructions, running text before the first question

            if current.answered:
                # The explanation runs to the next question; a heading (a chapter title, the
                # next set's instructions) ends it.
                if block.type is BlockType.HEADING:
                    current.explanation_closed = True
                if not current.explanation_closed:
                    current.explanation_lines.append(line)
                continue
            answer = _inline_answer(text)
            if answer is not None:
                current.answer.append(AnswerKeyEntry(number=current.number, text=answer, line=line))
                inline_answers = True
                continue

            if index not in current.block_indices:
                current.block_indices.append(index)
            if caption is not None:
                label = _norm_label(caption.group("label"))
                pending = next(
                    (f for f in reversed(current.figures) if f.caption is None and f.image), None
                )
                if pending is not None:
                    pending.caption = line
                    pending.label = label
                else:
                    current.figures.append(RawFigure(label=label, image=None, caption=line))
                continue

            options = split_option_line(text)
            if options is not None:
                for label, option_text in options:
                    current.options.append(RawOption(label=label, text=option_text, lines=[line]))
                continue
            if current.options:
                last = current.options[-1]
                last.text = f"{last.text} {text}".strip()
                last.lines.append(line)
            else:
                head, inline = _split_inline_options(text)
                current.stem_parts.append(head)
                current.stem_lines.append(line)
                current.options += [RawOption(label=lb, text=t, lines=[line]) for lb, t in inline]

    return Segmentation(
        questions=[q for q in questions if q.is_question()],
        answer_key=answer_key,
        loose_figures=loose_figures,
        unparsed_answer_lines=unparsed,
        ambiguous_answer_tables=ambiguous_tables,
    )


_CHAPTER_KINDS = (NumberingKind.PART, NumberingKind.CHAPTER)


def chapter_starts(blocks: Sequence[Block]) -> list[int]:
    """Block indices where a chapter starts: 0, then every heading numbered as a part or chapter
    (``제1장``, ``2장``, ``Chapter 3``, ``제1편``, ``Part II``; the structure module's numbering).
    Other headings never split: Docling prints question lines, inline answers and wrapped stems
    of exam workbooks as headings too, and cutting there would separate a question from its
    answer."""
    return [0] + [
        i
        for i, b in enumerate(blocks)
        if i
        and b.type is BlockType.HEADING
        and (numbering := parse_numbering(b.text.split("\n")[0])) is not None
        and numbering.kind in _CHAPTER_KINDS
    ]


def _shift_line(line: SourceLine, offset: int) -> SourceLine:
    return replace(line, block_index=line.block_index + offset)


def _shift_entry(entry: AnswerKeyEntry, offset: int, chapter: int) -> AnswerKeyEntry:
    return replace(entry, line=_shift_line(entry.line, offset), chapter=chapter)


def _shift_question(question: RawQuestion, offset: int, chapter: int) -> None:
    question.chapter = chapter
    question.block_indices = [i + offset for i in question.block_indices]
    question.stem_lines = [_shift_line(ln, offset) for ln in question.stem_lines]
    question.trailing = [_shift_line(ln, offset) for ln in question.trailing]
    question.explanation_lines = [_shift_line(ln, offset) for ln in question.explanation_lines]
    for option in question.options:
        option.lines = [_shift_line(ln, offset) for ln in option.lines]
    question.answer = [_shift_entry(e, offset, chapter) for e in question.answer]


def segment_chapters(blocks: Sequence[Block]) -> Segmentation:
    """``segment`` run per chapter (``chapter_starts``), merged with document-wide
    block indices and every question / key entry tagged with its ``chapter``.

    ``segment`` reads a repeated number with a short body as the start of an answer key and stays
    in it to the end; in a book whose chapters each restart their numbering (numbered headings,
    exercises, a key per chapter) that would swallow every later chapter. Numbering restarts per
    chapter, so each chapter is read on its own. A document with a single chapter is segmented
    exactly as by ``segment``. Use ``answer_entries`` to match the key to the questions."""
    starts = chapter_starts(blocks)
    if len(starts) == 1:
        return segment(blocks)
    merged = Segmentation(questions=[], answer_key=[], loose_figures=[])
    for chapter, (start, end) in enumerate(zip(starts, [*starts[1:], len(blocks)], strict=True)):
        seg = segment(blocks[start:end])
        for question in seg.questions:
            _shift_question(question, start, chapter)
        merged.questions += seg.questions
        merged.answer_key += [_shift_entry(e, start, chapter) for e in seg.answer_key]
        merged.loose_figures += seg.loose_figures
        merged.unparsed_answer_lines += seg.unparsed_answer_lines
        merged.ambiguous_answer_tables += seg.ambiguous_answer_tables
    return merged


def _asks(question: RawQuestion) -> bool:
    return bool(question.options) or _QUESTION_CUE.search(question.stem) is not None


def answer_entries(seg: Segmentation) -> dict[int, list[AnswerKeyEntry]]:
    """``id(question)`` -> the answer-key entries for it (not its inline answer).

    A question whose number appears once in the document takes every entry with that number,
    wherever the key is printed (one key for the whole paper, or an answer chapter). A number
    repeated across chapters takes its own chapter's entries when it appears once in that chapter
    (numbering restarts per chapter, each with its own key), or when it is the only one of them
    there that asks something (options or a question cue). Otherwise nothing: a wrong answer is
    worse than none. With a single chapter this is the document-wide match by unique number."""
    in_chapter = Counter((q.chapter, q.number) for q in seg.questions)
    # A numbered heading (``1. 개요``) is read as a question too; among a chapter's questions
    # with the same number, the one that asks something is the one its key answers.
    asking = Counter((q.chapter, q.number) for q in seg.questions if _asks(q))
    in_document = Counter(q.number for q in seg.questions)
    own: dict[tuple[int, int], list[AnswerKeyEntry]] = {}
    every: dict[int, list[AnswerKeyEntry]] = {}
    for entry in seg.answer_key:
        own.setdefault((entry.chapter, entry.number), []).append(entry)
        every.setdefault(entry.number, []).append(entry)
    found: dict[int, list[AnswerKeyEntry]] = {}
    for question in seg.questions:
        entries: list[AnswerKeyEntry] = []
        if in_document[question.number] == 1:
            entries = every.get(question.number, [])
        elif in_chapter[(question.chapter, question.number)] == 1 or (
            _asks(question) and asking[(question.chapter, question.number)] == 1
        ):
            entries = own.get((question.chapter, question.number), [])
        found[id(question)] = entries
    return found


def infer_type(question: RawQuestion, next_block: Block | None) -> tuple[QuestionType, bool]:
    """``(question_type, multi_select)`` from options, stem cues and the blank answer area."""
    if question.options:
        return QuestionType.MCQ, bool(_MULTI_CUES.search(question.stem))
    if _ESSAY_CUES.search(question.stem):
        return QuestionType.ESSAY, False
    bottom = question_bottom(question)
    if bottom is not None and next_block is not None:
        page, y1 = bottom
        loc = next_block.locations[0]
        if loc.page == page and loc.bbox is not None and loc.bbox.y0 - y1 >= _ANSWER_AREA_MIN_GAP:
            return QuestionType.ESSAY, False
    return QuestionType.SHORT_ANSWER, False


def question_bottom(question: RawQuestion) -> tuple[int, float] | None:
    """Page and lowest edge of the question's last located line."""
    lines = [*question.stem_lines, *(ln for o in question.options for ln in o.lines)]
    last = max(lines, key=lambda ln: ln.block_index)
    loc = last.block.locations[-1]
    return (loc.page, loc.bbox.y1) if loc.bbox is not None else None


def union_locations(blocks: Sequence[Block]) -> tuple[SourceLocation, ...]:
    """One location per page: the union bbox of the blocks' parts on that page (page-only when
    no part on the page has a bbox)."""
    pages: dict[int, BBox | None] = {}
    order: list[int] = []
    for block in blocks:
        for loc in block.locations:
            if loc.page not in pages:
                pages[loc.page] = loc.bbox
                order.append(loc.page)
                continue
            current = pages[loc.page]
            if loc.bbox is None:
                continue
            pages[loc.page] = (
                loc.bbox
                if current is None
                else BBox(
                    x0=min(current.x0, loc.bbox.x0),
                    y0=min(current.y0, loc.bbox.y0),
                    x1=max(current.x1, loc.bbox.x1),
                    y1=max(current.y1, loc.bbox.y1),
                )
            )
    return tuple(SourceLocation(page=page, bbox=pages[page]) for page in order)
