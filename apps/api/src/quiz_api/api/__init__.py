"""Versioned API surface mounted at `/api/v1`.

Feature tasks add their routers here, e.g. `api_router.include_router(workspaces.router)`.
"""

from __future__ import annotations

from fastapi import APIRouter

from quiz_api.api import (
    chapter_notes,
    chapter_redistribution,
    document_export,
    document_revisions,
    document_summaries,
    documents,
    forks,
    highlights,
    history,
    jobs,
    me,
    mock_exams,
    mock_practice,
    practice,
    practice_runs,
    question_duplicates,
    question_imports,
    question_overview,
    question_previews,
    questions,
    search,
    share_links,
    shared,
    shared_chapter_notes,
    workspaces,
)
from quiz_api.errors import problem_responses

API_V1_PREFIX = "/api/v1"

# Every v1 route documents the shared problem shape for auth, not-found and validation errors.
api_router = APIRouter(responses=problem_responses(401, 403, 404, 422))
api_router.include_router(me.router)
api_router.include_router(workspaces.router)
api_router.include_router(documents.router)
api_router.include_router(document_revisions.router)
api_router.include_router(document_export.router)
api_router.include_router(document_summaries.router)
api_router.include_router(search.router)
api_router.include_router(questions.router)
api_router.include_router(question_overview.router)
api_router.include_router(question_duplicates.router)
api_router.include_router(chapter_redistribution.router)
api_router.include_router(question_imports.router)
api_router.include_router(practice.router)
api_router.include_router(practice_runs.router)
api_router.include_router(share_links.router)
api_router.include_router(shared.router)
api_router.include_router(forks.router)
api_router.include_router(jobs.router)
api_router.include_router(history.router)
api_router.include_router(chapter_notes.router)
api_router.include_router(shared_chapter_notes.router)
api_router.include_router(question_previews.router)
api_router.include_router(question_previews.shared_router)
api_router.include_router(mock_exams.router)
api_router.include_router(mock_practice.router)
api_router.include_router(highlights.router)
