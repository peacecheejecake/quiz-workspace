"""Document summary core (DOCSUM-01-C01, C06): chapter inputs, unit reuse, limits, pages.

Revisions come from the fixture truth (``FakeParser`` + ``build_revision``) as in the chunker
tests; the LLM path runs over a scripted ``FakeLLMClient``.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from book_core.contracts import (
    Block,
    BlockType,
    DocumentRevision,
    Section,
    SourceLocation,
)
from book_core.llm import FakeLLMClient, LLMOutputError, LLMProviderError, LLMUsage
from book_core.parser import FakeParser
from book_core.structure import apply_edits, build_revision, publish
from book_core.summary import (
    CHAPTER_SCOPE,
    DOCUMENT_SCOPE,
    SUMMARY_FAILURE_MARKER,
    SUMMARY_HOLD_MARKER,
    ExtractiveFakeSummarizer,
    KeyPoint,
    LLMSummarizer,
    PageRange,
    StoredUnit,
    SummaryBody,
    SummaryLimits,
    SummaryTally,
    SummaryTooLargeError,
    chapter_inputs,
    clamp_body,
    document_input_hash,
    split_blocks,
    summarize_revision,
)
from make_fixture_pdfs import OUT_DIR


def _revision(fixture_id: str = "book-ko") -> DocumentRevision:
    parser = FakeParser.from_truth_files([OUT_DIR / f"{fixture_id}.truth.json"])
    parsed = parser.parse(OUT_DIR / f"{fixture_id}.pdf")
    return publish(build_revision(parsed, document_id="doc-1", revision_id="rev-1").revision)


class MemoryStore:
    def __init__(self) -> None:
        self.units: dict[tuple[str, str, str], StoredUnit] = {}

    def find(self, scope: str, section_key: str, input_hash: str) -> StoredUnit | None:
        return self.units.get((scope, section_key, input_hash))

    def save(
        self,
        scope: str,
        section_key: str,
        input_hash: str,
        body: SummaryBody,
        page_from: int | None,
        page_to: int | None,
        usage: LLMUsage | None,
    ) -> StoredUnit:
        unit = StoredUnit(str(len(self.units)), body, page_from, page_to)
        return self.units.setdefault((scope, section_key, input_hash), unit)


class CountingFake(ExtractiveFakeSummarizer):
    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.calls: list[str] = []

    def summarize_chapter(self, title, blocks, page_from, page_to):  # type: ignore[no-untyped-def]
        self.calls.append(f"chapter:{title}")
        return super().summarize_chapter(title, blocks, page_from, page_to)

    def merge_chapter(self, title, parts, page_from, page_to):  # type: ignore[no-untyped-def]
        self.calls.append(f"merge:{title}")
        return super().merge_chapter(title, parts, page_from, page_to)

    def summarize_document(self, title, chapters, page_from, page_to):  # type: ignore[no-untyped-def]
        self.calls.append("document")
        return super().summarize_document(title, chapters, page_from, page_to)


def _run(
    revision: DocumentRevision,
    store: MemoryStore,
    summarizer: ExtractiveFakeSummarizer | LLMSummarizer,
    limits: SummaryLimits | None = None,
) -> tuple[SummaryTally, object]:
    tally = SummaryTally()
    result = summarize_revision(
        chapter_inputs(revision, document_title="물의 순환과 정수 처리"),
        document_title="물의 순환과 정수 처리",
        summarizer=summarizer,
        store=store,
        limits=limits or SummaryLimits(),
        tally=tally,
    )
    return tally, result


def test_chapter_inputs_are_the_top_level_chapters_without_front_matter() -> None:
    chapters = chapter_inputs(_revision(), document_title="t")
    assert [c.title for c in chapters] == ["1장 물의 순환", "2장 정수 처리"]
    assert [(c.page_from, c.page_to) for c in chapters] == [(2, 3), (4, 4)]
    assert all(not c.empty for c in chapters)
    # Same content -> same hash; the hash is not the section key alone.
    again = chapter_inputs(_revision(), document_title="t")
    assert [c.input_hash for c in chapters] == [c.input_hash for c in again]
    assert chapters[0].input_hash != chapters[1].input_hash


def test_docsum_01_c01_unchanged_chapters_and_reduce_are_reused() -> None:
    revision = _revision()
    store, fake = MemoryStore(), CountingFake()
    first, _ = _run(revision, store, fake)
    assert (first.generated_units, first.reused_units) == (3, 0)
    assert fake.calls == ["chapter:1장 물의 순환", "chapter:2장 정수 처리", "document"]

    chlorine = next(b for b in revision.blocks if "염소" in b.text)
    edited = publish(
        apply_edits(revision, {chlorine.id: "교정 문장이다. " + chlorine.text}, revision_id="r2")
    )
    fake.calls.clear()
    second, result = _run(edited, store, fake)
    assert (second.generated_units, second.reused_units) == (2, 1)
    assert fake.calls == ["chapter:2장 정수 처리", "document"]
    assert "교정 문장이다." in result.chapters[1].body.summary_md  # type: ignore[attr-defined]

    fake.calls.clear()
    third, _ = _run(revision, store, fake)
    assert (third.generated_units, third.reused_units) == (0, 3)
    assert fake.calls == []
    assert len(store.units) == 5


def test_docsum_01_c06_too_large_fails_before_any_call() -> None:
    fake = CountingFake()
    with pytest.raises(SummaryTooLargeError):
        _run(_revision(), MemoryStore(), fake, SummaryLimits(max_input_chars=500))
    assert fake.calls == []


def test_docsum_01_c06_long_chapters_are_split_and_merged() -> None:
    fake = CountingFake()
    tally, result = _run(_revision(), MemoryStore(), fake, SummaryLimits(chapter_chars=300))
    assert "merge:1장 물의 순환" in fake.calls
    assert tally.generated_units == 3
    assert all(u.body.summary_md.strip() for u in result.chapters)  # type: ignore[attr-defined]


def test_docsum_01_c06_key_point_pages_stay_inside_the_chapter() -> None:
    _, result = _run(_revision(), MemoryStore(), ExtractiveFakeSummarizer())
    for unit in result.chapters:  # type: ignore[attr-defined]
        for point in unit.body.key_points:
            assert point.pages is not None
            assert unit.page_from <= point.pages.from_ <= point.pages.to <= unit.page_to
    body = SummaryBody(
        title="t",
        summary_md="s",
        key_points=(
            KeyPoint(text="in", pages=PageRange(from_=2, to=3)),
            KeyPoint(text="out", pages=PageRange(from_=1, to=3)),
            KeyPoint(text="reversed", pages=PageRange(from_=3, to=2)),
            KeyPoint(text="none"),
        ),
    )
    clamped = clamp_body(body, 2, 3)
    assert [(p.text, p.pages is not None) for p in clamped.key_points] == [
        ("in", True),
        ("out", False),
        ("reversed", False),
        ("none", False),
    ]
    assert clamped.to_json()["key_points"][0]["pages"] == {"from": 2, "to": 3}


def test_fake_failure_marker_is_invalid_output() -> None:
    revision = _revision()
    block = next(b for b in revision.blocks if "염소" in b.text)
    marked = publish(
        apply_edits(revision, {block.id: f"{SUMMARY_FAILURE_MARKER} 문장."}, revision_id="r2")
    )
    with pytest.raises(LLMOutputError) as caught:
        _run(marked, MemoryStore(), ExtractiveFakeSummarizer())
    assert SUMMARY_FAILURE_MARKER not in str(caught.value)


def test_fake_hold_marker_waits_for_release(tmp_path: Path) -> None:
    revision = _revision()
    block = next(b for b in revision.blocks if "염소" in b.text)
    marked = publish(
        apply_edits(revision, {block.id: f"{SUMMARY_HOLD_MARKER}-tok1 문장."}, revision_id="r2")
    )
    fake = ExtractiveFakeSummarizer(hold_dir=lambda: str(tmp_path))
    done = threading.Event()

    def work() -> None:
        _run(marked, MemoryStore(), fake)
        done.set()

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not (tmp_path / "tok1.held").exists():
        assert time.monotonic() < deadline
        time.sleep(0.02)
    time.sleep(0.2)
    assert not done.is_set()
    (tmp_path / "tok1.release").touch()
    thread.join(10)
    assert done.is_set()


def _mixed_revision() -> DocumentRevision:
    def block(i: int, text: str, kind: BlockType = BlockType.TEXT) -> Block:
        return Block(
            id=f"b{i}",
            type=kind,
            text=text,
            section_id="ch1",
            locations=(SourceLocation(page=1 + i // 4),),
            ordinal=i,
        )

    blocks = (
        block(0, "1장 물", BlockType.HEADING),
        block(1, "물은 순환한다. 증발과 응결이 일어난다."),
        block(2, "1. 물이 끓는 온도는?"),
        block(3, "① 50도 ② 100도 ③ 150도"),
        block(4, "정답: ②"),
        block(5, "해설: 물은 100도에서 끓는다."),
    )
    return DocumentRevision(
        document_id="doc-m",
        revision_id="rev-m",
        revision_number=1,
        source_sha256="0" * 64,
        sections=(Section(id="ch1", title="1장 물", level=1, heading_block_id="b0"),),
        blocks=blocks,
    )


def test_mixed_books_leave_question_segments_out() -> None:
    revision = _mixed_revision()
    full = chapter_inputs(revision, document_title="t")
    body = chapter_inputs(revision, document_title="t", exclude_questions=True)
    texts = [b.text for b in body[0].blocks]
    assert any("끓는 온도" in b.text for b in full[0].blocks)
    assert not any("끓는 온도" in t or "100도" in t or "정답" in t for t in texts)
    assert "물은 순환한다. 증발과 응결이 일어난다." in texts
    assert not any("해설" in t for t in texts), "the explanation after an inline answer"


def test_split_blocks_respects_the_limit() -> None:
    chapter = chapter_inputs(_revision(), document_title="t")[0]
    parts = split_blocks(chapter.blocks, 120)
    assert len(parts) > 1
    assert all(sum(len(b.text) for b in p) <= 120 for p in parts)
    assert [b.text for p in parts for b in p if len(b.text) < 120][:1]


def test_document_hash_follows_the_chapter_hashes() -> None:
    chapters = chapter_inputs(_revision(), document_title="t")
    assert document_input_hash(chapters) == document_input_hash(list(chapters))
    assert document_input_hash(chapters) != document_input_hash(chapters[:1])


def test_llm_summarizer_uses_structured_output_and_validates_pages() -> None:
    llm = FakeLLMClient(model_name="model-x")
    llm.script(
        "summary.chapter",
        {
            "summary_md": "장 요약",
            "key_points": [
                {"text": "핵심", "page_from": 2, "page_to": 3},
                {"text": "범위 밖", "page_from": 9, "page_to": 9},
            ],
        },
    )
    llm.script("summary.document", {"summary_md": "문서 요약", "key_points": []})
    store = MemoryStore()
    tally, result = _run(_revision(), store, LLMSummarizer(llm))
    assert tally.generated_units == 3
    assert tally.usage.input_tokens > 0
    chapter = result.chapters[0]  # type: ignore[attr-defined]
    assert chapter.body.title == "1장 물의 순환"
    assert [p.pages is not None for p in chapter.body.key_points] == [True, False]
    assert result.document.body.summary_md == "문서 요약"  # type: ignore[attr-defined]
    assert {k[0] for k in store.units} == {CHAPTER_SCOPE, DOCUMENT_SCOPE}
    prompts = [c.prompt for c in llm.calls]
    assert any("[p.2]" in p for p in prompts)


def test_llm_errors_propagate_as_metadata_only() -> None:
    llm = FakeLLMClient()
    llm.script("summary.chapter", LLMProviderError("timeout", kind="timeout"))
    with pytest.raises(LLMProviderError):
        _run(_revision(), MemoryStore(), LLMSummarizer(llm))
    bad = FakeLLMClient()
    bad.script("summary.chapter", '{"summary_md": 1}')
    with pytest.raises(LLMOutputError):
        _run(_revision(), MemoryStore(), LLMSummarizer(bad))
