"""Pure chapter tree edits (CHMAN-01-C05): the stored parents and order in, every chapter's new
parent, `level` and pre-order `sort_order` out. `apps/web/src/lib/chapters/tree.ts` mirrors the
rules the screen needs to disable a move before sending it.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

MAX_LEVEL = 20


class ChapterTreeError(ValueError):
    """A move that would make a cycle or a tree deeper than `MAX_LEVEL`."""


class UnknownChapterError(LookupError):
    """A move names a chapter that is not in this tree."""


@dataclass(frozen=True)
class TreeNode:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    sort_order: int


@dataclass(frozen=True)
class PlacedNode:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    level: int
    sort_order: int


@dataclass(frozen=True)
class Move:
    chapter_id: uuid.UUID
    parent_id: uuid.UUID | None
    position: int


Children = dict[uuid.UUID | None, list[uuid.UUID]]


def children_of(nodes: Iterable[TreeNode]) -> Children:
    """Each parent's children in stored order (`None` holds the roots)."""
    children: Children = {None: []}
    for node in sorted(nodes, key=lambda n: (n.sort_order, n.id)):
        children.setdefault(node.parent_id, []).append(node.id)
    return children


def _parents(children: Children) -> dict[uuid.UUID, uuid.UUID | None]:
    return {child: parent for parent, ids in children.items() for child in ids}


def _is_within(
    node: uuid.UUID | None,
    subtree_root: uuid.UUID,
    parents: dict[uuid.UUID, uuid.UUID | None],
) -> bool:
    while node is not None:
        if node == subtree_root:
            return True
        node = parents.get(node)
    return False


def apply_moves(children: Children, moves: Sequence[Move]) -> Children:
    """The tree after `moves`, in order. `position` is clamped to the new siblings' length."""
    out: Children = {parent: list(ids) for parent, ids in children.items()}
    for move in moves:
        parents = _parents(out)
        if move.chapter_id not in parents:
            raise UnknownChapterError(str(move.chapter_id))
        if move.parent_id is not None and move.parent_id not in parents:
            raise UnknownChapterError(str(move.parent_id))
        if _is_within(move.parent_id, move.chapter_id, parents):
            raise ChapterTreeError("a chapter cannot move under itself")
        out[parents[move.chapter_id]].remove(move.chapter_id)
        siblings = out.setdefault(move.parent_id, [])
        siblings.insert(min(move.position, len(siblings)), move.chapter_id)
    return out


def append_child(
    children: Children, chapter_id: uuid.UUID, parent_id: uuid.UUID | None
) -> Children:
    out: Children = {parent: list(ids) for parent, ids in children.items()}
    out.setdefault(parent_id, []).append(chapter_id)
    return out


def remove_node(children: Children, chapter_id: uuid.UUID) -> Children:
    """Without the chapter: its children take its place under its parent, in order."""
    parents = _parents(children)
    if chapter_id not in parents:
        raise UnknownChapterError(str(chapter_id))
    parent = parents[chapter_id]
    out: Children = {key: list(ids) for key, ids in children.items() if key != chapter_id}
    at = out[parent].index(chapter_id)
    out[parent][at : at + 1] = children.get(chapter_id, [])
    return out


def flatten(children: Children) -> list[PlacedNode]:
    """Pre-order with `level` = parent + 1 and consecutive `sort_order`. Iterative: the input may
    be as deep as a stored tree, and a cycle cannot be reached from the roots."""
    placed: list[PlacedNode] = []
    stack: list[tuple[uuid.UUID, uuid.UUID | None, int]] = [
        (node, None, 1) for node in reversed(children.get(None, []))
    ]
    while stack:
        node, parent, level = stack.pop()
        if level > MAX_LEVEL:
            raise ChapterTreeError(f"a chapter tree is at most {MAX_LEVEL} levels deep")
        placed.append(PlacedNode(node, parent, level, len(placed)))
        stack.extend((child, node, level + 1) for child in reversed(children.get(node, [])))
    return placed
