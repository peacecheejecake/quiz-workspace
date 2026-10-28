"""UX6-UPLOAD-B: the `document.parse` job classifies an auto upload before publishing it.

Fakes as in test_document_job.py (the fixture-truth parser, in-memory Qdrant). The Postgres side
of `worker_classify_document` (once, first revision, never a user kind) is covered by
supabase/tests/17_document_auto_classification.test.sql; the store's call is exercised against the
stack in tests/integration/questions/test_document_kinds.py.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import replace

from book_core.parser import document_from_pages
from book_core.structure import apply_edits, build_revision
from quiz_worker.document_job import KIND_KEY, classify, started_import_jobs
from quiz_worker.document_store import DocumentRow, RevisionRow
from quiz_worker.runner import RunOutcome

from .document_fakes import PDF_DIR
from .test_document_job import World

PAPER = (PDF_DIR / "questions-ko.pdf").read_bytes()

_PROSE = (
    "물은 증발과 응결을 거치며 지구 표면과 대기 사이를 끊임없이 순환한다. 태양 에너지가 물을 "
    "데우고 수증기는 상승하여 구름을 이룬다."
)


def _exercises(*, answers: bool) -> list[str]:
    lines = ["# 확인 문제"]
    for n in range(1, 4):
        lines += [f"{n}. 다음 중 물의 순환 과정이 아닌 것은?", "① 증발", "② 응결", "③ 광합성"]
        if answers:
            lines += ["정답: ③"]
    return lines


def _mixed_pdf(world: World, *, answers: bool) -> bytes:
    """A synthetic book with chapter-end exercises, registered with the fake parser."""
    data = b"%PDF-1.4 synthetic mixed " + (b"answered" if answers else b"bare")
    pages = []
    for n in range(1, 4):
        pages.append([f"# 제{n}장 물의 순환", _PROSE, _PROSE, _PROSE, _PROSE])
        pages.append(_exercises(answers=answers))
    world.parser.inner.register(
        document_from_pages(
            pages, source_path="mixed.pdf", source_sha256=hashlib.sha256(data).hexdigest()
        )
    )
    world.deps.page_counter = lambda _path: None
    return data


def _run(world: World, data: bytes, **kw: str) -> tuple[DocumentRow, RevisionRow, dict[str, str]]:
    document, revision = world.upload(data, **kw)
    result = world.run(world.submit(document, revision.id))
    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    return world.store.documents[document.id], revision, dict(result.record.result or {})


def test_an_auto_question_paper_is_classified_and_starts_its_import() -> None:
    world = World()
    document, _, result = _run(world, PAPER, type_source="auto")

    assert (document.document_type, document.content_kind) == ("question_paper", "question_paper")
    assert result[KIND_KEY] == "question_paper"
    run_id, job_id, _ = world.store.import_starts[document.id]
    assert started_import_jobs(result) == [job_id]
    assert result["question_import_id"] == str(run_id)
    assert world.store.detections[document.id]["kind"] == "question_paper"
    # Indexed with the decided type, before the publish.
    assert {p["document_type"] for p in world.points(document)} == {"question_paper"}


def test_an_auto_book_stays_a_book_without_an_import() -> None:
    world = World()
    document, _, result = _run(world, (PDF_DIR / "book-ko.pdf").read_bytes(), type_source="auto")

    assert (document.document_type, document.content_kind) == ("book", "book")
    assert result[KIND_KEY] == "book"
    assert world.store.import_starts == {}
    assert {p["document_type"] for p in world.points(document)} == {"book"}


def test_a_confident_mixed_book_starts_its_import_a_doubtful_one_waits() -> None:
    world = World()
    confident, _, result = _run(world, _mixed_pdf(world, answers=True), type_source="auto")
    assert (confident.document_type, confident.content_kind) == ("book", "mixed")
    assert world.store.detections[confident.id]["confidence"] == "high"
    assert started_import_jobs(result) == [world.store.import_starts[confident.id][1]]

    doubtful, _, result = _run(world, _mixed_pdf(world, answers=False), type_source="auto")
    assert (doubtful.document_type, doubtful.content_kind) == ("book", "mixed")
    assert world.store.detections[doubtful.id]["confidence"] == "low"
    assert doubtful.id not in world.store.import_starts
    assert started_import_jobs(result) == []


def test_explicit_kinds_are_never_classified() -> None:
    """The old upload paths (and kinds a user chose) keep their kind: questions-ko uploaded as a
    book stays a book with no import."""
    world = World()
    document, _, result = _run(world, PAPER, document_type="book")

    assert (document.document_type, document.content_kind) == ("book", "book")
    assert KIND_KEY not in result
    assert world.store.detections == {}
    assert world.store.import_starts == {}


def test_a_user_choice_made_before_the_publish_wins() -> None:
    """A kind pinned between the classification and the publish transaction is kept (the DB
    function re-checks under the row lock; the fake mirrors it)."""
    world = World()
    document, revision = world.upload(PAPER, type_source="auto")
    world.index.after_index = lambda: world.store.documents.__setitem__(
        document.id,
        replace(
            world.store.documents[document.id],
            type_source="user",
            content_kind="book",
            document_type="book",
        ),
    )
    result = world.run(world.submit(document, revision.id))

    assert result.outcome is RunOutcome.SUCCEEDED, result.error
    stored = world.store.documents[document.id]
    assert (stored.document_type, stored.content_kind, stored.type_source) == (
        "book",
        "book",
        "user",
    )
    assert world.store.detections == {}
    assert world.store.import_starts == {}


def test_redelivery_and_correction_revisions_never_reclassify() -> None:
    world = World()
    document, revision = world.upload(PAPER, type_source="auto")
    envelope = world.submit(document, revision.id)
    world.run(envelope)
    first = dict(world.store.detections)
    starts = dict(world.store.import_starts)

    assert world.run(envelope).outcome is RunOutcome.DUPLICATE_FINISHED
    rerun = world.run(world.submit(document, revision.id))
    assert rerun.outcome is RunOutcome.SUCCEEDED
    assert KIND_KEY not in (rerun.record.result or {})

    # A correction draft of a document the user re-typed as a book: published as is.
    world.store.documents[document.id] = replace(
        world.store.documents[document.id],
        type_source="user",
        content_kind="book",
        document_type="book",
    )
    content = world.store.load_content(world.store.documents[document.id], revision)
    edited = apply_edits(
        content,
        {content.blocks[1].id: content.blocks[1].text + " (교정)"},
        revision_id=str(uuid.uuid4()),
    )
    draft = world.store.add_draft(document.id, edited)
    corrected = world.run(world.submit(document, draft.id))

    assert corrected.outcome is RunOutcome.SUCCEEDED, corrected.error
    assert KIND_KEY not in (corrected.record.result or {})
    assert world.store.documents[document.id].document_type == "book"
    assert world.store.detections == first
    assert world.store.import_starts == starts


def test_classify_keeps_numbers_only() -> None:
    world = World()
    data = _mixed_pdf(world, answers=True)
    parsed = world.parser.inner._documents[hashlib.sha256(data).hexdigest()]
    content = build_revision(parsed, document_id="d", revision_id="r").revision
    found = classify(content)
    assert found.kind == "mixed"
    assert found.auto_import is True
    assert "물" not in str(found.detection)
