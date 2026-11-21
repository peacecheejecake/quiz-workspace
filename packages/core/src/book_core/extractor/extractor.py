"""``QuestionExtractor``: question PDF (``ParsedDocument``) -> ``QuestionDraft``s (Task M4.3).

Pipeline (questions.md §6): printed reading order (``reading_order``) -> rule-based
pre-extraction (numbering, options, figures, answer key, page/bbox provenance) -> optional LLM
refinement per question (``questions.extract/v7``, structured output, own source text only) ->
structural validation -> drafts with ``review_status=pending``, ``origin=pdf_import`` and
validation issues.

Answers come only from the printed answer key: a separate key section matched by question number,
or the inline ``정답: ②`` line printed right after the question (which answers that question only,
so numbering that restarts per chapter keeps its answers). The printed explanation after an inline
answer becomes the draft's ``explanation``. An LLM answer is accepted only when the answer key
line for that question states the same thing; otherwise it is rejected with a warning and the
answer stays as the key gives it (``None`` when the key has no line for the question).
LLM failures (provider errors, schema-invalid output) never fail the run: the question keeps
its pre-extraction and gets a warning.
"""

from __future__ import annotations

import base64
import logging
import re
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, as_completed, wait
from dataclasses import dataclass, field, replace
from itertools import pairwise
from typing import Annotated, Literal, Protocol

from pydantic import Field

from book_core.contracts import (
    BBox,
    Block,
    BlockType,
    CoreModel,
    DocumentRevision,
    DraftOrigin,
    GeneratorInfo,
    ParsedDocument,
    QuestionDraft,
    QuestionOption,
    QuestionType,
    ReviewStatus,
    SourceEvidence,
    TableContent,
    ValidationIssue,
)
from book_core.contracts.common import Identifier
from book_core.extractor.llm_refine import LLMQuestion, build_request
from book_core.extractor.reading_order import reading_order
from book_core.extractor.segment import (
    FIGURE_MARKER,
    AnswerKeyEntry,
    RawFigure,
    RawQuestion,
    Segmentation,
    SourceLine,
    add_shared_figure_text,
    answer_entries,
    infer_type,
    segment_chapters,
    union_locations,
)
from book_core.llm import (
    LLMCallInfo,
    LLMClient,
    LLMImage,
    LLMOutputError,
    LLMProviderError,
    LLMRequest,
    LLMUsage,
)
from book_core.question import (
    CIRCLED_DIGITS,
    HANGUL_LABELS,
    aligned_stem_tables,
    answer_option_keys,
    canonical_key,
    gfm_table,
    has_pipe_table,
    issue,
    loose_text,
    option_id,
    pipe_table_rows,
    split_pipe_blocks,
    structural_issues,
)

logger = logging.getLogger("book_core.extractor")

EXTRACTOR_VERSION = "book-core-question-extractor/2"

MAX_QUESTION_IMAGES = 3
"""Crops of printed tables / figures sent with one question's refinement request."""
MAX_IMAGE_EDGE = 1568
"""Longest edge, in pixels, of a crop."""
CROP_PADDING_PT = 6.0
"""Margin added around a table / figure box, in PDF points."""


class PageRegionRenderer(Protocol):
    """Renders a region of a source page as PNG bytes (``None`` when it cannot).

    ``page`` is 1-based and ``bbox`` is in PDF points with the origin at the page's top-left
    corner; the longest edge of the image must not exceed ``max_edge`` pixels.
    """

    def __call__(self, page: int, bbox: BBox, *, max_edge: int) -> bytes | None: ...


_OUTLIER_MIN_QUESTIONS = 10
"""Multiple-choice questions before a document has a common option count."""
_OUTLIER_MAX_SHARE = 0.1
"""An option count held by at least this share of the questions is a format, not an outlier."""


class ExtractedQuestion(CoreModel):
    """A draft plus extraction facts the draft contract does not carry."""

    number: Annotated[int, Field(ge=0)]
    multi_select: bool
    refined_by_llm: bool
    draft: QuestionDraft


class QuestionExtraction(CoreModel):
    """Result of one extraction run. Contains no answer-key or source text beyond the drafts."""

    schema_version: Literal[1] = 1
    extractor_version: str = EXTRACTOR_VERSION
    document_id: Identifier
    revision_id: Identifier | None = None
    questions: tuple[ExtractedQuestion, ...] = ()
    warnings: tuple[ValidationIssue, ...] = ()
    llm_calls: tuple[LLMCallInfo, ...] = ()
    # True when a stop signal (soft time limit) ended the LLM refinement early.
    refinement_incomplete: bool = False

    @property
    def drafts(self) -> tuple[QuestionDraft, ...]:
        return tuple(q.draft for q in self.questions)

    @property
    def llm_usage(self) -> LLMUsage:
        total = LLMUsage()
        for call in self.llm_calls:
            total = total + call.usage
        return total


@dataclass(slots=True)
class _Candidate:
    number: int
    question_type: QuestionType
    multi_select: bool
    stem: str
    options: list[tuple[str, str]]  # (canonical key, text)
    correct_option_ids: tuple[str, ...] | None = None
    accepted_answers: tuple[str, ...] | None = None
    explanation: str | None = None
    issues: list[ValidationIssue] = field(default_factory=list)
    generator: GeneratorInfo | None = None
    stem_tables: tuple[TableContent, ...] = ()


class QuestionExtractor:
    """Extract import drafts from a parsed question paper.

    ``llm=None`` (or no ``LLM_API_KEY`` configured) runs the deterministic rule-based path only.
    """

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm

    def extract(
        self,
        document: ParsedDocument | DocumentRevision,
        *,
        document_id: str,
        revision_id: str | None = None,
        progress: Callable[[int, int], object] | None = None,
        concurrency: int = 1,
        stop_on: tuple[type[BaseException], ...] = (),
        region_renderer: PageRegionRenderer | None = None,
    ) -> QuestionExtraction:
        """Extract drafts; ``progress(done, total)`` is monotonic and called from this thread.

        LLM refinement runs on at most ``concurrency`` threads (the client must be safe for
        concurrent use); output order and draft ids do not depend on it. If an exception in
        ``stop_on`` (e.g. a Celery soft time limit) arrives while refining, finished questions
        keep their refinement, the rest stay rule-based and ``refinement_incomplete`` is set.

        With ``region_renderer``, a question whose stem has tables or figures sends their printed
        regions (at most ``MAX_QUESTION_IMAGES``) as images with its refinement request; the
        renderer is called from this thread only. Without it nothing is rendered.
        """
        blocks = reading_order(document.blocks)
        seg = segment_chapters(blocks)
        warnings = _document_warnings(
            seg.questions,
            [*seg.answer_key, *(e for q in seg.questions for e in q.answer)],
            seg.unparsed_answer_lines,
            seg.ambiguous_answer_tables,
        )

        questions: list[ExtractedQuestion] = []
        calls: list[LLMCallInfo] = []
        contexts = list(_contexts(seg, blocks))
        total = len(contexts)

        # Phase 1: deterministic pre-extraction (cheap, sequential).
        candidates: list[_Candidate] = []
        for ctx in contexts:
            candidate = _pre_extract(ctx.raw, ctx.entries, ctx.next_block, ctx.figures)
            if ctx.occurrence and not ctx.entries:
                candidate.issues.append(
                    issue(
                        "duplicate_question_number",
                        f"Question number {ctx.raw.number} appears more than once; "
                        "the answer key was not applied.",
                    )
                )
            candidates.append(candidate)
        _note_layout_issues(candidates, contexts, _repaired(document.blocks, blocks, contexts))

        # Phase 2: LLM refinement on a bounded pool; results are stored by index so the output
        # order never depends on completion order.
        refinable = [i for i, c in enumerate(candidates) if c.stem] if self._llm is not None else []
        results: dict[int, tuple[_Candidate, bool, LLMCallInfo | None]] = {}
        images: dict[int, _Crops] = {}
        done = 0
        for _ in range(total - len(refinable)):  # no LLM call needed: done at once
            done += 1
            if progress is not None:
                progress(done, total)
        interrupted = False
        if refinable and self._llm is not None:
            llm = self._llm
            pool = ThreadPoolExecutor(
                max_workers=max(1, min(concurrency, len(refinable))),
                thread_name_prefix="question-refine",
            )
            futures: dict[Future[tuple[_Candidate, bool, LLMCallInfo | None]], int] = {}
            try:
                if region_renderer is not None:
                    for i in refinable:
                        images[i] = _region_images(contexts[i].raw, region_renderer, stop_on)
                # The first call goes alone so the others can read the prompt cache it writes.
                first = refinable[0]
                futures = {
                    pool.submit(
                        _refine,
                        llm,
                        candidates[first],
                        contexts[first],
                        images.get(first, _NO_CROPS),
                    ): first
                }
                if concurrency > 1:
                    wait(futures)
                for i in refinable[1:]:
                    futures[
                        pool.submit(
                            _refine, llm, candidates[i], contexts[i], images.get(i, _NO_CROPS)
                        )
                    ] = i
                for future in as_completed(futures):
                    results[futures[future]] = future.result()
                    done += 1
                    if progress is not None:
                        progress(done, total)
            except stop_on:
                # Soft time limit: keep what finished, leave the rest rule-based.
                interrupted = True
                for future, i in futures.items():
                    if (
                        i not in results
                        and future.done()
                        and not future.cancelled()
                        and future.exception() is None
                    ):
                        results[i] = future.result()
                logger.warning(
                    "question refinement stopped early document=%s refined=%d of %d",
                    document_id,
                    len(results),
                    len(refinable),
                )
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

        # Phase 3: drafts in document order.
        for index, ctx in enumerate(contexts):
            raw = ctx.raw
            candidate = candidates[index]
            refined = False
            if index in results:
                candidate, refined, info = results[index]
                if info is not None:
                    calls.append(info)
            elif interrupted and index in refinable:
                candidate.issues.append(
                    issue(
                        "llm_unavailable",
                        "LLM refinement stopped at the time limit; "
                        "the rule-based extraction was kept.",
                    )
                )

            draft_id = f"{document_id}-q{raw.number:03d}"
            if ctx.occurrence:
                draft_id = f"{draft_id}-{ctx.occurrence}"
            draft = _build_draft(
                candidate,
                draft_id=draft_id,
                evidence=_evidence(raw, ctx.figures, blocks, document_id, revision_id),
            )
            if draft is None:
                warnings.append(
                    issue(
                        "question_skipped",
                        f"Question {raw.number} has no stem text and was skipped.",
                    )
                )
                continue
            questions.append(
                ExtractedQuestion(
                    number=raw.number,
                    multi_select=candidate.multi_select,
                    refined_by_llm=refined,
                    draft=draft,
                )
            )
        refinement_incomplete = interrupted

        logger.info(
            "question extraction document=%s questions=%d answer_key_entries=%d llm_calls=%d",
            document_id,
            len(questions),
            len(seg.answer_key),
            len(calls),
        )
        return QuestionExtraction(
            document_id=document_id,
            revision_id=revision_id,
            questions=tuple(questions),
            warnings=tuple(warnings),
            llm_calls=tuple(calls),
            refinement_incomplete=refinement_incomplete,
        )


def llm_requests(document: ParsedDocument | DocumentRevision) -> list[tuple[int, LLMRequest]]:
    """``(question number, request)`` for every question the extractor would refine, in order.

    The requests are exactly those ``QuestionExtractor.extract`` sends, so tests (and cost
    estimates) can script or count them before a run.
    """
    blocks = reading_order(document.blocks)
    return [
        (ctx.raw.number, build_request(*_request_lines(ctx)))
        for ctx in _contexts(segment_chapters(blocks), blocks)
        if ctx.raw.stem
    ]


@dataclass(frozen=True, slots=True)
class _Context:
    raw: RawQuestion
    entries: list[AnswerKeyEntry]
    figures: list[RawFigure]
    next_block: Block | None
    occurrence: int
    """0 for a unique question number, else the 1-based occurrence of a duplicated number."""


def _contexts(seg: Segmentation, blocks: Sequence[Block]) -> list[_Context]:
    counts = Counter(q.number for q in seg.questions)
    keyed = answer_entries(seg)
    labelled = {f.label: f for f in seg.loose_figures if f.label is not None}
    for q in seg.questions:
        for f in q.figures:
            if f.label is not None:
                labelled.setdefault(f.label, f)

    contexts: list[_Context] = []
    seen: Counter[int] = Counter()
    for raw in seg.questions:
        seen[raw.number] += 1
        duplicate = counts[raw.number] > 1
        last = max(raw.block_indices)
        figures = _figures(raw, labelled)
        for figure in figures:
            if all(figure is not own for own in raw.figures):
                add_shared_figure_text(raw, figure)
        contexts.append(
            _Context(
                raw=raw,
                entries=raw.answer if raw.answer else keyed[id(raw)],
                figures=figures,
                next_block=blocks[last + 1] if last + 1 < len(blocks) else None,
                occurrence=seen[raw.number] if duplicate else 0,
            )
        )
    return contexts


# ------------------------------------------------------------------------------------------
# Reading order and layout checks


def _text_ids(blocks: Sequence[Block]) -> tuple[str, ...]:
    return tuple(b.id for b in blocks if b.type is not BlockType.IMAGE)


def _own_text(raw: RawQuestion, blocks: Sequence[Block]) -> tuple[str, ...]:
    return _text_ids([blocks[i] for i in sorted(set(raw.block_indices))])


def _repaired(
    parsed: Sequence[Block], ordered: Sequence[Block], contexts: Sequence[_Context]
) -> set[int]:
    """Positions in ``contexts`` of the questions the reading order changed: they own other text
    blocks, or the same ones in another order, than the parser's order gave them. Images do not
    count: a dropped decoration changes no text, and a note on every page would mean nothing."""
    if _text_ids(parsed) == _text_ids(ordered):
        return set()
    before: Counter[tuple[str, ...]] = Counter(
        _own_text(q, parsed) for q in segment_chapters(parsed).questions
    )
    return {i for i, ctx in enumerate(contexts) if before[_own_text(ctx.raw, ordered)] == 0}


def _option_outliers(candidates: Sequence[_Candidate]) -> set[int]:
    """Positions of multiple-choice candidates whose option count is rare in the document, next
    to a clear common count. A count shared by a real part of the paper (ten O/X questions before
    fifty with four options) is a format, not an outlier."""
    counts = Counter(len(c.options) for c in candidates if c.options)
    total = sum(counts.values())
    if total < _OUTLIER_MIN_QUESTIONS:
        return set()
    mode = counts.most_common(1)[0][0]
    rare = {n for n, seen in counts.items() if n != mode and seen / total < _OUTLIER_MAX_SHARE}
    return {i for i, c in enumerate(candidates) if len(c.options) in rare}


def _lost_options(candidates: Sequence[_Candidate]) -> set[int]:
    """Positions of a question without options followed by one with duplicate option labels: the
    next question took its options. Reported on both."""
    found: set[int] = set()
    for i, (candidate, following) in enumerate(pairwise(candidates)):
        duplicated = any(x.code == "duplicate_option_label" for x in following.issues)
        if not candidate.options and duplicated:
            found |= {i, i + 1}
    return found


def _note_layout_issues(
    candidates: Sequence[_Candidate], contexts: Sequence[_Context], repaired: set[int]
) -> None:
    for i in sorted(repaired):
        candidates[i].issues.append(
            issue(
                "reading_order_repaired",
                f"Question {contexts[i].raw.number} was read in the printed order, which differs "
                "from the parser's order.",
            )
        )
    for candidate in candidates:
        if has_pipe_table(candidate.stem):
            candidate.issues.append(
                issue(
                    "table_in_stem",
                    "A table printed in the question was put in the stem; "
                    "merged cells may differ from the print.",
                )
            )
    for i in sorted(_option_outliers(candidates)):
        candidates[i].issues.append(
            issue(
                "option_count_outlier",
                "This question has an unusual number of options for this document.",
                field="options",
            )
        )
    for i in sorted(_lost_options(candidates)):
        candidates[i].issues.append(
            issue(
                "options_on_next_question",
                "One question has no options and the next repeats option labels; "
                "the options may be on the wrong question.",
                field="options",
            )
        )


# ------------------------------------------------------------------------------------------
# Pre-extraction


def _figures(raw: RawQuestion, labelled: dict[str, RawFigure]) -> list[RawFigure]:
    figures = list(raw.figures)
    own = {f.label for f in figures}
    for label in raw.figure_labels:
        if label not in own and label in labelled:
            figures.append(labelled[label])
    return figures


def _options(raw: RawQuestion) -> tuple[list[tuple[str, str]], list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    options: list[tuple[str, str]] = []
    seen: Counter[str] = Counter()
    for option in raw.options:
        key = canonical_key(option.label)
        seen[key] += 1
        if seen[key] > 1:
            issues.append(
                issue(
                    "duplicate_option_label",
                    f"Option label {option.label} appears more than once.",
                    field="options",
                )
            )
            key = f"{key}-{seen[key]}"
        options.append((key, option.text))
    keys = [k for k, _ in options]
    if keys and len(set(keys)) == len(keys) and not _is_sequence(keys):
        # Options printed as a grid (① ② over ③ ④) are read row-wise or column-wise: a
        # complete label sequence in another order is the same options, put back in order.
        ordered = sorted(
            options, key=lambda o: (0, int(o[0]), "") if o[0].isdecimal() else (1, 0, o[0])
        )
        if _is_sequence([k for k, _ in ordered]):
            options, keys = ordered, [k for k, _ in ordered]
    if keys and not _is_sequence(keys):
        issues.append(
            issue(
                "option_sequence_gap",
                "Option labels are not a consecutive sequence; check for a missing option.",
                field="options",
            )
        )
    if any(not text for _, text in options):
        issues.append(issue("option_text_missing", "An option has no text.", field="options"))
    return options, issues


def _is_sequence(keys: Sequence[str]) -> bool:
    """Labels run 1, 2, 3... / A, B, C... / 가, 나, 다... from the first label."""
    if keys and all(len(k) == 1 and k in HANGUL_LABELS for k in keys):
        return "".join(keys) == HANGUL_LABELS[: len(keys)]
    if all(k.isdecimal() and len(k) <= 4 for k in keys):
        return [int(k) for k in keys] == list(range(1, len(keys) + 1))
    if all(len(k) == 1 and k.isalpha() for k in keys):
        return [ord(k) for k in keys] == list(range(ord("A"), ord("A") + len(keys)))
    return False


def _answer_from_key(
    question_type: QuestionType,
    option_keys: Sequence[str],
    entries: Sequence[AnswerKeyEntry],
) -> tuple[tuple[str, ...] | None, tuple[str, ...] | None, list[ValidationIssue]]:
    """``(correct_option_ids, accepted_answers, issues)`` from the printed answer key."""
    if not entries:
        return None, None, []
    texts = {e.text for e in entries}
    if len(texts) > 1:
        return (
            None,
            None,
            [
                issue(
                    "answer_key_conflict",
                    "The answer key lists different answers for this question; none was applied.",
                )
            ],
        )
    text = entries[0].text
    if question_type is QuestionType.MCQ:
        keys = answer_option_keys(text)
        if keys is None or not set(keys) <= set(option_keys):
            return (
                None,
                None,
                [
                    issue(
                        "answer_key_unmapped",
                        "The answer key entry does not match this question's option labels; "
                        "no answer was applied.",
                        field="correct_option_ids",
                    )
                ],
            )
        ordered = tuple(dict.fromkeys(option_id(k) for k in keys))
        return ordered, None, []
    if any(c in CIRCLED_DIGITS for c in text):
        return (
            None,
            None,
            [
                issue(
                    "answer_key_type_mismatch",
                    "The answer key gives an option label for a question without options; "
                    "no answer was applied.",
                    field="accepted_answers",
                )
            ],
        )
    return None, (text,), []


def _pre_extract(
    raw: RawQuestion,
    entries: Sequence[AnswerKeyEntry],
    next_block: Block | None,
    figures: Sequence[RawFigure],
) -> _Candidate:
    options, issues = _options(raw)
    question_type, multi = infer_type(raw, next_block)
    if question_type is QuestionType.MCQ and len(options) < 2:
        issues.append(
            issue(
                "type_uncertain",
                "Only one option was found; check whether this is a multiple-choice question.",
            )
        )
    found_labels = {f.label for f in figures}
    for label in raw.figure_labels:
        if label not in found_labels:
            issues.append(
                issue(
                    "figure_missing",
                    "The stem refers to a figure that was not found in the document.",
                )
            )
    if question_type is not QuestionType.MCQ:
        options = []
    correct, accepted, answer_issues = _answer_from_key(
        question_type, [k for k, _ in options], entries
    )
    return _Candidate(
        number=raw.number,
        question_type=question_type,
        multi_select=multi,
        stem=raw.stem,
        options=options,
        correct_option_ids=correct,
        accepted_answers=accepted,
        explanation=raw.explanation,
        issues=issues + answer_issues,
        stem_tables=tuple(raw.stem_tables),
    )


# ------------------------------------------------------------------------------------------
# LLM refinement


def _source_lines(raw: RawQuestion, figures: Sequence[RawFigure]) -> list[str]:
    lines: list[SourceLine] = [*raw.stem_lines]
    for option in raw.options:
        lines += option.lines
    lines += [f.caption for f in figures if f.caption is not None]
    seen: set[tuple[int, str]] = set()
    ordered: list[tuple[int, str]] = []
    for line in sorted(lines, key=lambda ln: ln.block_index):
        if (line.block_index, line.text) not in seen:
            seen.add((line.block_index, line.text))
            ordered.append((line.block_index, line.prompt or line.text))
    # The printed text of a figure that is part of the stem follows its marker line; repeated
    # lines inside a figure (two boxes labelled "B") are all kept.
    own = [f for f in raw.figures if f.text_in_stem]
    # A shared figure's text sits after the stem, where the stem puts it.
    after_stem = max((ln.block_index for ln in raw.stem_lines), default=0)
    placed = [(f, f.block_index) for f in own] + [(f, after_stem) for f in raw.shared_figures]
    for figure, key in placed:
        if figure.image is not None:
            ordered.append((key, FIGURE_MARKER))
            ordered += [(key, text) for text in figure.image.text.split("\n") if text.strip()]
    ordered.sort(key=lambda item: item[0])  # stable: the marker stays before its text
    return [text for _, text in ordered]


def _request_lines(ctx: _Context) -> tuple[list[str], list[str]]:
    return _source_lines(ctx.raw, ctx.figures), sorted({e.line.text for e in ctx.entries})


@dataclass(frozen=True, slots=True)
class _Crops:
    images: tuple[LLMImage, ...] = ()
    tables: frozenset[int] = frozenset()
    """Indices (in ``stem_tables``) of the tables whose printed regions are all in ``images``."""


_NO_CROPS = _Crops()


def _region_images(
    raw: RawQuestion,
    render: PageRegionRenderer,
    stop_on: tuple[type[BaseException], ...] = (),
) -> _Crops:
    """PNG crops of the printed tables and figures whose text the model reads: one per page of
    a block, in print order, at most ``MAX_QUESTION_IMAGES``. A failed render is skipped. The
    result also lists the stem tables whose every page region was sent."""
    blocks: dict[str, tuple[int, Block]] = {}
    for line in raw.stem_lines:
        block = line.block
        if block.type is BlockType.TABLE and any(block.table is t for t in raw.stem_tables):
            blocks.setdefault(block.id, (line.block_index, block))
    for figure in raw.figures:
        if figure.text_in_stem and figure.image is not None:
            blocks.setdefault(figure.image.id, (figure.block_index, figure.image))
    for figure in raw.shared_figures:
        if figure.image is not None:
            blocks.setdefault(figure.image.id, (max(raw.block_indices, default=0), figure.image))
    images: list[LLMImage] = []
    imaged: set[int] = set()
    for _, block in sorted(blocks.values(), key=lambda item: item[0]):
        complete = True
        for location in union_locations([block]):
            if location.bbox is None or len(images) >= MAX_QUESTION_IMAGES:
                complete = False
                continue
            box = location.bbox
            padded = BBox(
                x0=max(0.0, box.x0 - CROP_PADDING_PT),
                y0=max(0.0, box.y0 - CROP_PADDING_PT),
                x1=box.x1 + CROP_PADDING_PT,
                y1=box.y1 + CROP_PADDING_PT,
            )
            try:
                png = render(location.page, padded, max_edge=MAX_IMAGE_EDGE)
            except Exception as exc:
                if stop_on and isinstance(exc, stop_on):
                    raise
                # Only the type: nothing about the page content.
                logger.warning("page region render failed: %s", type(exc).__name__)
                complete = False
                continue
            if not png:
                complete = False
                continue
            images.append(
                LLMImage(media_type="image/png", data=base64.b64encode(png).decode("ascii"))
            )
        if complete:
            imaged.update(n for n, t in enumerate(raw.stem_tables) if t is block.table)
    return _Crops(tuple(images), frozenset(imaged))


def _refine(
    llm: LLMClient, pre: _Candidate, ctx: _Context, crops: _Crops = _NO_CROPS
) -> tuple[_Candidate, bool, LLMCallInfo | None]:
    source, key_lines = _request_lines(ctx)
    entries = ctx.entries
    request = build_request(source, key_lines, crops.images)
    try:
        result = llm.complete(request, LLMQuestion)
    except LLMOutputError as exc:
        pre.issues.append(
            issue(
                "llm_output_invalid",
                f"LLM output was invalid ({exc.detail}); the rule-based extraction was kept.",
            )
        )
        return pre, False, exc.call_info
    except LLMProviderError as exc:
        pre.issues.append(
            issue(
                "llm_unavailable",
                f"LLM call failed ({exc.kind}); the rule-based extraction was kept.",
            )
        )
        return pre, False, None
    merged = _merge(pre, result.output, entries, crops.tables)
    merged.generator = GeneratorInfo(model=result.info.model, prompt_version=request.prompt_version)
    return merged, True, result.info


def _merge(
    pre: _Candidate,
    proposal: LLMQuestion,
    entries: Sequence[AnswerKeyEntry],
    imaged: frozenset[int] = frozenset(),
) -> _Candidate:
    issues = list(pre.issues)
    stem, options, text_issues, tables = _verified_text(pre, proposal, imaged)
    issues += text_issues

    question_type = QuestionType(proposal.question_type)
    if (question_type is QuestionType.MCQ) != bool(options):
        issues.append(
            issue(
                "llm_type_rejected",
                f"The LLM type {question_type.value} does not fit the printed options; "
                f"{pre.question_type.value} was kept.",
            )
        )
        question_type = pre.question_type
    if question_type is not QuestionType.MCQ:
        options = []
    multi = proposal.multi_select if question_type is QuestionType.MCQ else False

    # Re-derive the key answer against the final options; drop the pre answer issues.
    issues = [
        i
        for i in issues
        if i.code not in {"answer_key_unmapped", "answer_key_type_mismatch", "answer_key_conflict"}
    ]
    correct, accepted, key_issues = _answer_from_key(
        question_type, [k for k, _ in options], entries
    )
    issues += key_issues

    answer = proposal.answer
    has_llm_answer = answer is not None and bool(answer.option_labels or answer.text_answers)
    if (
        answer is not None
        and has_llm_answer
        and not _llm_answer_matches_key(
            question_type, answer.option_labels, answer.text_answers, entries
        )
    ):
        issues.append(
            issue(
                "llm_answer_rejected",
                "The LLM answer is not stated by the source answer key and was discarded.",
                field="correct_option_ids"
                if question_type is QuestionType.MCQ
                else "accepted_answers",
            )
        )
    return replace(
        pre,
        question_type=question_type,
        multi_select=multi,
        stem=stem,
        stem_tables=pre.stem_tables if tables is None else tables,
        options=options,
        correct_option_ids=correct,
        accepted_answers=accepted,
        issues=issues,
    )


def _verified_text(
    pre: _Candidate, proposal: LLMQuestion, imaged: frozenset[int] = frozenset()
) -> tuple[str, list[tuple[str, str]], list[ValidationIssue], tuple[TableContent, ...] | None]:
    """Stem and options from the LLM only where they match the printed spans.

    Every label-text pair must be the printed one: with options found by the pre-extractor,
    each LLM option must have the same label, in the same order, with the same text as that
    option's printed span (whitespace/line breaks aside), and the stem must equal the printed
    stem span. So swapped texts, text moved between stem and options and rewritten text are all
    rejected (the printed version is kept, with a warning). When the pre-extractor found no
    options, the LLM split is accepted only if stem + label + text + ... reproduces the printed
    question text exactly.
    """
    issues: list[ValidationIssue] = []
    keys = [canonical_key(o.label) for o in proposal.options]
    keys_ok = all(keys) and len(set(keys)) == len(keys)
    llm_stem, corrected_stem, corrected_tables = _resolve_tables(
        proposal.stem.strip(), pre.stem_tables, imaged=imaged
    )

    if not pre.options and proposal.options:
        llm_options = [(k, o.text.strip()) for k, o in zip(keys, proposal.options, strict=True)]
        # The labels must form a complete sequence from the first label, so an option cannot
        # be folded into the stem (``stem 가. x`` + ``나. y`` also reproduces the print).
        if (
            keys_ok
            and _is_sequence(keys)
            and _reproduces(pre.stem, llm_stem, llm_options)
            and _tables(llm_stem) == _tables(pre.stem)
        ):
            return corrected_stem, llm_options, issues, corrected_tables
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM split of stem and options does not reproduce the printed question; "
                "the printed text was kept.",
                field="options",
            )
        )
        return pre.stem, pre.options, issues, None

    stem = pre.stem
    tables: tuple[TableContent, ...] | None = None
    if (
        llm_stem
        and loose_text(llm_stem) == loose_text(pre.stem)
        and _tables(llm_stem) == _tables(pre.stem)
    ):
        stem, tables = corrected_stem, corrected_tables
    else:
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM stem differs from the printed stem; the printed stem was kept.",
                field="stem",
            )
        )
    if not pre.options:
        return stem, pre.options, issues, tables
    if not proposal.options:
        issues.append(
            issue(
                "llm_text_rejected",
                "The LLM dropped printed options; the printed options were kept.",
                field="options",
            )
        )
    elif not (
        keys_ok
        and keys == [k for k, _ in pre.options]
        and all(
            loose_text(o.text) == loose_text(text)
            for o, (_, text) in zip(proposal.options, pre.options, strict=True)
        )
    ):
        issues.append(
            issue(
                "llm_text_rejected",
                "LLM options do not match the printed label-text pairs; "
                "the printed options were kept.",
                field="options",
            )
        )
    return stem, pre.options, issues, tables


def _letters(rows: Sequence[Sequence[str]]) -> str:
    """The printed text of a table in reading order, without spacing and cell boundaries."""
    return loose_text("".join("".join(row) for row in rows))


def _tokens(rows: Sequence[Sequence[str]]) -> Counter[str]:
    """The whitespace-separated tokens of a table: order, cells and pipes do not matter."""
    return Counter(tok for row in rows for cell in row for tok in cell.split())


def _rebuilt_table(old: TableContent, rows: Sequence[Sequence[str]]) -> TableContent:
    """The model's cells as a table. A merged cell of ``old`` stays when it still fits (its
    start cell has text and the cells it covers are empty); its text is repeated again."""
    grid = [list(row) for row in rows]
    spans = []
    if len(grid) == len(old.rows) and len(grid[0]) == len(old.rows[0]):
        for span in old.spans or ():
            start, *covered = span.cells()
            if grid[start[0]][start[1]].strip() and not any(grid[r][c].strip() for r, c in covered):
                spans.append(span)
                for r, c in covered:
                    grid[r][c] = grid[start[0]][start[1]]
    return TableContent(
        rows=tuple(tuple(row) for row in grid),
        header_rows=min(old.header_rows, len(grid)),
        spans=tuple(spans) or None,
    )


def _resolve_tables(
    stem: str, tables: Sequence[TableContent], *, imaged: frozenset[int] = frozenset()
) -> tuple[str, str, tuple[TableContent, ...] | None]:
    """``(restored, corrected, tables)`` for the model's ``stem``.

    ``restored``: each pipe table the model copied (merged cells printed once) or re-celled is
    swapped for the stem's own table (merged text repeated, as the structured cells expect), so
    the text checks compare against the print. ``corrected``: the same stem where a table with the
    printed text in the same order (any order of its tokens when the table's crop was sent, as
    a layout model can read a box's lines in the wrong order) but other cell boundaries (the
    model put a text in the right cell using the image) keeps the model's cells, and
    ``tables`` are the cells of every table in it; ``None`` when nothing was corrected. A table
    with other text is left as the model wrote it, so the printed-text check rejects the stem.
    """
    segments = split_pipe_blocks(stem)
    positions = [i for i, (is_table, _) in enumerate(segments) if is_table]
    if not tables or len(positions) != len(tables):
        return _restore_tables(stem, tables), stem, None
    restored = [text for _, text in segments]
    corrected = list(restored)
    cells = list(tables)
    changed = swapped = False
    for n, (pos, table) in enumerate(zip(positions, tables, strict=True)):
        text = segments[pos][1]
        own = gfm_table(table)
        once = gfm_table(table.model_copy(update={"rows": table.rows_once()}))
        if loose_text(text) in {loose_text(own), loose_text(once)}:
            if table.spans:
                restored[pos] = corrected[pos] = own
                swapped = True
        elif _letters(pipe_table_rows(text)) == _letters(table.rows_once()) or (
            n in imaged and _tokens(pipe_table_rows(text)) == _tokens(table.rows_once())
        ):
            rebuilt = _rebuilt_table(table, pipe_table_rows(text))
            restored[pos], corrected[pos], cells[n] = own, gfm_table(rebuilt), rebuilt
            changed = swapped = True
    if not swapped:
        return stem, stem, None
    return "\n\n".join(restored), "\n\n".join(corrected), tuple(cells) if changed else None


def _restore_tables(stem: str, tables: Sequence[TableContent]) -> str:
    """``stem`` with each pipe table the model saw with merged cells printed once swapped back
    for the stem's own table (the fallback when the table count differs from the stem's)."""
    once = {
        loose_text(gfm_table(t.model_copy(update={"rows": t.rows_once()}))): gfm_table(t)
        for t in tables
        if t.spans
    }
    segments = split_pipe_blocks(stem)
    if not once or not any(is_table and loose_text(text) in once for is_table, text in segments):
        return stem
    return "\n\n".join(
        once.get(loose_text(text), text) if is_table else text for is_table, text in segments
    )


def _tables(stem: str) -> list[str]:
    """The stem's pipe tables without spacing: the same letters on one line are no table."""
    return [loose_text(text) for is_table, text in split_pipe_blocks(stem) if is_table]


def _reproduces(printed: str, stem: str, options: Sequence[tuple[str, str]]) -> bool:
    """Whether ``stem`` followed by each option's printed marker and text is exactly
    ``printed`` (compared without whitespace, NFKC: ``①`` reads as ``1``)."""
    target = loose_text(printed)
    pos = len(loose_text(stem))
    if pos == 0 or not target.startswith(loose_text(stem)):
        return False
    for key, text in options:
        marker = re.compile(rf"\(?{re.escape(key)}[.)]?", re.IGNORECASE)
        match = marker.match(target, pos)
        body = loose_text(text)
        if match is None or not body or not target.startswith(body, match.end()):
            return False
        pos = match.end() + len(body)
    return pos == len(target)


def _llm_answer_matches_key(
    question_type: QuestionType,
    option_labels: Sequence[str] | None,
    text_answers: Sequence[str] | None,
    entries: Sequence[AnswerKeyEntry],
) -> bool:
    if len({e.text for e in entries}) != 1:
        return False
    key_text = entries[0].text
    if question_type is QuestionType.MCQ:
        key_keys = answer_option_keys(key_text)
        if not option_labels or text_answers or key_keys is None:
            return False
        return {canonical_key(label) for label in option_labels} == set(key_keys)
    if not text_answers or option_labels:
        return False
    return all(loose_text(t) and loose_text(t) in loose_text(key_text) for t in text_answers)


# ------------------------------------------------------------------------------------------
# Draft assembly


def _evidence(
    raw: RawQuestion,
    figures: Sequence[RawFigure],
    blocks: Sequence[Block],
    document_id: str,
    revision_id: str | None,
) -> tuple[SourceEvidence, ...]:
    own = [blocks[i] for i in sorted(set(raw.block_indices))]
    evidence = [
        SourceEvidence(
            document_id=document_id,
            revision_id=revision_id,
            block_ids=tuple(b.id for b in own),
            locations=union_locations(own),
        )
    ]
    for figure in figures:
        parts = [b for b in (figure.image, figure.caption.block if figure.caption else None) if b]
        if not parts:
            continue
        evidence.append(
            SourceEvidence(
                document_id=document_id,
                revision_id=revision_id,
                block_ids=tuple(dict.fromkeys(b.id for b in parts)),
                locations=tuple(
                    loc.model_copy(update={"block_id": b.id}) for b in parts for loc in b.locations
                ),
                quote=figure.caption.text if figure.caption is not None else None,
            )
        )
    return tuple(evidence)


def _build_draft(
    candidate: _Candidate, *, draft_id: str, evidence: tuple[SourceEvidence, ...]
) -> QuestionDraft | None:
    if not candidate.stem.strip():
        return None
    options = tuple(
        QuestionOption(id=option_id(k), text=t or "(빈 선택지)") for k, t in candidate.options
    )
    correct = candidate.correct_option_ids
    option_ids = {o.id for o in options}
    if correct is not None and not set(correct) <= option_ids:
        correct = None
    issues = candidate.issues + structural_issues(
        question_type=candidate.question_type,
        options=options,
        correct_option_ids=correct,
        accepted_answers=candidate.accepted_answers,
        evidence=evidence,
        multi_select=candidate.multi_select,
    )
    stem = candidate.stem.strip()
    return QuestionDraft(
        id=draft_id,
        origin=DraftOrigin.PDF_IMPORT,
        question_type=candidate.question_type,
        stem=stem,
        # Against the final stem: a table the LLM rewrote must not keep the printed cells.
        stem_tables=aligned_stem_tables(stem, candidate.stem_tables),
        options=options,
        correct_option_ids=correct,
        accepted_answers=candidate.accepted_answers,
        explanation=candidate.explanation,
        evidence=evidence,
        generator=candidate.generator,
        validations=tuple(_dedupe(issues)),
        review_status=ReviewStatus.PENDING,
    )


def _dedupe(issues: Sequence[ValidationIssue]) -> list[ValidationIssue]:
    return list(dict.fromkeys(issues))


def _document_warnings(
    questions: Sequence[RawQuestion],
    answer_key: Sequence[AnswerKeyEntry],
    unparsed: int,
    ambiguous_tables: int = 0,
) -> list[ValidationIssue]:
    warnings: list[ValidationIssue] = []
    if not questions:
        warnings.append(issue("no_questions_found", "No numbered questions were found."))
        return warnings
    numbers = sorted({q.number for q in questions})
    missing = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers))
    if missing:
        warnings.append(
            issue(
                "question_number_gap",
                "Question numbers are missing: " + ", ".join(map(str, missing)) + ".",
            )
        )
    if not answer_key:
        warnings.append(
            issue("answer_key_missing", "No answer key was found; all answers are empty.")
        )
    unknown = sorted({e.number for e in answer_key} - set(numbers))
    if unknown:
        warnings.append(
            issue(
                "answer_key_unknown_number",
                "The answer key lists numbers without a question: "
                + ", ".join(map(str, unknown))
                + ".",
            )
        )
    if ambiguous_tables:
        warnings.append(
            issue(
                "answer_key_table_ambiguous",
                f"{ambiguous_tables} answer key table(s) can be read row- or column-wise; "
                "no answers were taken from them.",
            )
        )
    if unparsed:
        warnings.append(
            issue(
                "answer_key_unparsed",
                f"{unparsed} answer key line(s) could not be read.",
            )
        )
    return warnings
