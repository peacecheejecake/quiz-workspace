"""UX7-DEDUP grouping and the keep suggestion (docs/questions.md §10.2), without a database."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from quiz_api.api.question_duplicates import duplicate_groups, suggest_keep
from quiz_api.repositories.question_duplicates import CandidateRecord

T0 = datetime(2026, 11, 1, tzinfo=UTC)


def candidate(n: int, stem: str = "같은 문제", **extra: object) -> CandidateRecord:
    values: dict[str, object] = {
        "id": uuid.UUID(int=n),
        "question_type": "MCQ",
        "question_number": n,
        "publication_status": "CONFIRMED",
        "chapter_id": None,
        "chapter_title": None,
        "created_at": T0 + timedelta(minutes=n),
        "revision_id": uuid.UUID(int=1000 + n),
        "revision_version": 1,
        "stem": stem,
        "options": [{"id": "a", "text": "가"}, {"id": "b", "text": "나"}],
        "correct_option_ids": ["a"],
        "accepted_answers": None,
        "rubric": None,
    }
    values.update(extra)
    return CandidateRecord(**values)  # type: ignore[arg-type]


def test_most_graded_attempts_wins() -> None:
    members = [candidate(1), candidate(2), candidate(3)]
    graded = {members[1].id: 1, members[2].id: 4}
    assert suggest_keep(members, graded).id == members[2].id


def test_ties_go_to_the_oldest() -> None:
    members = [candidate(3), candidate(1), candidate(2)]
    assert suggest_keep(members, {}).id == uuid.UUID(int=1)
    tied = {uuid.UUID(int=2): 2, uuid.UUID(int=3): 2}
    assert suggest_keep(members, tied).id == uuid.UUID(int=2)


def test_groups_are_identical_questions_oldest_first() -> None:
    a, b = candidate(2), candidate(1, stem="1. 같은 문제 ( )")
    other = candidate(3, stem="다른 문제")
    assert [[q.id for q in g] for g in duplicate_groups([a, other, b])] == [[b.id, a.id]]


def test_essays_group_by_stem_and_model_answer() -> None:
    def essay(n: int, rubric: str | None) -> CandidateRecord:
        return candidate(
            n, question_type="ESSAY", options=[], correct_option_ids=None, rubric=rubric
        )

    groups = duplicate_groups([essay(1, "모범 답"), essay(2, "모범답."), essay(3, "다른 답")])
    assert [[q.id for q in g] for g in groups] == [[uuid.UUID(int=1), uuid.UUID(int=2)]]
