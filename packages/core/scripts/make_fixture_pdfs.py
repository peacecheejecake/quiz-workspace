"""Generate the synthetic PDF fixtures and their ground truth (M1.1).

Writes ``book-ko.pdf``, ``book-en.pdf``, ``questions-ko.pdf``, one ``*.truth.json`` per PDF and
``retrieval-seed.json`` into ``tests/fixtures/pdfs/``. Output is byte-for-byte deterministic
(reportlab invariant mode: fixed creation date and document id, no randomness)::

    uv run python packages/core/scripts/make_fixture_pdfs.py            # regenerate in place
    uv run python packages/core/scripts/make_fixture_pdfs.py --check    # fail if stale

Layout is done by hand on a reportlab canvas so every block's page and bbox is known exactly.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from book_core.contracts import BBox, BlockType, QuestionType
from fixture_content import (
    BOOK_EN,
    BOOK_KO,
    QUESTIONS_KO,
    RETRIEVAL_SEED,
    BodyItem,
    BookContent,
    Figure,
    Para,
    QuestionContent,
    QuestionPaperContent,
    Table,
)
from fixture_truth import (
    BookTruth,
    NoiseItem,
    NoiseKind,
    QuestionsTruth,
    RelevantSection,
    RetrievalQuery,
    RetrievalSeed,
    TocLine,
    TruthAnswer,
    TruthBlock,
    TruthFigure,
    TruthOption,
    TruthPage,
    TruthPart,
    TruthQuestion,
    TruthSection,
    TruthTable,
)
from make_fixture_font import BOLD_NAME, FONT_DIR, REGULAR_NAME
from pydantic import BaseModel
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

OUT_DIR = FONT_DIR.parent
REGULAR = "FixtureSans"
BOLD = "FixtureSans-Bold"

PAGE_W, PAGE_H = A4
LEFT, RIGHT = 64.0, PAGE_W - 64.0
TOP, BOTTOM = 84.0, PAGE_H - 72.0
HEADER_BASELINE = 44.0
FOOTER_BASELINE = PAGE_H - 36.0

BODY_SIZE, BODY_LEADING = 11.5, 19.0
NOISE_SIZE = 8.5
PARA_GAP = 8.0


def _register_fonts() -> None:
    if REGULAR in pdfmetrics.getRegisteredFontNames():
        return
    pdfmetrics.registerFont(TTFont(REGULAR, str(FONT_DIR / REGULAR_NAME)))
    pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / BOLD_NAME)))


def _check_glyphs(text: str, font_name: str) -> None:
    """Fail loudly instead of drawing tofu when content gains characters a subset lacks."""
    font = pdfmetrics.getFont(font_name)
    if not isinstance(font, TTFont):
        raise TypeError(f"{font_name} is not a TrueType font")
    missing = sorted({ch for ch in text if ord(ch) not in font.face.charToGlyph})
    if missing:
        raise SystemExit(
            f"font {font_name} lacks {''.join(missing)!r}; re-run make_fixture_font.py"
        )


def _width(text: str, font: str, size: float) -> float:
    return float(pdfmetrics.stringWidth(text, font, size))


def _ascent_descent(font: str, size: float) -> tuple[float, float]:
    ascent, descent = pdfmetrics.getAscentDescent(font, size)
    return float(ascent), float(-descent)


def _wrap(text: str, font: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split(" "):
        candidate = f"{current} {word}" if current else word
        if current and _width(candidate, font, size) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _r(value: float) -> float:
    return round(value, 2)


def _bbox(x0: float, y0: float, x1: float, y1: float) -> BBox:
    return BBox(x0=_r(x0), y0=_r(y0), x1=_r(x1), y1=_r(y1))


@dataclass(frozen=True)
class TextOp:
    x: float
    baseline: float  # top-left origin
    text: str
    font: str
    size: float
    gray: float = 0.0


@dataclass(frozen=True)
class RectOp:
    x0: float
    y0: float
    x1: float
    y1: float
    cross: bool = False


@dataclass(frozen=True)
class LineOp:
    x0: float
    y0: float
    x1: float
    y1: float


Op = TextOp | RectOp | LineOp


@dataclass
class Placed:
    page: int
    bbox: BBox
    text: str


@dataclass
class Flow:
    """Top-to-bottom flow layout over A4 pages with a fixed body area."""

    first_page: int
    pages: list[list[Op]] = field(default_factory=list)
    y: float = TOP

    def __post_init__(self) -> None:
        self.pages.append([])

    @property
    def page(self) -> int:
        return self.first_page + len(self.pages) - 1

    def new_page(self) -> None:
        self.pages.append([])
        self.y = TOP

    def ensure(self, height: float) -> None:
        if self.y + height > BOTTOM and self.y > TOP:
            self.new_page()

    def add(self, op: Op) -> None:
        self.pages[-1].append(op)

    def text_lines(
        self,
        text: str,
        *,
        font: str = REGULAR,
        size: float = BODY_SIZE,
        leading: float = BODY_LEADING,
        indent: float = 0.0,
        hanging: str | None = None,
    ) -> list[Placed]:
        """Wrap and place a paragraph, splitting it across pages when needed."""
        x = LEFT + indent
        lines = _wrap(text, font, size, RIGHT - x)
        ascent, descent = _ascent_descent(font, size)
        parts: list[Placed] = []
        current: list[tuple[str, float]] = []  # (line, top)
        hanging_w = _width(hanging + " ", font, size) if hanging else 0.0

        def flush() -> None:
            if not current:
                return
            width = max(_width(line, font, size) for line, _ in current)
            top = current[0][1]
            bottom = current[-1][1] + ascent + descent
            x0 = x - (hanging_w if hanging and not parts else 0.0)
            text_part = " ".join(line for line, _ in current)
            parts.append(Placed(self.page, _bbox(x0, top, x + width, bottom), text_part))
            current.clear()

        for i, line in enumerate(lines):
            if self.y + ascent + descent > BOTTOM:
                flush()
                self.new_page()
            if i == 0 and hanging:
                self.add(TextOp(x - hanging_w, self.y + ascent, hanging, font, size))
            self.add(TextOp(x, self.y + ascent, line, font, size))
            current.append((line, self.y))
            self.y += leading
        flush()
        return parts


def _draw(canvas: Canvas, ops: Iterable[Op]) -> None:
    for op in ops:
        if isinstance(op, TextOp):
            _check_glyphs(op.text, op.font)
            canvas.setFillGray(op.gray)
            canvas.setFont(op.font, op.size)
            canvas.drawString(op.x, PAGE_H - op.baseline, op.text)
        elif isinstance(op, RectOp):
            canvas.setStrokeGray(0.45)
            canvas.setLineWidth(0.8)
            canvas.rect(op.x0, PAGE_H - op.y1, op.x1 - op.x0, op.y1 - op.y0, stroke=1, fill=0)
            if op.cross:
                canvas.line(op.x0, PAGE_H - op.y0, op.x1, PAGE_H - op.y1)
                canvas.line(op.x0, PAGE_H - op.y1, op.x1, PAGE_H - op.y0)
        else:
            canvas.setStrokeGray(0.3)
            canvas.setLineWidth(0.6)
            canvas.line(op.x0, PAGE_H - op.y0, op.x1, PAGE_H - op.y1)


def _furniture(page: int, header: str) -> tuple[list[Op], tuple[NoiseItem, ...]]:
    """Running header + rule and centered page number: noise a parser should remove."""
    ascent, descent = _ascent_descent(REGULAR, NOISE_SIZE)
    number = f"- {page} -"
    header_w = _width(header, REGULAR, NOISE_SIZE)
    number_w = _width(number, REGULAR, NOISE_SIZE)
    number_x = (PAGE_W - number_w) / 2
    ops: list[Op] = [
        TextOp(LEFT, HEADER_BASELINE, header, REGULAR, NOISE_SIZE, gray=0.35),
        LineOp(LEFT, HEADER_BASELINE + 8, RIGHT, HEADER_BASELINE + 8),
        TextOp(number_x, FOOTER_BASELINE, number, REGULAR, NOISE_SIZE, gray=0.35),
    ]
    noise = (
        NoiseItem(
            kind=NoiseKind.RUNNING_HEADER,
            text=header,
            bbox=_bbox(LEFT, HEADER_BASELINE - ascent, LEFT + header_w, HEADER_BASELINE + descent),
        ),
        NoiseItem(
            kind=NoiseKind.PAGE_NUMBER,
            text=number,
            bbox=_bbox(
                number_x,
                FOOTER_BASELINE - ascent,
                number_x + number_w,
                FOOTER_BASELINE + descent,
            ),
        ),
    )
    return ops, noise


def _with_furniture(flow: Flow, header: str) -> tuple[list[list[Op]], list[TruthPage]]:
    pages: list[list[Op]] = []
    truth: list[TruthPage] = []
    for offset, ops in enumerate(flow.pages):
        page_no = flow.first_page + offset
        furniture, noise = _furniture(page_no, header)
        pages.append(furniture + ops)
        truth.append(TruthPage(page=page_no, width=_r(PAGE_W), height=_r(PAGE_H), noise=noise))
    return pages, truth


def _render(pages: list[list[Op]], *, title: str, subject: str, language: str) -> bytes:
    buf = io.BytesIO()
    canvas = Canvas(buf, pagesize=A4, invariant=1, pageCompression=1, lang=language)
    canvas.setTitle(title)
    canvas.setAuthor("quiz-workspace test fixtures")
    canvas.setSubject(subject)
    canvas.setCreator("packages/core/scripts/make_fixture_pdfs.py")
    canvas.setProducer("reportlab (invariant mode)")
    canvas.setKeywords("synthetic, test fixture")
    for ops in pages:
        _draw(canvas, ops)
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------------------------
# Books


def _parts(placed: list[Placed]) -> tuple[TruthPart, ...]:
    return tuple(TruthPart(page=p.page, bbox=p.bbox, text=p.text) for p in placed)


def _layout_item(flow: Flow, item: BodyItem, section_id: str) -> list[TruthBlock]:
    if isinstance(item, Para):
        placed = flow.text_lines(item.text)
        flow.y += PARA_GAP
        return [
            TruthBlock(
                id=item.id,
                type=BlockType.TEXT,
                text=item.text,
                section_id=section_id,
                parts=_parts(placed),
            )
        ]
    if isinstance(item, Figure):
        caption_h = BODY_LEADING
        flow.ensure(item.height + 8 + caption_h)
        x0, x1 = LEFT + 40, RIGHT - 40
        y0, y1 = flow.y, flow.y + item.height
        flow.add(RectOp(x0, y0, x1, y1, cross=True))
        figure = TruthBlock(
            id=item.id,
            type=BlockType.IMAGE,
            text="",
            section_id=section_id,
            parts=(TruthPart(page=flow.page, bbox=_bbox(x0, y0, x1, y1), text=""),),
            caption_block_id=item.caption_id,
        )
        flow.y = y1 + 8
        caption = flow.text_lines(item.caption, size=10.0, leading=16.0, indent=40.0)
        flow.y += PARA_GAP
        return [
            figure,
            TruthBlock(
                id=item.caption_id,
                type=BlockType.TEXT,
                text=item.caption,
                section_id=section_id,
                parts=_parts(caption),
            ),
        ]
    return _layout_table(flow, item, section_id)


def _layout_table(flow: Flow, table: Table, section_id: str) -> list[TruthBlock]:
    row_h, size = 22.0, 10.0
    ncols = len(table.rows[0])
    col_w = (RIGHT - LEFT) / ncols
    flow.ensure(BODY_LEADING + row_h * len(table.rows) + PARA_GAP)
    caption = flow.text_lines(table.caption, size=10.0, leading=16.0)
    flow.y += 4
    top = flow.y
    ascent, descent = _ascent_descent(REGULAR, size)
    for r, row in enumerate(table.rows):
        y = top + r * row_h
        font = BOLD if r < table.header_rows else REGULAR
        baseline = y + (row_h + ascent - descent) / 2
        for c, cell in enumerate(row):
            flow.add(TextOp(LEFT + c * col_w + 6, baseline, cell, font, size))
    bottom = top + row_h * len(table.rows)
    for r in range(len(table.rows) + 1):
        flow.add(LineOp(LEFT, top + r * row_h, RIGHT, top + r * row_h))
    for c in range(ncols + 1):
        flow.add(LineOp(LEFT + c * col_w, top, LEFT + c * col_w, bottom))
    flow.y = bottom + PARA_GAP + 4
    text = "\n".join(" | ".join(row) for row in table.rows)
    return [
        TruthBlock(
            id=table.caption_id,
            type=BlockType.TEXT,
            text=table.caption,
            section_id=section_id,
            parts=_parts(caption),
        ),
        TruthBlock(
            id=table.id,
            type=BlockType.TABLE,
            text=text,
            section_id=section_id,
            parts=(TruthPart(page=flow.page, bbox=_bbox(LEFT, top, RIGHT, bottom), text=text),),
            table=TruthTable(rows=table.rows, header_rows=table.header_rows),
        ),
    ]


def _heading(flow: Flow, block_id: str, title: str, size: float, section_id: str) -> TruthBlock:
    flow.ensure(size * 2 + BODY_LEADING * 2)
    if flow.y > TOP:
        flow.y += size * 0.6
    placed = flow.text_lines(title, font=BOLD, size=size, leading=size * 1.5)
    flow.y += 4
    return TruthBlock(
        id=block_id, type=BlockType.HEADING, text=title, section_id=section_id, parts=_parts(placed)
    )


def build_book(content: BookContent) -> tuple[bytes, BookTruth]:
    flow = Flow(first_page=2)
    sections: list[TruthSection] = []
    blocks: list[TruthBlock] = []
    for index, chapter in enumerate(content.chapters):
        if index > 0:
            flow.new_page()
        heading = _heading(flow, f"{chapter.id}-heading", chapter.title, 18.0, chapter.id)
        sections.append(
            TruthSection(id=chapter.id, title=chapter.title, level=1, page=heading.parts[0].page)
        )
        blocks.append(heading)
        for item in chapter.intro:
            blocks += _layout_item(flow, item, chapter.id)
        for section in chapter.sections:
            heading = _heading(flow, f"{section.id}-heading", section.title, 13.5, section.id)
            sections.append(
                TruthSection(
                    id=section.id,
                    title=section.title,
                    level=2,
                    parent_id=chapter.id,
                    page=heading.parts[0].page,
                )
            )
            blocks.append(heading)
            for item in section.body:
                blocks += _layout_item(flow, item, section.id)
    flow.y += PARA_GAP
    note_section = content.chapters[-1].sections[-1].id
    blocks += _layout_item(flow, content.source_note, note_section)

    # Page 1: title, subtitle and the table of contents (no running header/page number).
    cover = Flow(first_page=1)
    cover.y = 150.0
    cover.text_lines(content.title, font=BOLD, size=22.0, leading=30.0)
    cover.text_lines(content.subtitle, size=11.0, leading=18.0)
    cover.y += 40
    cover.text_lines(content.toc_heading, font=BOLD, size=14.0, leading=24.0)
    cover.y += 6
    toc: list[TocLine] = []
    size = 11.5
    ascent, descent = _ascent_descent(REGULAR, size)
    dot_w = _width(".", REGULAR, size)
    for entry in sections:
        x = LEFT + (0.0 if entry.level == 1 else 18.0)
        baseline = cover.y + ascent
        page_label = str(entry.page)
        title_w = _width(entry.title, REGULAR, size)
        page_label_w = _width(page_label, REGULAR, size)
        dots = "." * int((RIGHT - page_label_w - 8 - (x + title_w + 8)) / dot_w)
        cover.add(TextOp(x, baseline, entry.title, REGULAR, size))
        cover.add(TextOp(x + title_w + 8, baseline, dots, REGULAR, size, gray=0.5))
        cover.add(TextOp(RIGHT - page_label_w, baseline, page_label, REGULAR, size))
        toc.append(
            TocLine(
                section_id=entry.id,
                title=entry.title,
                level=entry.level,
                page=entry.page,
                bbox=_bbox(x, cover.y, RIGHT, cover.y + ascent + descent),
            )
        )
        cover.y += 22.0
    if len(cover.pages) != 1:
        raise SystemExit("table of contents overflowed page 1")

    body_pages, body_truth = _with_furniture(flow, content.running_header)
    pages = [cover.pages[0], *body_pages]
    truth_pages = [TruthPage(page=1, width=_r(PAGE_W), height=_r(PAGE_H)), *body_truth]

    pdf = _render(pages, title=content.title, subject=content.subtitle, language=content.language)
    cross = tuple(b.id for b in blocks if len({p.page for p in b.parts}) > 1)
    truth = BookTruth(
        fixture_id=content.fixture_id,
        file=f"{content.fixture_id}.pdf",
        language=content.language,
        sha256=_sha(pdf),
        title=content.title,
        page_count=len(pages),
        pages=tuple(truth_pages),
        toc_page=1,
        toc=tuple(toc),
        sections=tuple(sections),
        blocks=tuple(blocks),
        cross_page_block_ids=cross,
        source_note_block_id=content.source_note.id,
    )
    return pdf, truth


# --------------------------------------------------------------------------------------------
# Question paper


def _question_height(q: QuestionContent) -> float:
    lines = len(_wrap(q.stem, REGULAR, BODY_SIZE, RIGHT - LEFT - 20))
    height = lines * BODY_LEADING + 8
    height += sum(
        len(_wrap(o, REGULAR, BODY_SIZE, RIGHT - LEFT - 52)) * BODY_LEADING for o in q.options
    )
    if q.figure_caption:
        height += 110 + 8 + 16 + 8
    if q.kind == "ESSAY":
        height += 70
    return height + 16


def _layout_question(flow: Flow, q: QuestionContent) -> TruthQuestion:
    flow.ensure(_question_height(q))
    top = flow.y
    stem = flow.text_lines(q.stem, indent=20.0, hanging=f"{q.number}.")
    flow.y += 4
    figure: TruthFigure | None = None
    if q.figure_caption:
        x0, x1 = LEFT + 60, LEFT + 300
        y0, y1 = flow.y, flow.y + 110
        flow.add(RectOp(x0, y0, x1, y1, cross=True))
        flow.y = y1 + 8
        caption = flow.text_lines(q.figure_caption, size=10.0, leading=16.0, indent=60.0)
        flow.y += 8
        figure = TruthFigure(
            caption=q.figure_caption,
            page=flow.page,
            bbox=_bbox(x0, y0, x1, y1),
            caption_bbox=caption[0].bbox,
        )
    right = max(p.bbox.x1 for p in stem)
    if figure is not None:
        right = max(right, figure.bbox.x1, figure.caption_bbox.x1)
    options: list[TruthOption] = []
    for label, option in zip(q.labels, q.options, strict=True):
        marker = label if q.option_style == "circled" else f"{label}."
        placed = flow.text_lines(option, indent=52.0, hanging=marker)
        right = max(right, *(p.bbox.x1 for p in placed))
        options.append(TruthOption(label=label, text=option))
    bottom = flow.y - (BODY_LEADING - sum(_ascent_descent(REGULAR, BODY_SIZE)))
    if q.kind == "ESSAY":
        # Empty answer box below the stem.
        flow.y += 4
        flow.add(RectOp(LEFT + 20, flow.y, RIGHT, flow.y + 62))
        bottom = flow.y + 62
        flow.y += 66
        right = RIGHT
    flow.y += 16
    answer: TruthAnswer | None = None
    if q.key_labels is not None:
        answer = TruthAnswer(correct_option_labels=q.key_labels)
    elif q.key_text is not None:
        answer = TruthAnswer(accepted_answers=(q.key_text,))
    return TruthQuestion(
        number=q.number,
        question_type=QuestionType(q.kind),
        multi_select=q.multi_select,
        stem=q.stem,
        option_style=q.option_style,
        options=tuple(options),
        answer=answer,
        page=stem[0].page,
        bbox=_bbox(LEFT, top, right, bottom),
        figure=figure,
    )


def _key_line(q: QuestionContent) -> str | None:
    if q.key_labels is not None:
        return f"{q.number}. {', '.join(q.key_labels)}"
    if q.key_text is not None:
        return f"{q.number}. {q.key_text}"
    return None


def build_questions(content: QuestionPaperContent) -> tuple[bytes, QuestionsTruth]:
    flow = Flow(first_page=1)
    flow.text_lines(content.title, font=BOLD, size=15.0, leading=24.0)
    flow.text_lines(content.instructions, size=10.0, leading=16.0)
    flow.y += 14
    questions = [_layout_question(flow, q) for q in content.questions]

    flow.new_page()
    key_page = flow.page
    flow.text_lines(content.answer_key_heading, font=BOLD, size=14.0, leading=24.0)
    flow.y += 4
    key_lines = [line for q in content.questions if (line := _key_line(q)) is not None]
    for line in key_lines:
        flow.text_lines(line)

    pages, truth_pages = _with_furniture(flow, content.running_header)
    pdf = _render(
        pages, title=content.title, subject=content.instructions, language=content.language
    )
    truth = QuestionsTruth(
        fixture_id=content.fixture_id,
        file=f"{content.fixture_id}.pdf",
        language=content.language,
        sha256=_sha(pdf),
        title=content.title,
        page_count=len(pages),
        pages=tuple(truth_pages),
        instructions=content.instructions,
        answer_key_page=key_page,
        answer_key_lines=tuple(key_lines),
        questions=tuple(questions),
    )
    return pdf, truth


def build_retrieval_seed() -> RetrievalSeed:
    return RetrievalSeed(
        queries=tuple(
            RetrievalQuery(
                id=q.id,
                language=q.language,
                query=q.query,
                relevant=tuple(
                    RelevantSection(fixture_id=f, section_id=s, grade=g) for f, s, g in q.relevant
                ),
            )
            for q in RETRIEVAL_SEED
        )
    )


def _json(model: BaseModel) -> bytes:
    data = model.model_dump(mode="json")
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()


def build_all() -> dict[str, bytes]:
    """All generated fixture files, keyed by file name relative to ``tests/fixtures/pdfs``."""
    _register_fonts()
    files: dict[str, bytes] = {}
    builders: list[tuple[str, Callable[[], tuple[bytes, BaseModel]]]] = [
        (BOOK_KO.fixture_id, lambda: build_book(BOOK_KO)),
        (BOOK_EN.fixture_id, lambda: build_book(BOOK_EN)),
        (QUESTIONS_KO.fixture_id, lambda: build_questions(QUESTIONS_KO)),
    ]
    for fixture_id, build in builders:
        pdf, truth = build()
        files[f"{fixture_id}.pdf"] = pdf
        files[f"{fixture_id}.truth.json"] = _json(truth)
    files["retrieval-seed.json"] = _json(build_retrieval_seed())
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    parser.add_argument("--check", action="store_true", help="fail if committed files differ")
    args = parser.parse_args()
    files = build_all()
    stale = []
    for name, data in files.items():
        path: Path = args.out / name
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                stale.append(name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"{path}: {len(data)} bytes sha256={_sha(data)}")
    if stale:
        print(f"stale fixtures: {', '.join(stale)}; re-run make_fixture_pdfs.py", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
