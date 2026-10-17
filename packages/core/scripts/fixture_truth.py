"""Ground-truth schema of the synthetic PDF fixtures (M1.1).

``*.truth.json`` files are written by ``make_fixture_pdfs.py`` and validated by these models.
Book truth reuses the core document contracts (``Section``, ``BlockType``, ``BBox``) so parser,
structure and chunker tests (M1.2-M1.4) can compare their output field by field;
``BookTruth.to_parsed_document()`` builds the ``ParsedDocument`` an ideal parser would return.
Coordinates are PDF points with the origin at the page's top-left corner (``BBox``).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, Self

from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    QuestionType,
    Section,
    SourceLocation,
    TableContent,
)
from book_core.contracts.common import (
    CoreModel,
    Identifier,
    LanguageTag,
    NonEmptyText,
    PageNumber,
    Sha256Hex,
    ensure_unique,
)
from pydantic import Field, model_validator

TRUTH_PARSER_VERSION = "fixture-truth/1"


class NoiseKind(StrEnum):
    """Page furniture a parser should drop from the canonical text."""

    RUNNING_HEADER = "running_header"
    PAGE_NUMBER = "page_number"


class NoiseItem(CoreModel):
    kind: NoiseKind
    text: NonEmptyText
    bbox: BBox


class TruthPage(CoreModel):
    page: PageNumber
    width: Annotated[float, Field(gt=0)]
    height: Annotated[float, Field(gt=0)]
    noise: tuple[NoiseItem, ...] = ()


class TruthPart(CoreModel):
    """The portion of a block on one page; ``text`` is whitespace-normalized."""

    page: PageNumber
    bbox: BBox
    text: str


class TruthTable(CoreModel):
    rows: Annotated[tuple[tuple[str, ...], ...], Field(min_length=1)]
    header_rows: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        widths = {len(row) for row in self.rows}
        if len(widths) != 1:
            raise ValueError("table rows must have the same number of cells")
        if self.header_rows > len(self.rows):
            raise ValueError("header_rows exceeds row count")
        return self


class TruthSection(CoreModel):
    """A TOC entry: chapter (level 1) or section (level 2) with the page of its heading."""

    id: Identifier
    title: NonEmptyText
    level: Annotated[int, Field(ge=1)]
    parent_id: Identifier | None = None
    page: PageNumber

    def to_contract(self) -> Section:
        return Section(id=self.id, title=self.title, level=self.level, parent_id=self.parent_id)


class TruthBlock(CoreModel):
    """A body block in reading order.

    ``text`` is whitespace-normalized; for multi-page blocks it equals the parts' texts joined by
    a single space. Image blocks have empty text and link their caption via ``caption_block_id``;
    table blocks carry their cells in ``table`` and ``text`` holds rows as ``a | b | c`` lines.
    """

    id: Identifier
    type: BlockType
    text: str
    section_id: Identifier | None = None
    parts: Annotated[tuple[TruthPart, ...], Field(min_length=1)]
    table: TruthTable | None = None
    caption_block_id: Identifier | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if (self.type is BlockType.TABLE) != (self.table is not None):
            raise ValueError(f"block {self.id!r}: table data iff type is table")
        if self.type is not BlockType.TABLE and len(self.parts) > 1:
            joined = " ".join(p.text for p in self.parts)
            if joined != self.text:
                raise ValueError(f"block {self.id!r}: parts do not join to text")
        pages = [p.page for p in self.parts]
        if pages != sorted(set(pages)):
            raise ValueError(f"block {self.id!r}: parts must be on increasing pages")
        return self

    def to_contract(self, heading_level: int | None = None) -> Block:
        return Block(
            id=self.id,
            type=self.type,
            text=self.text,
            section_id=self.section_id,
            locations=tuple(SourceLocation(page=p.page, bbox=p.bbox) for p in self.parts),
            heading_level=heading_level if self.type is BlockType.HEADING else None,
            table=(
                TableContent(rows=self.table.rows, header_rows=self.table.header_rows)
                if self.table is not None
                else None
            ),
            caption_block_id=self.caption_block_id,
        )


class TocLine(CoreModel):
    """A printed TOC line: ``title`` + dot leader + ``page``."""

    section_id: Identifier
    title: NonEmptyText
    level: Annotated[int, Field(ge=1)]
    page: PageNumber
    bbox: BBox


class _FixtureBase(CoreModel):
    schema_version: Literal[1] = 1
    fixture_id: Identifier
    file: NonEmptyText
    language: LanguageTag
    sha256: Sha256Hex
    synthetic: Literal[True] = True
    title: NonEmptyText
    page_count: Annotated[int, Field(ge=1)]
    pages: tuple[TruthPage, ...]

    def _check_pages(self) -> None:
        if [p.page for p in self.pages] != list(range(1, self.page_count + 1)):
            raise ValueError("pages must list 1..page_count in order")


class BookTruth(_FixtureBase):
    kind: Literal["book"] = "book"
    toc_page: PageNumber
    toc: tuple[TocLine, ...]
    sections: tuple[TruthSection, ...]
    blocks: tuple[TruthBlock, ...]
    cross_page_block_ids: Annotated[tuple[Identifier, ...], Field(min_length=1)]
    source_note_block_id: Identifier

    @model_validator(mode="after")
    def _check(self) -> Self:
        self._check_pages()
        by_id = {b.id: b for b in self.blocks}
        for block_id in self.cross_page_block_ids:
            block = by_id.get(block_id)
            if block is None or len({p.page for p in block.parts}) < 2:
                raise ValueError(f"cross-page block {block_id!r} must exist and span pages")
        for block in self.blocks:
            if block.caption_block_id is not None and block.caption_block_id not in by_id:
                raise ValueError(f"block {block.id!r}: unknown caption block")
        if self.source_note_block_id not in by_id:
            raise ValueError("unknown source note block")
        sections = {s.id: s for s in self.sections}
        if [t.section_id for t in self.toc] != list(sections):
            raise ValueError("toc must list every section in order")
        for line in self.toc:
            section = sections[line.section_id]
            if (line.title, line.level, line.page) != (section.title, section.level, section.page):
                raise ValueError(f"toc line {line.section_id!r} disagrees with its section")
        # Hierarchy, id uniqueness and bbox bounds are the contract's own checks.
        self.to_parsed_document()
        return self

    def to_parsed_document(self) -> ParsedDocument:
        levels = {s.id: s.level for s in self.sections}
        return ParsedDocument(
            source_path=self.file,
            source_sha256=self.sha256,
            parser_version=TRUTH_PARSER_VERSION,
            pages=tuple(PageInfo(page=p.page, width=p.width, height=p.height) for p in self.pages),
            sections=tuple(s.to_contract() for s in self.sections),
            blocks=tuple(
                b.to_contract(levels.get(b.section_id) if b.section_id else None)
                for b in self.blocks
            ),
        )


class TruthOption(CoreModel):
    """``label`` is the printed marker (``①`` or ``A``); grading must use stable ids, the label
    only identifies the option inside this paper."""

    label: NonEmptyText
    text: NonEmptyText


class TruthAnswer(CoreModel):
    correct_option_labels: tuple[NonEmptyText, ...] | None = None
    accepted_answers: tuple[NonEmptyText, ...] | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if (self.correct_option_labels is None) == (self.accepted_answers is None):
            raise ValueError("answer needs exactly one of correct_option_labels/accepted_answers")
        return self


class TruthFigure(CoreModel):
    caption: NonEmptyText
    page: PageNumber
    bbox: BBox
    caption_bbox: BBox


class TruthQuestion(CoreModel):
    number: Annotated[int, Field(ge=1)]
    question_type: QuestionType
    multi_select: bool = False
    stem: NonEmptyText
    option_style: Literal["circled", "latin"] | None = None
    options: tuple[TruthOption, ...] = ()
    answer: TruthAnswer | None
    """``None`` when the paper's answer key does not cover the question (never invented)."""
    page: PageNumber
    bbox: BBox
    figure: TruthFigure | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        labels = [o.label for o in self.options]
        ensure_unique(labels, "option label")
        if self.question_type is QuestionType.MCQ:
            if len(self.options) < 2 or self.option_style is None:
                raise ValueError(f"question {self.number}: MCQ needs options and a style")
        elif self.options or self.option_style is not None or self.multi_select:
            raise ValueError(f"question {self.number}: only MCQ has options")
        if self.answer is not None:
            correct = self.answer.correct_option_labels
            if self.question_type is QuestionType.MCQ:
                if correct is None or not set(correct) <= set(labels):
                    raise ValueError(f"question {self.number}: answer labels must be options")
                if not self.multi_select and len(correct) != 1:
                    raise ValueError(f"question {self.number}: single-select needs one answer")
            elif correct is not None:
                raise ValueError(f"question {self.number}: non-MCQ answers are text")
        if self.figure is not None and self.figure.page != self.page:
            raise ValueError(f"question {self.number}: figure must be on the question's page")
        return self


class QuestionsTruth(_FixtureBase):
    kind: Literal["questions"] = "questions"
    instructions: NonEmptyText
    answer_key_page: PageNumber
    answer_key_lines: tuple[NonEmptyText, ...]
    questions: Annotated[tuple[TruthQuestion, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        self._check_pages()
        numbers = [q.number for q in self.questions]
        if numbers != list(range(1, len(numbers) + 1)):
            raise ValueError("questions must be numbered 1..n in order")
        answered = [q for q in self.questions if q.answer is not None]
        if not answered or len(answered) == len(self.questions):
            raise ValueError("fixture must mix answered and unanswered questions")
        if self.answer_key_page > self.page_count:
            raise ValueError("answer key page out of range")
        return self


class RelevantSection(CoreModel):
    fixture_id: Identifier
    section_id: Identifier
    grade: Annotated[int, Field(ge=1, le=3)]


class RetrievalQuery(CoreModel):
    id: Identifier
    language: LanguageTag
    query: NonEmptyText
    relevant: Annotated[tuple[RelevantSection, ...], Field(min_length=1)]


class RetrievalSeed(CoreModel):
    """KO<->EN query/section judgments over the book fixtures (seed for M2.6 eval datasets)."""

    schema_version: Literal[1] = 1
    synthetic: Literal[True] = True
    queries: Annotated[tuple[RetrievalQuery, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check(self) -> Self:
        ensure_unique([q.id for q in self.queries], "query id")
        return self
