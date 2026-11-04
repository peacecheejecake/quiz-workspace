"""Re-match the chapters the matcher left empty (CHAP-MATCH, docs/questions.md §14.4).

When a book becomes ready, registered questions whose chapter is empty (or only the question
paper's own fallback chapter) and was decided by the matcher (`chapter_source = auto`) are matched
again exactly like the redistribution preview (`recommend`, book chapters first, then the paper's
top-level chapter). A chapter a person set or changed (`manual`) is never touched. Idempotent: a
second run finds nothing to move. Lock order of every question write: documents, then questions.
"""

from __future__ import annotations

import uuid

from quiz_api.chapter_matching import ChapterMatcher, recommend
from quiz_api.repositories.chapter_redistribution import ChapterRedistributionRepository
from quiz_api.repositories.questions import QuestionRepository


def rematch_empty_chapters(
    repo: ChapterRedistributionRepository,
    questions: QuestionRepository,
    workspace_id: uuid.UUID,
    actor_id: uuid.UUID,
) -> int:
    """Move the eligible questions of this workspace to their recommended chapter; returns how
    many moved. The caller commits."""
    candidates = repo.rematch_candidates(workspace_id)
    if not candidates:
        return 0
    starts = repo.start_blocks(workspace_id, [q for q, _ in candidates])
    matcher = ChapterMatcher(repo.book_chapters(workspace_id))
    plan: dict[uuid.UUID, tuple[uuid.UUID | None, uuid.UUID]] = {}
    for question_id, current in candidates:
        found = recommend(starts.get(question_id), matcher)
        if found.chapter is None or found.chapter.id == current:
            continue
        if current is not None and found.reason == "paper_chapter":
            continue  # already under a paper chapter: a fallback never replaces it
        plan[question_id] = (current, found.chapter.id)
    if not plan:
        return 0
    targets = {to for _, to in plan.values()}
    expected = {frm for frm, _ in plan.values() if frm is not None}
    questions.lock_documents(workspace_id, chapter_ids=[*targets, *expected])
    locked = repo.lock_questions(workspace_id, list(plan))
    valid = {t.id for t in repo.target_chapters(workspace_id, targets).values() if t.valid}
    moves = [
        (qid, frm, to)
        for qid, (frm, to) in plan.items()
        if qid in locked
        and locked[qid].publication_status == "CONFIRMED"
        and locked[qid].chapter_source == "auto"
        and locked[qid].chapter_id == frm
        and to in valid
    ]
    questions.set_chapter(
        workspace_id,
        moves,
        chapter_source="auto",
        change_source="recommendation",
        actor_id=actor_id,
    )
    return len(moves)
