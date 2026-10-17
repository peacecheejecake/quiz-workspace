"""Versioned API surface mounted at `/api/v1`.

Feature tasks add their routers here, e.g. `api_router.include_router(workspaces.router)`.
"""

from __future__ import annotations

from fastapi import APIRouter

from quiz_api.api import documents, jobs, me, questions, share_links, workspaces
from quiz_api.errors import problem_responses

API_V1_PREFIX = "/api/v1"

# Every v1 route documents the shared problem shape for auth, not-found and validation errors.
api_router = APIRouter(responses=problem_responses(401, 403, 404, 422))
api_router.include_router(me.router)
api_router.include_router(workspaces.router)
api_router.include_router(documents.router)
api_router.include_router(questions.router)
api_router.include_router(share_links.router)
api_router.include_router(jobs.router)
