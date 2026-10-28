"""Content kind of an uploaded PDF: body text, a question paper, or both (UX6-UPLOAD-B).

``classify_content(blocks)`` decides whether a parsed document is a ``book`` (body text to read
and search), a ``question_paper`` (questions to import) or ``mixed`` (a book that also prints
questions, e.g. chapter-end exercises). It reuses the question extractor's own segmentation
(``segment``), so a "question" here is exactly what an import would find; there is no second
detector to drift from it. Deterministic, no LLM, no document text in the result.

The document is segmented chapter by chapter (runs starting at each top-level heading):
``segment`` reads a repeated number with a short body as the start of an answer key and stays in
it, so a book whose numbered headings restart in every chapter would otherwise hide every later
exercise. An answer section printed as its own chapter keys the questions of the others.

Evidence:

- **strong question**: a segmented question that asks something *and* can be answered, or
  prints its answer: an inline ``정답:`` line; or at least two options labelled in sequence from
  the first (``①②``, ``A B``, ``(1)(2)``) with a question cue in the stem (``?``, ``시오``,
  ``것은``, ``고르``, an answer blank, ``which``/``choose`` ...) or an answer-key entry naming
  option labels; or a cue plus any answer-key entry. Plain numbered lines are weak evidence and
  never count: textbook headings (``1. 개요``) and statute paragraphs (``1. 예금자보호법``
  followed by ``① 이 법은 ...``) look like numbered stems with options but ask nothing.
- **coverage**: characters of the lines questions own (stem, options, answer line, printed
  explanation) plus the answer-key lines, over the characters of all text lines. Questions here
  are the strong ones plus optionless ones with a cue (an essay without a key line asks
  something too; it just is not evidence on its own). A key line counts when it answers such a
  question or names option labels (a numbered heading read as a key entry does not). Each part
  is capped at a few lines: ``segment`` lets a stem / last option / explanation run on to
  the next numbered line, which in a book can swallow the body text after an exercise.
- **page share** (reported, not decisive): pages where such a question starts or the answer
  key is printed, over pages with text.

Rule (``CLASSIFIER_VERSION`` 1; calibrate with ``eval/classify_pdfs.py`` on local PDFs):

- fewer than ``MIN_STRONG_QUESTIONS`` strong questions -> ``book``;
- coverage >= ``PAPER_COVERAGE`` -> ``question_paper``;
- otherwise -> ``mixed``.

Confidence is ``high`` when the evidence is unambiguous for the decided kind: a book without any
strong question; a paper with coverage >= ``HIGH_PAPER_COVERAGE``; a mixed document whose strong
questions are mostly answered (>= half) with few numbering gaps (<= 20%). The worker starts an
extraction automatically only for a ``question_paper`` or a ``high`` ``mixed`` document; a ``low``
``mixed`` one is labelled but waits for the user (``문제 추출``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import replace
from itertools import pairwise
from typing import Annotated, Literal

from pydantic import Field

from book_core.contracts import Block, BlockType, CoreModel
from book_core.extractor.segment import (
    _QUESTION_START,
    AnswerKeyEntry,
    RawQuestion,
    SourceLine,
    segment,
)
from book_core.question import answer_option_keys, canonical_key

CLASSIFIER_VERSION = "book-core-content-classifier/1"

ContentKind = Literal["book", "question_paper", "mixed"]
Confidence = Literal["high", "low"]

MIN_STRONG_QUESTIONS = 3
PAPER_COVERAGE = 0.6
HIGH_PAPER_COVERAGE = 0.75
HIGH_MIXED_ANSWERED = 0.5
HIGH_MIXED_MAX_GAPS = 0.2

# Lines a question part may own for the coverage (see module docstring).
_STEM_LINES = 10
_OPTION_LINES = 3
_EXPLANATION_LINES = 20

_CUE = re.compile(
    r"[?\uff1f]|시오|하라|것은|고르|골라|\(\s*\)|_{3,}|"
    r"\b(?:which|what|choose|select|true|false)\b",
    re.IGNORECASE,
)
_SEQUENCES = ("123456789", "ABCDE")

Key = dict[int, list[str]]


class ContentDetection(CoreModel):
    """What ``classify_content`` found. Numbers only: safe to store and log."""

    kind: ContentKind
    confidence: Confidence
    strong_questions: Annotated[int, Field(ge=0)]
    coverage: Annotated[float, Field(ge=0, le=1)]
    page_share: Annotated[float, Field(ge=0, le=1)]
    answered_ratio: Annotated[float, Field(ge=0, le=1)]
    gap_ratio: Annotated[float, Field(ge=0)]
    version: str = CLASSIFIER_VERSION


def _sequential_options(question: RawQuestion) -> int:
    """How many options are labelled in sequence from the first label (``① ② ③`` -> 3)."""
    keys = [canonical_key(option.label) for option in question.options]
    for sequence in _SEQUENCES:
        if keys and keys[0] == sequence[0]:
            run = 0
            for key, expected in zip(keys, sequence, strict=False):
                if key != expected:
                    break
                run += 1
            return run
    return 0


def _is_strong(question: RawQuestion, key: Mapping[int, list[str]]) -> bool:
    """Asks something *and* is answerable, or prints its answer (module docstring)."""
    if question.answer:
        return True
    options = _sequential_options(question) >= 2
    cue = _CUE.search(question.stem) is not None
    entries = key.get(question.number, [])
    if options:
        # A key entry backs options only when it names option labels (``②``, ``A, C``).
        return cue or any(answer_option_keys(text) is not None for text in entries)
    return cue and bool(entries)


def _asks(question: RawQuestion) -> bool:
    return _CUE.search(question.stem) is not None


def _line_key(line: SourceLine) -> tuple[int, str]:
    return line.block_index, line.text


def _owned_lines(question: RawQuestion) -> Iterable[SourceLine]:
    yield from question.stem_lines[:_STEM_LINES]
    for option in question.options:
        yield from option.lines[:_OPTION_LINES]
    for entry in question.answer:
        yield entry.line
    yield from question.explanation_lines[:_EXPLANATION_LINES]


def _text_lines(blocks: Sequence[Block]) -> list[tuple[int, str, int]]:
    """``(block index, line, page)`` of every printed text line (tables as their cell text)."""
    out = []
    for index, block in enumerate(blocks):
        if block.type in (BlockType.TEXT, BlockType.HEADING, BlockType.FORMULA, BlockType.TABLE):
            page = block.locations[0].page
            out += [(index, line.strip(), page) for line in block.text.split("\n") if line.strip()]
    return out


def _gaps(numbers: Sequence[int]) -> int:
    """Skips in the printed numbering (``1 2 4`` -> 1); a restart at 1 (a new chapter or
    set) is not a gap."""
    return sum(1 for prev, nxt in pairwise(numbers) if nxt != prev + 1 and nxt != 1)


def _groups(blocks: Sequence[Block]) -> list[tuple[int, Sequence[Block]]]:
    """``(offset, blocks)`` runs that start at each top-level heading (that is not itself a
    numbered question line). ``segment`` reads a repeated number with a short body as the start
    of an answer key and stays in it, so a book whose numbered headings restart in every chapter
    (``1. 개요``) would hide the exercises of all later chapters; numbering restarts per chapter,
    so each chapter is segmented on its own."""
    levels = [b.heading_level or 1 for b in blocks if b.type is BlockType.HEADING]
    if not levels:
        return [(0, blocks)]
    top = min(levels)
    starts = [0] + [
        i
        for i, b in enumerate(blocks)
        if i
        and b.type is BlockType.HEADING
        and (b.heading_level or 1) == top
        and _QUESTION_START.match(b.text) is None
    ]
    return [(a, blocks[a:b]) for a, b in zip(starts, [*starts[1:], len(blocks)], strict=True)]


def _segment(blocks: Sequence[Block]) -> tuple[list[RawQuestion], list[AnswerKeyEntry], Key]:
    """Questions and answer-key entries of every group, block indices made document-wide.

    A question's key is its own group's answer key, else (an answer section printed as its own
    chapter, ``정답 및 해설``) the entries of the groups that hold no question."""
    found: list[tuple[list[RawQuestion], list[AnswerKeyEntry]]] = []
    for offset, group in _groups(blocks):
        seg = segment(group)
        for question in seg.questions:
            question.stem_lines = [_shift(line, offset) for line in question.stem_lines]
            question.explanation_lines = [_shift(ln, offset) for ln in question.explanation_lines]
            for option in question.options:
                option.lines = [_shift(line, offset) for line in option.lines]
            question.answer = [_shift_entry(e, offset) for e in question.answer]
        found.append((seg.questions, [_shift_entry(e, offset) for e in seg.answer_key]))
    shared: Key = {}
    for questions, entries in found:
        if not questions:
            for entry in entries:
                shared.setdefault(entry.number, []).append(entry.text)
    all_questions: list[RawQuestion] = []
    all_entries: list[AnswerKeyEntry] = []
    keys: Key = {}
    for questions, entries in found:
        own: Key = {}
        for entry in entries:
            own.setdefault(entry.number, []).append(entry.text)
        for question in questions:
            keys[id(question)] = own.get(question.number) or shared.get(question.number, [])
        all_questions += questions
        all_entries += entries
    return all_questions, all_entries, keys


def _shift(line: SourceLine, offset: int) -> SourceLine:
    return replace(line, block_index=line.block_index + offset)


def _shift_entry(entry: AnswerKeyEntry, offset: int) -> AnswerKeyEntry:
    return replace(entry, line=_shift(entry.line, offset))


def classify_content(blocks: Sequence[Block]) -> ContentDetection:
    questions, entries, keys = _segment(blocks)
    strong = [q for q in questions if _is_strong(q, {q.number: keys[id(q)]})]
    strong_ids = {id(q) for q in strong}
    # Optionless questions that ask something (essays, short answers without a key) are not
    # evidence on their own, but they are question text once the strong ones decided that.
    asked = [q for q in questions if id(q) in strong_ids or _asks(q)]
    asked_numbers = {q.number for q in asked}

    lines = _text_lines(blocks)
    total = sum(len(text) for _, text, _ in lines)
    owned: dict[tuple[int, str], int] = {}
    for question in asked:
        for line in _owned_lines(question):
            owned[_line_key(line)] = len(line.text.strip())
    # Answer-key lines are question text when they answer a question or name option labels; a
    # repeated numbered heading read as a key entry (``1. 개요``) is not.
    key_lines = [
        e for e in entries if e.number in asked_numbers or answer_option_keys(e.text) is not None
    ]
    for entry in key_lines:
        owned[_line_key(entry.line)] = len(entry.line.text.strip())
    coverage = min(1.0, sum(owned.values()) / total) if total else 0.0

    text_pages = {page for _, _, page in lines}
    question_pages = {q.stem_lines[0].block.locations[0].page for q in asked} | {
        e.line.block.locations[0].page for e in key_lines
    }
    page_share = len(question_pages & text_pages) / len(text_pages) if text_pages else 0.0
    answered = sum(1 for q in strong if q.answer or keys[id(q)])
    answered_ratio = answered / len(strong) if strong else 0.0
    gap_ratio = _gaps([q.number for q in strong]) / len(strong) if strong else 0.0

    kind: ContentKind
    if len(strong) < MIN_STRONG_QUESTIONS:
        kind = "book"
        high = not strong
    elif coverage >= PAPER_COVERAGE:
        kind = "question_paper"
        high = coverage >= HIGH_PAPER_COVERAGE
    else:
        kind = "mixed"
        high = answered_ratio >= HIGH_MIXED_ANSWERED and gap_ratio <= HIGH_MIXED_MAX_GAPS
    return ContentDetection(
        kind=kind,
        confidence="high" if high else "low",
        strong_questions=len(strong),
        coverage=round(coverage, 4),
        page_share=round(page_share, 4),
        answered_ratio=round(answered_ratio, 4),
        gap_ratio=round(gap_ratio, 4),
    )
