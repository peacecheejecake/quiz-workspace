-- M6.2 question variant generation: what the `question.generate` job and the review flow need.
--
-- Sources: docs/questions.md §5 (drafts isolated until a human approves them, the LLM's declared
-- answer is never trusted, lineage + source block ids + model/prompt provenance), architecture.md
-- §6 (question-generations routes), tests/e2e/fixtures/generation.ts G1-G6, implementation-plan
-- §7 (quiz_worker grants come from the Task's own migration).
--
-- Additive only: two defaulted columns, one unique index, grants and policies.
--
-- question_generation_runs.passages
--   The source passages (book_core `Excerpt[]`, at most 8) the job gave the LLM, tagged P1..Pn
--   in this order. Stored so a reviewer's edit is re-validated against exactly the passages the
--   draft cited (quotes must stay verbatim excerpts of them). Canonical book text, never shown
--   to non-members (the run is workspace-scoped like the document itself).
-- question_drafts.acknowledged_codes
--   Blocking validations a reviewer explicitly confirmed (book_core ACKNOWLEDGEABLE_CODES: the
--   answer count changed by an inversion, the question type changed). Kept across later edits.
-- question_drafts (generation_run_id, position) is unique: a retried job inserts only missing
--   positions (never duplicates, never touches a reviewed draft).
--
-- quiz_worker (the `question.generate` job, apps/worker quiz_worker.question_generation_job):
--   question_generation_runs  read; move the run's own state (status, finished_at, model/prompt
--                             provenance, the passages it used). It cannot create runs or
--                             re-point them at another source revision, job or creator.
--   question_drafts           read and insert *pending, unpublished, unreviewed, unconfirmed*
--                             generation drafts (import drafts: 20261018100000). No UPDATE/DELETE.
--   questions, question_revisions, question_sources
--                             read only: the source revision the run pins, its sources (pages of
--                             the book the passages come from) and the workspace's questions
--                             (duplicate fingerprints). Writing questions stays with quiz_api.
-- Workspace access is still re-checked through public.worker_workspace_writable (20261017230000).

alter table public.question_generation_runs
  add column passages jsonb not null default '[]'::jsonb,
  add constraint question_generation_runs_passages_array
    check (jsonb_typeof(passages) = 'array'),
  add constraint question_generation_runs_passages_size
    check (pg_column_size(passages) <= 262144);

alter table public.question_drafts
  add column acknowledged_codes text[] not null default '{}',
  add constraint question_drafts_acknowledged_codes_valid
    check (acknowledged_codes <@ array['answer_count_changed', 'question_type_changed']::text[]);

create unique index question_drafts_generation_run_position_key
  on public.question_drafts (generation_run_id, position) where generation_run_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
grant select on public.question_generation_runs to quiz_worker;
grant update (status, finished_at, llm_model, prompt_version, passages, updated_at)
  on public.question_generation_runs to quiz_worker;
grant select on public.questions, public.question_revisions, public.question_sources
  to quiz_worker;
-- question_drafts: SELECT and INSERT were granted by 20261018100000; the policies below extend
-- them to generation drafts.

create policy quiz_worker_select on public.question_generation_runs
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.question_generation_runs
  for update to quiz_worker using (true) with check (true);

create policy quiz_worker_select_generation on public.question_drafts
  for select to quiz_worker using (source_type = 'generation');
create policy quiz_worker_insert_generation on public.question_drafts
  for insert to quiz_worker
  with check (
    source_type = 'generation'
    and review_status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and published_question_id is null
    and acknowledged_codes = '{}'::text[]
  );

create policy quiz_worker_select on public.questions
  for select to quiz_worker using (true);
create policy quiz_worker_select on public.question_revisions
  for select to quiz_worker using (true);
create policy quiz_worker_select on public.question_sources
  for select to quiz_worker using (true);
