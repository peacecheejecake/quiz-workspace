"""The chapter each import draft is registered under (CHAPTER-MAP, QIMPORT-01-AC08).

A draft the reviewer has not touched (`chapter_manual = false`) gets the suggestion of
`quiz_api.chapter_matching`, recomputed on every read from the current books of the workspace (a
book uploaded after the import is matched too). A reviewer's choice (`chapter_manual = true`,
`chapter_id` or none) wins and is resolved to the same section of its book's current revision.
Registration (publish and the registration job) uses exactly what the review screen shows.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from quiz_api.chapter_matching import BookChapter, ChapterMatch, ChapterMatcher
from quiz_api.repositories.draft_chapters import DraftChapterRepository, SourceRef
from quiz_api.repositories.question_imports import DraftRecord

ChapterChoice = Literal["auto", "manual"]


@dataclass(frozen=True)
class DraftChapter:
    chapter: BookChapter | None
    choice: ChapterChoice
    # Why (auto only): matched / no_match / ambiguous / no_source_chapter.
    match: ChapterMatch | None
    # The question PDF chapter the suggestion was made from (auto only).
    source_title: str | None


def source_ref(payload: Mapping[str, Any]) -> SourceRef:
    """The draft's first source block (else its first page) in the question PDF."""
    evidence = payload.get("evidence")
    if not isinstance(evidence, list) or not evidence or not isinstance(evidence[0], dict):
        return SourceRef(None, None)
    first = evidence[0]
    blocks = first.get("block_ids")
    locations = first.get("locations")
    location = locations[0] if isinstance(locations, list) and locations else None
    block_id: str | None = None
    if isinstance(blocks, list) and blocks and isinstance(blocks[0], str):
        block_id = blocks[0]
    elif isinstance(location, dict) and isinstance(location.get("block_id"), str):
        block_id = location["block_id"]
    page = location.get("page") if isinstance(location, dict) else None
    return SourceRef(block_id, page if isinstance(page, int) else None)


def draft_chapters(
    repo: DraftChapterRepository,
    workspace_id: uuid.UUID,
    revision_id: uuid.UUID | None,
    drafts: Sequence[DraftRecord],
) -> dict[uuid.UUID, DraftChapter]:
    """Chapter of each import draft (generation drafts are left out)."""
    imports = [d for d in drafts if d.source_type == "import"]
    manual = [d for d in imports if d.chapter_manual]
    auto = [d for d in imports if not d.chapter_manual]
    out: dict[uuid.UUID, DraftChapter] = {}
    if manual:
        current = repo.current_book_chapters(
            workspace_id, [d.chapter_id for d in manual if d.chapter_id is not None]
        )
        for d in manual:
            chosen = current.get(d.chapter_id) if d.chapter_id is not None else None
            out[d.id] = DraftChapter(chosen, "manual", None, None)
    if auto:
        matcher = ChapterMatcher(repo.book_chapters(workspace_id))
        chains = (
            repo.source_chains(
                workspace_id, revision_id, {d.id: source_ref(d.payload) for d in auto}
            )
            if revision_id is not None
            else {}
        )
        for d in auto:
            found = matcher.suggest(chains.get(d.id, []))
            out[d.id] = DraftChapter(found.chapter, "auto", found.match, found.source_title)
    return out
