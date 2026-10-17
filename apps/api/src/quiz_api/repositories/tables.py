"""SQLAlchemy Core descriptions of the tables the API reads (subset of the columns).

These mirror `supabase/migrations`; they are never used to create or alter the schema.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, MetaData, Table, Text, Uuid
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

metadata = MetaData(schema="public")

profiles = Table(
    "profiles",
    metadata,
    Column("user_id", Uuid, primary_key=True),
    Column("display_name", Text),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

workspaces = Table(
    "workspaces",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("name", Text, nullable=False),
    Column("owner_id", Uuid, nullable=False),
    Column("status", Text, nullable=False),
    Column("archived_at", DateTime(timezone=True)),
    Column("deleted_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

workspace_memberships = Table(
    "workspace_memberships",
    metadata,
    Column("workspace_id", Uuid, primary_key=True),
    Column("user_id", Uuid, primary_key=True),
    Column("role", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

async_jobs = Table(
    "async_jobs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("created_by", Uuid),
    Column("job_type", Text, nullable=False),
    Column("status", Text, nullable=False),
)


# --- M4.1 question domain (20261017180000_question_domain.sql) --------------------------------
# Document-side ids (chapter_id, document_id, document_revision_id) get their FK from M3.2a.


def _ts(name: str, *, nullable: bool = True) -> Column[datetime]:
    return Column(name, DateTime(timezone=True), nullable=nullable)


questions = Table(
    "questions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("chapter_id", Uuid),
    Column("question_type", Text, nullable=False),
    Column("origin", Text, nullable=False),
    Column("question_number", Integer),
    Column("sort_order", Integer, nullable=False),
    Column("active_revision_id", Uuid),
    Column("publication_status", Text, nullable=False),
    Column("created_by", Uuid),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("deleted_at"),
)

question_revisions = Table(
    "question_revisions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("question_id", Uuid, nullable=False),
    Column("version", Integer, nullable=False),
    Column("stem", Text, nullable=False),
    Column("options", JSONB, nullable=False),
    Column("correct_option_ids", ARRAY(Text)),
    Column("accepted_answers", ARRAY(Text)),
    Column("is_multi_answer", Boolean, nullable=False),
    Column("explanation", Text),
    Column("rubric", Text),
    Column("created_by", Uuid),
    _ts("created_at", nullable=False),
)

question_sources = Table(
    "question_sources",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("question_id", Uuid, nullable=False),
    Column("document_id", Uuid),
    Column("document_revision_id", Uuid),
    Column("page_start", Integer),
    Column("page_end", Integer),
    Column("block_ids", ARRAY(Text), nullable=False),
    Column("locations", JSONB, nullable=False),
    Column("import_run_id", Uuid),
    _ts("created_at", nullable=False),
)

question_user_states = Table(
    "question_user_states",
    metadata,
    Column("user_id", Uuid, primary_key=True),
    Column("question_id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    _ts("first_viewed_at"),
    _ts("last_viewed_at"),
    Column("last_graded_result", Text),
    Column("last_graded_attempt_id", Uuid),
    Column("is_favorite", Boolean, nullable=False),
    Column("needs_retry", Boolean, nullable=False),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)

practice_sessions = Table(
    "practice_sessions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("question_id", Uuid, nullable=False),
    Column("question_revision_id", Uuid, nullable=False),
    Column("user_id", Uuid, nullable=False),
    Column("displayed_option_ids", ARRAY(Text), nullable=False),
    Column("shuffle_seed", BigInteger),
    Column("state", Text, nullable=False),
    _ts("opened_at", nullable=False),
    _ts("submitted_at"),
    _ts("graded_at"),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)

question_attempts = Table(
    "question_attempts",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("question_id", Uuid, nullable=False),
    Column("question_revision_id", Uuid, nullable=False),
    Column("practice_session_id", Uuid, nullable=False),
    Column("user_id", Uuid, nullable=False),
    Column("displayed_option_ids", ARRAY(Text), nullable=False),
    Column("submitted_answer", JSONB, nullable=False),
    Column("result", Text, nullable=False),
    Column("grading_method", Text),
    Column("grades_attempt_id", Uuid),
    Column("graded_by", Uuid),
    _ts("submitted_at", nullable=False),
    _ts("graded_at"),
)

question_lineage = Table(
    "question_lineage",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("parent_question_id", Uuid, nullable=False),
    Column("child_question_id", Uuid, nullable=False),
    Column("source_question_revision_id", Uuid, nullable=False),
    Column("variation_type", Text, nullable=False),
    Column("generation_run_id", Uuid),
    Column("draft_id", Uuid),
    Column("llm_model", Text),
    Column("prompt_version", Text),
    Column("source_block_ids", ARRAY(Text), nullable=False),
    _ts("created_at", nullable=False),
)

question_generation_runs = Table(
    "question_generation_runs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("created_by", Uuid),
    Column("source_question_id", Uuid, nullable=False),
    Column("source_question_revision_id", Uuid, nullable=False),
    Column("variation_types", ARRAY(Text), nullable=False),
    Column("candidate_count", Integer, nullable=False),
    Column("async_job_id", Uuid),
    Column("status", Text, nullable=False),
    Column("llm_model", Text),
    Column("prompt_version", Text),
    Column("params", JSONB, nullable=False),
    _ts("finished_at"),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)

question_import_runs = Table(
    "question_import_runs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("created_by", Uuid),
    Column("source_document_id", Uuid),
    Column("source_document_revision_id", Uuid),
    Column("target_chapter_id", Uuid),
    Column("async_job_id", Uuid),
    Column("status", Text, nullable=False),
    Column("llm_model", Text),
    Column("prompt_version", Text),
    Column("params", JSONB, nullable=False),
    _ts("finished_at"),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)

question_drafts = Table(
    "question_drafts",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("workspace_id", Uuid, nullable=False),
    Column("source_type", Text, nullable=False),
    Column("generation_run_id", Uuid),
    Column("import_run_id", Uuid),
    Column("position", Integer, nullable=False),
    Column("question_type", Text, nullable=False),
    Column("payload", JSONB, nullable=False),
    Column("validations", JSONB, nullable=False),
    Column("review_status", Text, nullable=False),
    Column("reviewed_by", Uuid),
    _ts("reviewed_at"),
    Column("published_question_id", Uuid),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)
