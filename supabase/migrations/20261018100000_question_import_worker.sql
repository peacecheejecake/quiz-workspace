-- M4.4a question PDF import: draft columns the review/publish flow needs, one draft per position
-- of an import run, and the `quiz_worker` privileges of the `question.import` job.
--
-- Sources: docs/questions.md §6 (drafts isolated until a human approves them, answers never
-- invented, page provenance), docs/architecture.md §6 (question-imports routes),
-- tests/e2e/fixtures/questions.ts A4/A7 (idempotent retries, a failed job keeps the drafts it
-- persisted and the retried job reconciles with them), implementation-plan §7 (quiz_worker grants
-- come from the Task's own migration).
--
-- Additive only: two nullable/defaulted columns, one unique index, grants and policies.
--
-- question_drafts
--   question_number   the number printed in the source ("3" in "3."), copied to
--                     questions.question_number on publish; null when unknown (generation)
--   is_multi_answer   MCQ multiple selection, copied to the published revision. The book_core
--                     QuestionDraft payload has no such field; the extractor detects it from the
--                     stem ("모두 고르시오") and the reviewer can change it.
--   (import_run_id, position) is unique: the worker reconciles a retried run by position (it
--   inserts only positions that have no draft yet, never touching reviewed or edited drafts).
--
-- quiz_worker (the `question.import` job, apps/worker quiz_worker.question_import_job):
--   question_import_runs  read; move the run's own state (status, finished_at, model/prompt
--                         provenance). It cannot create runs, re-point them at another document,
--                         revision or job, or change who created them.
--   question_drafts       read import drafts; insert *pending, unpublished, unreviewed* import
--                         drafts. No UPDATE/DELETE: review, edits and publishing belong to the API
--                         (quiz_api), so a job can never overwrite what a human reviewed, and a
--                         failed job's drafts stay for the retry to reconcile with.
-- Workspace access is still re-checked through public.worker_workspace_writable (20261017230000).

alter table public.question_drafts
  add column question_number integer,
  add column is_multi_answer boolean not null default false,
  add constraint question_drafts_question_number_positive
    check (question_number is null or question_number > 0);

create unique index question_drafts_import_run_position_key
  on public.question_drafts (import_run_id, position) where import_run_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
grant select on public.question_import_runs to quiz_worker;
grant update (status, finished_at, llm_model, prompt_version, updated_at)
  on public.question_import_runs to quiz_worker;
grant select, insert on public.question_drafts to quiz_worker;

create policy quiz_worker_select on public.question_import_runs
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.question_import_runs
  for update to quiz_worker using (true) with check (true);

create policy quiz_worker_select on public.question_drafts
  for select to quiz_worker using (source_type = 'import');
create policy quiz_worker_insert on public.question_drafts
  for insert to quiz_worker
  with check (
    source_type = 'import'
    and review_status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and published_question_id is null
  );
