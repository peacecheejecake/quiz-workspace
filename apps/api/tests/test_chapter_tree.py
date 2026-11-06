"""CHMAN-01-C05: the tree logic behind every chapter write."""

from __future__ import annotations

import uuid

import pytest
from quiz_api.chapter_tree import (
    MAX_LEVEL,
    ChapterTreeError,
    Children,
    Move,
    TreeNode,
    UnknownChapterError,
    append_child,
    apply_moves,
    children_of,
    flatten,
    remove_node,
)

A, A1, A2, B, B1 = (uuid.UUID(int=n) for n in range(1, 6))


def tree() -> Children:
    """A > (A1, A2), B > B1, stored in pre-order."""
    return children_of(
        [
            TreeNode(B1, B, 4),
            TreeNode(A, None, 0),
            TreeNode(A2, A, 2),
            TreeNode(A1, A, 1),
            TreeNode(B, None, 3),
        ]
    )


def outline(children: Children) -> list[tuple[uuid.UUID, uuid.UUID | None, int, int]]:
    return [(n.id, n.parent_id, n.level, n.sort_order) for n in flatten(children)]


def test_flatten_is_pre_order_with_levels_from_parents() -> None:
    assert outline(tree()) == [
        (A, None, 1, 0),
        (A1, A, 2, 1),
        (A2, A, 2, 2),
        (B, None, 1, 3),
        (B1, B, 2, 4),
    ]


def test_a_gap_in_stored_levels_is_normalized() -> None:
    # Children are level 3 under a level-1 parent in the parser's tree; levels come from depth.
    assert [n.level for n in flatten(children_of([TreeNode(A, None, 0), TreeNode(A1, A, 1)]))] == [
        1,
        2,
    ]


def test_move_reparents_and_recomputes_the_whole_tree() -> None:
    moved = apply_moves(tree(), [Move(A2, B, 0)])
    assert outline(moved) == [
        (A, None, 1, 0),
        (A1, A, 2, 1),
        (B, None, 1, 2),
        (A2, B, 2, 3),
        (B1, B, 2, 4),
    ]


def test_moves_apply_in_order_and_position_is_clamped() -> None:
    moved = apply_moves(tree(), [Move(B1, None, 99), Move(B1, None, 0)])
    assert next(n.id for n in flatten(moved)) == B1


def test_a_subtree_moves_as_a_whole() -> None:
    moved = apply_moves(tree(), [Move(A, B, 1)])
    assert outline(moved) == [
        (B, None, 1, 0),
        (B1, B, 2, 1),
        (A, B, 2, 2),
        (A1, A, 3, 3),
        (A2, A, 3, 4),
    ]


@pytest.mark.parametrize(("chapter", "parent"), [(A, A), (A, A1)])
def test_moving_under_itself_is_refused(chapter: uuid.UUID, parent: uuid.UUID) -> None:
    with pytest.raises(ChapterTreeError):
        apply_moves(tree(), [Move(chapter, parent, 0)])


def test_unknown_ids_are_refused() -> None:
    other = uuid.uuid4()
    with pytest.raises(UnknownChapterError):
        apply_moves(tree(), [Move(other, None, 0)])
    with pytest.raises(UnknownChapterError):
        apply_moves(tree(), [Move(A, other, 0)])


def chain(length: int) -> Children:
    ids = [uuid.UUID(int=100 + n) for n in range(length)]
    parents = [None, *ids[:-1]]
    return children_of(TreeNode(i, p, n) for n, (i, p) in enumerate(zip(ids, parents, strict=True)))


def test_twenty_levels_are_allowed_and_twenty_one_refused() -> None:
    assert flatten(chain(MAX_LEVEL))[-1].level == MAX_LEVEL
    with pytest.raises(ChapterTreeError):
        flatten(chain(MAX_LEVEL + 1))


def test_a_move_past_the_depth_limit_is_refused() -> None:
    deep = chain(MAX_LEVEL)
    deep = append_child(deep, A, None)
    deep = append_child(deep, A1, A)
    with pytest.raises(ChapterTreeError):
        flatten(apply_moves(deep, [Move(A, uuid.UUID(int=100 + MAX_LEVEL - 1), 0)]))


def test_append_adds_a_last_child() -> None:
    new = uuid.uuid4()
    assert [n.id for n in flatten(append_child(tree(), new, A))][:4] == [A, A1, A2, new]
    assert flatten(append_child(tree(), new, None))[-1].id == new


def test_remove_lifts_children_into_its_place() -> None:
    assert outline(remove_node(tree(), A)) == [
        (A1, None, 1, 0),
        (A2, None, 1, 1),
        (B, None, 1, 2),
        (B1, B, 2, 3),
    ]
    with pytest.raises(UnknownChapterError):
        remove_node(tree(), uuid.uuid4())
