-- M4.1 question domain: questions, immutable revisions, sources, per-user study state, practice
-- sessions, immutable attempts, lineage, generation/import runs and isolated drafts.
--
-- Sources: docs/architecture.md §5–6, docs/questions.md §2 (publication_status vs. user state),
-- §4 (stable option ids, PENDING self-grade, immutable attempts), §5 (lineage/generation
-- provenance), §6 (import provenance), docs/workspace-sharing.md §4 (forks remap every id and never
-- copy drafts/user state/attempts), docs/auth.md §4 (user_id is injected by the API).
--
-- Security model is the baseline's (20261017120000): RLS on every table, no anon/authenticated
-- grants or policies, quiz_api gets the minimal grants listed at the bottom. History tables
-- (question_revisions, question_attempts, question_lineage) are append-only for quiz_api.
--
-- Workspace integrity: every child row carries `workspace_id` and references its parent through a
-- composite FK that includes it, so a source/attempt/lineage/draft row can never point at a
-- question, revision or run of another workspace even if the API passed a wrong id.
--
-- Document-side references (M3.2a owns documents, document_revisions, chapters, content_blocks):
-- `questions.chapter_id`, `question_sources.document_id/document_revision_id` and the import run's
-- document columns are plain nullable uuids here. M3.2a adds the FK constraints in its own
-- migration once those tables exist, as composite `(workspace_id, <col>)` FKs to
-- `(workspace_id, id)` uniques on its tables. Content block ids are opaque text (book_core
-- `Identifier`), stored as text[] without FK.
--
-- Hard deletes: questions are soft-deleted (`deleted_at`); quiz_api has no DELETE on them. Child
-- rows cascade only when the workspace itself is hard-deleted by an operator. References that
-- record history (lineage, runs, drafts -> questions/revisions) use NO ACTION, so a stray
-- hard delete of a single question that has history fails instead of erasing it.

-- ---------------------------------------------------------------------------------------------
-- Validation helpers (immutable, used by CHECK constraints; CHECKs cannot hold subqueries).
-- ---------------------------------------------------------------------------------------------

-- MCQ options: a JSON array of objects {"id": <opaque id>, "text": <non-blank>}, ids unique
-- within the array. Grading compares these ids (questions.md §4), so uniqueness is enforced by
-- the database rather than left to every writer.
create function public.question_options_valid(options jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when options is null or pg_catalog.jsonb_typeof(options) <> 'array' then false
    when pg_catalog.jsonb_array_length(options) > 50 then false
    else not exists (
           select 1
             from pg_catalog.jsonb_array_elements(options) as e(item)
            where pg_catalog.jsonb_typeof(e.item) <> 'object'
               or pg_catalog.jsonb_typeof(e.item -> 'id') is distinct from 'string'
               or pg_catalog.jsonb_typeof(e.item -> 'text') is distinct from 'string'
               or (e.item ->> 'id') !~ '^\S+$'
               or pg_catalog.char_length(e.item ->> 'id') > 256
               or pg_catalog.btrim(e.item ->> 'text') = ''
               or pg_catalog.char_length(e.item ->> 'text') > 5000
         )
         and (select pg_catalog.count(distinct e.item ->> 'id') = pg_catalog.count(*)
                from pg_catalog.jsonb_array_elements(options) as e(item))
  end
$$;

-- A list of non-null, distinct opaque ids (displayed option order, correct option ids).
create function public.question_ids_valid(ids text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select ids is not null
     and (pg_catalog.cardinality(ids) = 0 or pg_catalog.array_ndims(ids) = 1)
     and pg_catalog.cardinality(ids) <= 1000
     and not exists (select 1 from pg_catalog.unnest(ids) as u(id) where u.id is null
                       or u.id !~ '^\S+$' or pg_catalog.char_length(u.id) > 256)
     and (select pg_catalog.count(distinct u.id) = pg_catalog.count(*)
            from pg_catalog.unnest(ids) as u(id))
$$;

-- Correct option ids: unknown (null) or a non-empty set of distinct ids that all exist in options.
create function public.question_correct_options_valid(options jsonb, correct_option_ids text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select correct_option_ids is null
      or (pg_catalog.cardinality(correct_option_ids) >= 1
          and public.question_ids_valid(correct_option_ids)
          and pg_catalog.jsonb_typeof(options) = 'array'
          and correct_option_ids operator(pg_catalog.<@) array(
                select e.item ->> 'id' from pg_catalog.jsonb_array_elements(options) as e(item)))
$$;

-- Accepted short answers: unknown (null) or 1..50 non-blank strings.
create function public.question_text_items_valid(items text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select items is null
      or (pg_catalog.cardinality(items) between 1 and 50
          and pg_catalog.array_ndims(items) = 1
          and not exists (select 1 from pg_catalog.unnest(items) as u(item)
                           where u.item is null or pg_catalog.btrim(u.item) = ''
                              or pg_catalog.char_length(u.item) > 1000))
$$;

revoke all on function public.question_options_valid(jsonb) from public, anon, authenticated;
revoke all on function public.question_ids_valid(text[]) from public, anon, authenticated;
revoke all on function public.question_correct_options_valid(jsonb, text[])
  from public, anon, authenticated;
revoke all on function public.question_text_items_valid(text[]) from public, anon, authenticated;
-- CHECK constraints run their functions with the privileges of the writing role.
grant execute on function public.question_options_valid(jsonb) to quiz_api;
grant execute on function public.question_ids_valid(text[]) to quiz_api;
grant execute on function public.question_correct_options_valid(jsonb, text[]) to quiz_api;
grant execute on function public.question_text_items_valid(text[]) to quiz_api;

-- ---------------------------------------------------------------------------------------------
-- questions: the bank entry. Content lives in question_revisions; `active_revision_id` points at
-- the current one. publication_status (DRAFT/CONFIRMED/ARCHIVED) is independent of per-user
-- study state (question_user_states). Overview shows CONFIRMED, non-deleted questions only.
-- Generated/imported candidates are NOT questions until approved: they live in question_drafts.
-- ---------------------------------------------------------------------------------------------
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- FK to chapters added by M3.2a.
  chapter_id uuid,
  question_type text not null,
  -- How the question entered the bank; forks copy the value.
  origin text not null default 'manual',
  -- Display number (e.g. "12" in "3장 12번"); optional, not unique (imports may repeat numbers).
  question_number integer,
  -- Position inside the chapter; ties fall back to (created_at, id).
  sort_order integer not null default 0,
  active_revision_id uuid,
  publication_status text not null default 'DRAFT',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint questions_workspace_id_id_key unique (workspace_id, id),
  constraint questions_question_type_valid
    check (question_type in ('MCQ', 'SHORT_ANSWER', 'ESSAY')),
  constraint questions_origin_valid check (origin in ('manual', 'import', 'generation')),
  constraint questions_question_number_positive
    check (question_number is null or question_number > 0),
  constraint questions_publication_status_valid
    check (publication_status in ('DRAFT', 'CONFIRMED', 'ARCHIVED')),
  -- A confirmed (or archived, i.e. once confirmed) question always has content.
  constraint questions_published_has_revision
    check (publication_status = 'DRAFT' or active_revision_id is not null)
);

-- Overview / bank listing: CONFIRMED questions of a workspace in chapter order.
create index questions_overview_idx
  on public.questions (workspace_id, publication_status, chapter_id, sort_order, created_at, id)
  where deleted_at is null;
create index questions_chapter_id_idx on public.questions (chapter_id) where chapter_id is not null;
create index questions_created_by_idx on public.questions (created_by);

create trigger questions_set_updated_at
  before update on public.questions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_revisions: immutable content snapshots. Editing a question inserts a new version and
-- moves questions.active_revision_id; attempts keep pointing at the revision they were graded
-- against, so historical grading is reproducible (questions.md §4.8).
--   options             MCQ options [{id, text}], stable ids (empty for SHORT_ANSWER/ESSAY)
--   correct_option_ids  MCQ answer as option ids (null = unknown, e.g. import without key)
--   accepted_answers    SHORT_ANSWER accepted answers (null = not auto-gradable)
--   is_multi_answer     MCQ multiple selection
-- Type-specific completeness (e.g. CONFIRMED MCQ needs an answer) is validated by the API.
-- ---------------------------------------------------------------------------------------------
create table public.question_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  version integer not null,
  stem text not null,
  options jsonb not null default '[]'::jsonb,
  correct_option_ids text[],
  accepted_answers text[],
  is_multi_answer boolean not null default false,
  explanation text,
  rubric text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint question_revisions_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_revisions_question_version_key unique (question_id, version),
  constraint question_revisions_workspace_question_id_key unique (workspace_id, question_id, id),
  constraint question_revisions_version_positive check (version >= 1),
  constraint question_revisions_stem_length
    check (btrim(stem) <> '' and char_length(stem) <= 20000),
  constraint question_revisions_options_valid check (public.question_options_valid(options)),
  constraint question_revisions_correct_options_valid
    check (public.question_correct_options_valid(options, correct_option_ids)),
  constraint question_revisions_single_answer
    check (is_multi_answer or correct_option_ids is null or cardinality(correct_option_ids) = 1),
  constraint question_revisions_accepted_answers_valid
    check (public.question_text_items_valid(accepted_answers)),
  constraint question_revisions_explanation_length
    check (explanation is null or char_length(explanation) <= 20000),
  constraint question_revisions_rubric_length
    check (rubric is null or char_length(rubric) <= 20000)
);

create index question_revisions_created_by_idx on public.question_revisions (created_by);

-- active_revision_id must be a revision of the same question (and workspace).
alter table public.questions
  add constraint questions_active_revision_fk
  foreign key (workspace_id, id, active_revision_id)
  references public.question_revisions (workspace_id, question_id, id);

-- ---------------------------------------------------------------------------------------------
-- async_jobs (workspace_id, id): target of the runs' workspace-scoped job FKs. Additive; id is
-- already the primary key, so this never rejects an existing row.
-- ---------------------------------------------------------------------------------------------
create unique index async_jobs_workspace_id_id_key on public.async_jobs (workspace_id, id);

-- ---------------------------------------------------------------------------------------------
-- question_import_runs: one question-PDF import (questions.md §6). Document columns get their FK
-- from M3.2a. Model/prompt are recorded for provenance; the job row carries retries/errors.
-- ---------------------------------------------------------------------------------------------
create table public.question_import_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  -- FKs to documents / document_revisions / chapters added by M3.2a.
  source_document_id uuid,
  source_document_revision_id uuid,
  target_chapter_id uuid,
  async_job_id uuid,
  status text not null default 'queued',
  llm_model text,
  prompt_version text,
  params jsonb not null default '{}'::jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint question_import_runs_workspace_id_id_key unique (workspace_id, id),
  -- The job must belong to the run's workspace; losing the job only clears the reference.
  constraint question_import_runs_async_job_fk foreign key (workspace_id, async_job_id)
    references public.async_jobs (workspace_id, id) on delete set null (async_job_id),
  constraint question_import_runs_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint question_import_runs_finished_iff_terminal
    check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)),
  constraint question_import_runs_llm_model_length
    check (llm_model is null or char_length(llm_model) between 1 and 200),
  constraint question_import_runs_prompt_version_length
    check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  constraint question_import_runs_params_object check (jsonb_typeof(params) = 'object'),
  constraint question_import_runs_params_size check (pg_column_size(params) <= 8192)
);

create index question_import_runs_workspace_created_idx
  on public.question_import_runs (workspace_id, created_at desc);
create index question_import_runs_created_by_idx on public.question_import_runs (created_by);
create index question_import_runs_async_job_idx
  on public.question_import_runs (workspace_id, async_job_id) where async_job_id is not null;

create trigger question_import_runs_set_updated_at
  before update on public.question_import_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_generation_runs: variant generation from one CONFIRMED question revision
-- (questions.md §5). OPTION_SHUFFLE never creates a run: it is a practice-session concern.
-- ---------------------------------------------------------------------------------------------
create table public.question_generation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  source_question_id uuid not null,
  source_question_revision_id uuid not null,
  variation_types text[] not null,
  candidate_count integer not null default 1,
  async_job_id uuid,
  status text not null default 'queued',
  llm_model text,
  prompt_version text,
  -- Optional target chapter/difficulty and similar knobs; never secrets.
  params jsonb not null default '{}'::jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint question_generation_runs_workspace_id_id_key unique (workspace_id, id),
  constraint question_generation_runs_async_job_fk foreign key (workspace_id, async_job_id)
    references public.async_jobs (workspace_id, id) on delete set null (async_job_id),
  constraint question_generation_runs_source_revision_fk
    foreign key (workspace_id, source_question_id, source_question_revision_id)
    references public.question_revisions (workspace_id, question_id, id),
  constraint question_generation_runs_variation_types_valid check (
    cardinality(variation_types) between 1 and 3
    and variation_types <@ array['PARAPHRASE', 'INVERT_POLARITY', 'ANALOGOUS_CONCEPT']::text[]
  ),
  constraint question_generation_runs_candidate_count_range
    check (candidate_count between 1 and 20),
  constraint question_generation_runs_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint question_generation_runs_finished_iff_terminal
    check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)),
  constraint question_generation_runs_llm_model_length
    check (llm_model is null or char_length(llm_model) between 1 and 200),
  constraint question_generation_runs_prompt_version_length
    check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  constraint question_generation_runs_params_object check (jsonb_typeof(params) = 'object'),
  constraint question_generation_runs_params_size check (pg_column_size(params) <= 8192)
);

create index question_generation_runs_workspace_created_idx
  on public.question_generation_runs (workspace_id, created_at desc);
create index question_generation_runs_source_idx
  on public.question_generation_runs (workspace_id, source_question_id, source_question_revision_id);
create index question_generation_runs_created_by_idx
  on public.question_generation_runs (created_by);
create index question_generation_runs_async_job_idx
  on public.question_generation_runs (workspace_id, async_job_id) where async_job_id is not null;

create trigger question_generation_runs_set_updated_at
  before update on public.question_generation_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_drafts: generated/imported candidates awaiting human review. Isolated from questions:
-- nothing that references a question (user state, sessions, attempts, lineage child) can point at
-- a draft, and a draft becomes a question only when the API publishes an approved draft, which
-- records `published_question_id`. Drafts are workspace-private and never forked.
--   payload       book_core QuestionDraft (schema_version 1), including lineage/provenance
--   validations   ValidationIssue[]; error-level issues block approval (enforced by the API)
-- ---------------------------------------------------------------------------------------------
create table public.question_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_type text not null,
  generation_run_id uuid,
  import_run_id uuid,
  position integer not null default 0,
  question_type text not null,
  payload jsonb not null,
  validations jsonb not null default '[]'::jsonb,
  review_status text not null default 'pending',
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  published_question_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint question_drafts_workspace_id_id_key unique (workspace_id, id),
  constraint question_drafts_generation_run_fk foreign key (workspace_id, generation_run_id)
    references public.question_generation_runs (workspace_id, id) on delete cascade,
  constraint question_drafts_import_run_fk foreign key (workspace_id, import_run_id)
    references public.question_import_runs (workspace_id, id) on delete cascade,
  constraint question_drafts_published_question_fk foreign key (workspace_id, published_question_id)
    references public.questions (workspace_id, id),
  constraint question_drafts_published_question_key unique (published_question_id),
  constraint question_drafts_source_type_valid check (source_type in ('generation', 'import')),
  constraint question_drafts_source_run_matches check (
    (source_type = 'generation' and generation_run_id is not null and import_run_id is null)
    or (source_type = 'import' and import_run_id is not null and generation_run_id is null)
  ),
  constraint question_drafts_position_non_negative check (position >= 0),
  constraint question_drafts_question_type_valid
    check (question_type in ('MCQ', 'SHORT_ANSWER', 'ESSAY')),
  constraint question_drafts_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint question_drafts_payload_size check (pg_column_size(payload) <= 262144),
  constraint question_drafts_validations_array check (jsonb_typeof(validations) = 'array'),
  constraint question_drafts_validations_size check (pg_column_size(validations) <= 65536),
  constraint question_drafts_review_status_valid
    check (review_status in ('pending', 'approved', 'rejected')),
  constraint question_drafts_reviewed_at_iff_reviewed
    check ((review_status = 'pending') = (reviewed_at is null)),
  constraint question_drafts_published_only_if_approved
    check (published_question_id is null or review_status = 'approved')
);

create index question_drafts_generation_run_idx
  on public.question_drafts (generation_run_id, position) where generation_run_id is not null;
create index question_drafts_import_run_idx
  on public.question_drafts (import_run_id, position) where import_run_id is not null;
create index question_drafts_reviewed_by_idx on public.question_drafts (reviewed_by);

create trigger question_drafts_set_updated_at
  before update on public.question_drafts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_sources: where a question comes from / what justifies its answer. Generation evidence
-- (source passages) and import provenance (page/area of the question PDF) both land here.
--   locations  SourceLocation[] ({page, bbox?, block_id?})
-- ---------------------------------------------------------------------------------------------
create table public.question_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  -- FKs to documents / document_revisions added by M3.2a.
  document_id uuid,
  document_revision_id uuid,
  page_start integer,
  page_end integer,
  block_ids text[] not null default '{}',
  locations jsonb not null default '[]'::jsonb,
  import_run_id uuid,
  created_at timestamptz not null default now(),
  constraint question_sources_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_sources_import_run_fk foreign key (workspace_id, import_run_id)
    references public.question_import_runs (workspace_id, id),
  constraint question_sources_page_range check (
    (page_start is null and page_end is null)
    or (page_start is not null and page_end is not null
        and page_start >= 1 and page_end >= page_start)
  ),
  constraint question_sources_block_ids_valid check (public.question_ids_valid(block_ids)),
  constraint question_sources_locations_array check (jsonb_typeof(locations) = 'array'),
  constraint question_sources_locations_size check (pg_column_size(locations) <= 32768)
);

create index question_sources_question_idx on public.question_sources (workspace_id, question_id);
create index question_sources_document_idx
  on public.question_sources (document_id) where document_id is not null;
create index question_sources_import_run_idx
  on public.question_sources (import_run_id) where import_run_id is not null;

-- ---------------------------------------------------------------------------------------------
-- practice_sessions: one opening of a question in the practice panel (questions.md §4). Pins the
-- revision and the displayed option order (stable ids) so grading never depends on position.
--   state  open -> graded              (auto-graded on submit)
--          open -> pending_grade -> graded   (ESSAY / non-auto SHORT_ANSWER, self/reviewer grade)
-- user_id comes from the verified JWT only (auth.md §4).
-- ---------------------------------------------------------------------------------------------
create table public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  question_revision_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  displayed_option_ids text[] not null default '{}',
  shuffle_seed bigint,
  state text not null default 'open',
  opened_at timestamptz not null default now(),
  submitted_at timestamptz,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint practice_sessions_revision_fk
    foreign key (workspace_id, question_id, question_revision_id)
    references public.question_revisions (workspace_id, question_id, id) on delete cascade,
  constraint practice_sessions_attempt_ref_key unique (id, user_id, question_revision_id),
  constraint practice_sessions_displayed_option_ids_valid
    check (public.question_ids_valid(displayed_option_ids)),
  constraint practice_sessions_state_valid check (state in ('open', 'pending_grade', 'graded')),
  constraint practice_sessions_state_timestamps check (
    (state = 'open' and submitted_at is null and graded_at is null)
    or (state = 'pending_grade' and submitted_at is not null and graded_at is null)
    or (state = 'graded' and submitted_at is not null and graded_at is not null)
  )
);

create index practice_sessions_user_question_idx
  on public.practice_sessions (user_id, question_id, opened_at desc);
create index practice_sessions_revision_idx
  on public.practice_sessions (workspace_id, question_id, question_revision_id);

create trigger practice_sessions_set_updated_at
  before update on public.practice_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_attempts: immutable grading history (quiz_api may only INSERT/SELECT).
--   submit, auto-gradable   -> one row, result correct|incorrect, grading_method auto
--   submit, not gradable    -> one row, result pending, grading_method null, graded_at null
--   self/reviewer grade     -> a NEW row with result correct|incorrect, grading_method
--                              self|reviewer and `grades_attempt_id` = the pending row; a pending
--                              row is graded at most once. The pending row itself never changes.
-- The API must only point grades_attempt_id at a `pending` row (not expressible as an FK).
-- ---------------------------------------------------------------------------------------------
create table public.question_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  question_revision_id uuid not null,
  practice_session_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  displayed_option_ids text[] not null default '{}',
  submitted_answer jsonb not null,
  result text not null,
  grading_method text,
  grades_attempt_id uuid,
  graded_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz not null default now(),
  graded_at timestamptz,
  constraint question_attempts_revision_fk
    foreign key (workspace_id, question_id, question_revision_id)
    references public.question_revisions (workspace_id, question_id, id) on delete cascade,
  constraint question_attempts_session_fk
    foreign key (practice_session_id, user_id, question_revision_id)
    references public.practice_sessions (id, user_id, question_revision_id) on delete cascade,
  constraint question_attempts_user_question_id_key unique (user_id, question_id, id),
  constraint question_attempts_grade_ref_key unique (question_revision_id, user_id, id),
  constraint question_attempts_grades_attempt_fk
    foreign key (question_revision_id, user_id, grades_attempt_id)
    references public.question_attempts (question_revision_id, user_id, id) on delete cascade,
  constraint question_attempts_grades_attempt_key unique (grades_attempt_id),
  constraint question_attempts_displayed_option_ids_valid
    check (public.question_ids_valid(displayed_option_ids)),
  constraint question_attempts_submitted_answer_object
    check (jsonb_typeof(submitted_answer) = 'object'),
  constraint question_attempts_submitted_answer_size
    check (pg_column_size(submitted_answer) <= 65536),
  constraint question_attempts_result_valid check (result in ('correct', 'incorrect', 'pending')),
  constraint question_attempts_grading_method_valid
    check (grading_method is null or grading_method in ('auto', 'self', 'reviewer')),
  -- Every term is null-safe, so the expression is TRUE only for a valid row (a NULL result
  -- would let the CHECK pass).
  constraint question_attempts_grading_consistent check (
    (result = 'pending' and grading_method is null and graded_at is null
       and grades_attempt_id is null and graded_by is null)
    or (result in ('correct', 'incorrect') and graded_at is not null and (
          (coalesce(grading_method = 'auto', false)
             and grades_attempt_id is null and graded_by is null)
          or (coalesce(grading_method in ('self', 'reviewer'), false)
             and grades_attempt_id is not null)
       ))
  )
);

-- History: GET /questions/{id}/attempts for the caller, newest first.
create index question_attempts_user_question_idx
  on public.question_attempts (user_id, question_id, submitted_at desc);
create index question_attempts_question_idx
  on public.question_attempts (workspace_id, question_id, question_revision_id);
create index question_attempts_session_idx on public.question_attempts (practice_session_id);
create index question_attempts_graded_by_idx on public.question_attempts (graded_by);

-- ---------------------------------------------------------------------------------------------
-- question_user_states: per-user study state (questions.md §2). Never shared, never forked.
-- The dot status is derived (retry > incorrect > correct > viewed > unseen) by the API; this row
-- only stores the independent fields. last_graded_attempt_id must be the user's own attempt on
-- the same question (composite FK).
-- ---------------------------------------------------------------------------------------------
create table public.question_user_states (
  user_id uuid not null references auth.users (id) on delete cascade,
  question_id uuid not null,
  workspace_id uuid not null,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  last_graded_result text,
  last_graded_attempt_id uuid,
  is_favorite boolean not null default false,
  needs_retry boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id),
  constraint question_user_states_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_user_states_last_attempt_fk
    foreign key (user_id, question_id, last_graded_attempt_id)
    references public.question_attempts (user_id, question_id, id),
  constraint question_user_states_last_graded_result_valid
    check (last_graded_result is null or last_graded_result in ('correct', 'incorrect')),
  constraint question_user_states_last_graded_pair
    check ((last_graded_result is null) = (last_graded_attempt_id is null)),
  constraint question_user_states_viewed_pair
    check ((first_viewed_at is null) = (last_viewed_at is null)),
  constraint question_user_states_viewed_order
    check (last_viewed_at is null
           or (first_viewed_at is not null and last_viewed_at >= first_viewed_at))
);

-- Overview: the caller's states for one workspace.
create index question_user_states_user_workspace_idx
  on public.question_user_states (user_id, workspace_id);
create index question_user_states_question_idx
  on public.question_user_states (workspace_id, question_id);
create index question_user_states_last_attempt_idx
  on public.question_user_states (last_graded_attempt_id) where last_graded_attempt_id is not null;

create trigger question_user_states_set_updated_at
  before update on public.question_user_states
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- question_lineage: an approved semantic variant (child) and the parent revision it came from,
-- with generation provenance (questions.md §5). Append-only. A child has exactly one parent.
-- Forks remap both ends; lineage to a question outside the fork is not copied.
-- ---------------------------------------------------------------------------------------------
create table public.question_lineage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  parent_question_id uuid not null,
  child_question_id uuid not null,
  source_question_revision_id uuid not null,
  variation_type text not null,
  generation_run_id uuid,
  draft_id uuid,
  llm_model text,
  prompt_version text,
  source_block_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint question_lineage_parent_revision_fk
    foreign key (workspace_id, parent_question_id, source_question_revision_id)
    references public.question_revisions (workspace_id, question_id, id),
  constraint question_lineage_child_fk foreign key (workspace_id, child_question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_lineage_generation_run_fk foreign key (workspace_id, generation_run_id)
    references public.question_generation_runs (workspace_id, id),
  constraint question_lineage_draft_fk foreign key (workspace_id, draft_id)
    references public.question_drafts (workspace_id, id),
  constraint question_lineage_child_key unique (child_question_id),
  constraint question_lineage_not_self check (parent_question_id <> child_question_id),
  constraint question_lineage_variation_type_valid
    check (variation_type in ('PARAPHRASE', 'INVERT_POLARITY', 'ANALOGOUS_CONCEPT')),
  constraint question_lineage_llm_model_length
    check (llm_model is null or char_length(llm_model) between 1 and 200),
  constraint question_lineage_prompt_version_length
    check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  constraint question_lineage_source_block_ids_valid
    check (public.question_ids_valid(source_block_ids))
);

create index question_lineage_parent_idx
  on public.question_lineage (workspace_id, parent_question_id, source_question_revision_id);
create index question_lineage_generation_run_idx
  on public.question_lineage (workspace_id, generation_run_id) where generation_run_id is not null;
create index question_lineage_draft_idx
  on public.question_lineage (workspace_id, draft_id) where draft_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.questions,
  public.question_revisions,
  public.question_sources,
  public.question_user_states,
  public.practice_sessions,
  public.question_attempts,
  public.question_lineage,
  public.question_generation_runs,
  public.question_import_runs,
  public.question_drafts
from anon, authenticated;

-- Soft delete is an UPDATE.
grant select, insert, update on public.questions to quiz_api;
-- Immutable history.
grant select, insert on public.question_revisions to quiz_api;
grant select, insert on public.question_attempts to quiz_api;
grant select, insert on public.question_lineage to quiz_api;
-- Editing a question's sources replaces rows.
grant select, insert, delete on public.question_sources to quiz_api;
grant select, insert, update on public.question_user_states to quiz_api;
grant select, insert, update on public.practice_sessions to quiz_api;
grant select, insert, update on public.question_generation_runs to quiz_api;
grant select, insert, update on public.question_import_runs to quiz_api;
grant select, insert, update on public.question_drafts to quiz_api;
-- quiz_worker gets nothing here; the import/generation worker Tasks (M4.4a, M6.2) grant what
-- their jobs write in their own migrations.

-- ---------------------------------------------------------------------------------------------
-- Row level security: enabled everywhere; policies only for quiz_api, matching its grants.
-- ---------------------------------------------------------------------------------------------
alter table public.questions enable row level security;
alter table public.question_revisions enable row level security;
alter table public.question_sources enable row level security;
alter table public.question_user_states enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.question_attempts enable row level security;
alter table public.question_lineage enable row level security;
alter table public.question_generation_runs enable row level security;
alter table public.question_import_runs enable row level security;
alter table public.question_drafts enable row level security;

create policy quiz_api_all on public.questions
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.question_sources
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.question_user_states
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.practice_sessions
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.question_generation_runs
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.question_import_runs
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.question_drafts
  for all to quiz_api using (true) with check (true);

create policy quiz_api_select on public.question_revisions
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_revisions
  for insert to quiz_api with check (true);
create policy quiz_api_select on public.question_attempts
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_attempts
  for insert to quiz_api with check (true);
create policy quiz_api_select on public.question_lineage
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_lineage
  for insert to quiz_api with check (true);
