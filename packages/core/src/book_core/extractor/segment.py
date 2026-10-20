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
from collections.abc import Sequence
from dataclasses import dataclass, field

from book_core.contracts import BBox, Block, BlockType, QuestionType, SourceLocation
from book_core.question.labels import CIRCLED_DIGITS, split_option_line

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


def _table_options(block: Block, index: int) -> tuple[list[str], list[RawOption]]:
    """``(header parts, options)`` of a table whose rows start with circled option labels (at
    least two); ``([], [])`` for any other table. Cells are joined as printed (`` | ``)."""
    if block.table is None:
        return [], []
    rows = [[cell.strip() for cell in row] for row in block.table.rows]
    labelled = [i for i, row in enumerate(rows) if len(row[0]) == 1 and row[0] in CIRCLED_DIGITS]
    if len(labelled) < 2:
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

    for index, block, lines in _lines(blocks):
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
                if not current.options:
                    header, table_options = _table_options(block, index)
                    if table_options:
                        current.stem_parts += header
                        current.stem_lines += [table_options[0].lines[0]] if header else []
                        current.options += table_options
            continue

        for text in lines:
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
