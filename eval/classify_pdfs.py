"""Calibrate the content classifier (UX6-UPLOAD-B) on local PDFs you are allowed to read.

Prints one row of numbers per document (kind, confidence, strong questions, coverage, page
share, answered ratio, gap ratio) and, when expected kinds are given, the confusion counts. No
document text is printed or written, and nothing here is committed: keep real PDFs (and their
parsed JSON) outside the repository.

    # PDFs (real Docling models, slow on first run) or `core parse` output (*.json):
    uv run python eval/classify_pdfs.py ~/pdfs/book.pdf ~/pdfs/exam.parsed.json
    # with the expected kind per file (book | question_paper | mixed):
    uv run python eval/classify_pdfs.py book:~/pdfs/a.pdf question_paper:~/pdfs/b.pdf \\
        mixed:~/pdfs/c.json --json /tmp/classify-report.json

The worker classifies the canonical revision (`build_revision` of the parse), so this script
does the same. Tune the thresholds in `book_core/extractor/classify.py` (and bump
`CLASSIFIER_VERSION`) only with the report of a run like this attached to the change.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from book_core.contracts import ParsedDocument
from book_core.extractor.classify import ContentDetection, classify_content
from book_core.structure import build_revision

KINDS = ("book", "question_paper", "mixed")


def _load(path: Path) -> ParsedDocument:
    if path.suffix.lower() == ".json":
        return ParsedDocument.model_validate_json(path.read_bytes())
    from book_core.parser import ParserOptions
    from book_core.parser.docling_adapter import DoclingParser

    return DoclingParser(ParserOptions()).parse(path, source_path=path.name)


def _detect(path: Path) -> ContentDetection:
    parsed = _load(path)
    revision = build_revision(parsed, document_id="eval", revision_id="eval").revision
    return classify_content(revision.blocks)


def _split(arg: str) -> tuple[str | None, Path]:
    head, sep, tail = arg.partition(":")
    if sep and head in KINDS:
        return head, Path(tail).expanduser()
    return None, Path(arg).expanduser()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("inputs", nargs="+", help="[kind:]path to a PDF or a ParsedDocument JSON")
    parser.add_argument("--json", type=Path, help="Also write the rows as JSON (numbers only).")
    args = parser.parse_args(argv)

    rows = []
    confusion: Counter[tuple[str, str]] = Counter()
    print("expected        got             conf  strong  coverage  pages  answered  gaps  file")
    for index, arg in enumerate(args.inputs, start=1):
        expected, path = _split(arg)
        detection = _detect(path)
        if expected is not None:
            confusion[(expected, detection.kind)] += 1
        # The file name can be private: rows are numbered, the name stays on this terminal.
        print(
            f"{expected or '-':<15} {detection.kind:<15} {detection.confidence:<5} "
            f"{detection.strong_questions:>6}  {detection.coverage:>8.3f}  "
            f"{detection.page_share:>5.2f}  {detection.answered_ratio:>8.2f}  "
            f"{detection.gap_ratio:>4.2f}  #{index} {path.name}"
        )
        rows.append({"input": index, "expected": expected, **detection.model_dump()})

    if confusion:
        right = sum(n for (want, got), n in confusion.items() if want == got)
        total = sum(confusion.values())
        print(f"\naccuracy {right}/{total}")
        for (want, got), n in sorted(confusion.items()):
            print(f"  expected {want:<15} got {got:<15} {n}")
    if args.json is not None:
        args.json.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
