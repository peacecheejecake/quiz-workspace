"""Chunk-level change detection between two revisions, for incremental re-indexing."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from book_core.contracts import ChunkLevel, SearchChunk


@dataclass(frozen=True, slots=True)
class ChunkDiff:
    """Ids are in the reading order of the side they come from (``removed``: old, else new).

    - ``changed``: same id on both sides, different ``content_hash`` (re-embed / re-index);
    - ``unchanged``: same id and hash; only per-revision payload (``revision_id``, ``ordinal``)
      needs refreshing;
    - ``affected_parent_ids``: new parents that are added or changed, or that contain a child
      that was added, changed or replaced one that was removed; what parent-context consumers
      (reranker, excerpts, generation caches) must refresh.
    """

    added: tuple[str, ...]
    removed: tuple[str, ...]
    changed: tuple[str, ...]
    unchanged: tuple[str, ...]
    affected_parent_ids: tuple[str, ...]

    @property
    def reindex_ids(self) -> tuple[str, ...]:
        """New-side chunks whose index entries must be (re)written."""
        return (*self.added, *self.changed)

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed or self.changed)


def diff_chunks(old: Sequence[SearchChunk], new: Sequence[SearchChunk]) -> ChunkDiff:
    """Compare two chunk sets (parents and children mixed) by stable id and content hash."""
    before = {c.id: c for c in old}
    after = {c.id: c for c in new}
    added = tuple(c.id for c in new if c.id not in before)
    removed = tuple(c.id for c in old if c.id not in after)
    changed = tuple(
        c.id for c in new if c.id in before and before[c.id].content_hash != c.content_hash
    )
    touched = set(added) | set(changed)

    affected: set[str] = set()
    for chunk in new:
        if chunk.id not in touched:
            continue
        if chunk.level is ChunkLevel.PARENT:
            affected.add(chunk.id)
        elif chunk.parent_id is not None:
            affected.add(chunk.parent_id)
    removed_children = {
        before[cid].parent_id
        for cid in removed
        if before[cid].level is ChunkLevel.CHILD and before[cid].parent_id is not None
    }
    affected.update(pid for pid in removed_children if pid in after)
    return ChunkDiff(
        added=added,
        removed=removed,
        changed=changed,
        unchanged=tuple(c.id for c in new if c.id in before and c.id not in touched),
        affected_parent_ids=tuple(
            c.id for c in new if c.level is ChunkLevel.PARENT and c.id in affected
        ),
    )
