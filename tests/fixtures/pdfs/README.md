# Synthetic PDF fixtures (M1.1)

Small, copyright-free PDFs with machine-readable ground truth for parser/structure/chunker tests
(M1.2–M1.4), retrieval evaluation (M2.6), question PDF import (M4.3/M4.4) and E2E uploads.
All text was written for this repository; the tables hold illustrative numbers only.

| File | Content |
|---|---|
| `book-ko.pdf` | Korean book excerpt "물의 순환과 정수 처리", 4 pages: title + TOC page, 2 chapters × 2 sections, figure placeholder + caption, table, a paragraph split across pages 2→3, running header and page numbers, source note |
| `book-en.pdf` | English counterpart "The Water Cycle and Water Treatment" with the same section ids |
| `questions-ko.pdf` | Korean question paper, 3 pages: 8 questions (MCQ single/multi, ①–④ and A–D options, short answer, essay, one figure question) and an answer key on the last page that covers only questions 1, 2, 4, 5, 8 |
| `*.truth.json` | Ground truth per PDF (schema below) |
| `retrieval-seed.json` | KO↔EN query → relevant section judgments over both books |
| `fonts/` | Noto Sans KR subsets embedded in the PDFs + `OFL.txt` |

Everything except `fonts/` is generated; never edit it by hand.

```bash
uv run python packages/core/scripts/make_fixture_pdfs.py          # regenerate (byte-identical)
uv run python packages/core/scripts/make_fixture_pdfs.py --check  # exit 1 if stale
uv run pytest packages/core/tests/test_fixture_pdfs.py           # determinism, extraction, truth
```

Content lives in `packages/core/scripts/fixture_content.py`, the truth schema in
`packages/core/scripts/fixture_truth.py` (pydantic models, the authoritative schema). Output is
deterministic: reportlab invariant mode (fixed dates and document id), exact dev-dependency pins
(`reportlab`, `fonttools`, `pypdf` in the root `dev` group), committed fonts.

## Fonts

`fonts/NotoSansKR-FixtureSubset-{Regular,Bold}.ttf` are subsets of Google Fonts "Noto Sans KR"
static `NotoSansKR-Regular.ttf` / `NotoSansKR-Bold.ttf` (SIL Open Font License 1.1, see
`fonts/OFL.txt`; the reserved font name "Source" is not used), limited to printable ASCII plus the
characters the fixtures draw, renamed "Noto Sans KR Fixture Subset". They are embedded as
TrueType subsets with `ToUnicode` maps, so Korean text extracts as real Unicode. The generator
refuses to draw a character the subsets lack; after adding new characters to the content, rebuild
the fonts from the original family and regenerate:

```bash
uv run python packages/core/scripts/make_fixture_font.py \
  --regular /path/to/NotoSansKR-Regular.ttf --bold /path/to/NotoSansKR-Bold.ttf
uv run python packages/core/scripts/make_fixture_pdfs.py
```

## Truth schema (`schema_version: 1`)

Conventions: coordinates are PDF points with a **top-left origin** (`BBox` from
`book_core.contracts`), pages are 1-based, texts are whitespace-normalized (single spaces, NFC).
Every file has `fixture_id`, `file`, `language`, `sha256` (of the PDF), `synthetic: true`,
`title`, `page_count` and `pages[]` (`page`, `width`, `height`, `noise[]`). `noise` lists running
headers and page numbers (`kind`, `text`, `bbox`) that a parser should drop.

**Books** (`kind: "book"`)

- `toc_page`, `toc[]`: printed TOC lines (`section_id`, `title`, `level`, `page`, `bbox`).
- `sections[]`: `id`, `title`, `level` (1 = chapter, 2 = section), `parent_id`, `page` of the
  heading. Ids are shared between `book-ko` and `book-en`.
- `blocks[]` (reading order, body pages only): `id`, `type` (`heading|text|table|image`, the
  core `BlockType`), `text`, `section_id`, `parts[]` (`page`, `bbox`, `text` of the block on that
  page), `table` (`rows`, `header_rows`) for tables, `caption_block_id` for images. Image blocks
  have empty text; captions are separate text blocks. Table `text` is rows as `a | b | c` lines.
- `cross_page_block_ids`: blocks whose `parts` span pages (their part texts join with a space
  to the block text). `source_note_block_id`: the synthetic-source paragraph.
- `BookTruth.to_parsed_document()` returns the ideal `ParsedDocument` for parser tests.

**Questions** (`kind: "questions"`)

- `instructions`, `answer_key_page`, `answer_key_lines` (as printed, e.g. `2. A, C, D`).
- `questions[]`: `number`, `question_type` (`MCQ|SHORT_ANSWER|ESSAY`), `multi_select`, `stem`
  (without the number), `option_style` (`circled|latin`), `options[]` (`label` as printed
  without the trailing period, `text`), `answer`, `page`, `bbox`, `figure` (`caption`, `page`,
  `bbox`, `caption_bbox`).
- `answer` is `null` when the answer key does not cover the question — an importer must
  produce `null` too, never an invented answer (QIMPORT-01-AC02). Otherwise exactly one of
  `correct_option_labels` (MCQ) or `accepted_answers` (text) is set.

**Retrieval seed** (`retrieval-seed.json`): `queries[]` with `id`, `language`, `query` and
`relevant[]` (`fixture_id`, `section_id`, `grade` 1–3). Every query is judged against both books,
so KO queries test KO→EN retrieval and vice versa. It lives next to the PDFs because it is
derived from their section ids; M2.6 should convert or reference it from `eval/datasets/`
rather than copy it.
