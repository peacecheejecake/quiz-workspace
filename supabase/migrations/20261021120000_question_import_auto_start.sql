-- QIMP-AUTO: a question PDF's extraction starts on the server once its processing succeeds
-- (QIMPORT-01-AC06, docs/questions.md §6). Until now only the browser started it (POST
-- /question-imports after polling the parse job), so a user who left the import page while a
-- long PDF was parsing never got any drafts.
--
-- Additive only: one defaulted column, one partial unique index, one function and its grant.
--
-- question_import_runs.started_by
--   'user'    POST /workspaces/{id}/question-imports (quiz_api), as before (the default)
--   'system'  started by the `document.parse` job's publish transaction (below)
--   At most one system-started run per document (partial unique index): a retried or
--   re-delivered parse job, or a later corrected revision, never starts a second one.
--
-- worker_start_question_import(document, revision, user) -> (run_id, job_id) or no row
--   Called by quiz_worker inside the transaction that makes `revision` the document's active
--   revision (the document row is already locked FOR UPDATE there). Starts the import only when
--   the document is a live `question_paper` whose active revision is `revision`, the workspace is
--   still writable by `user` (active, owner/editor; rows locked FOR SHARE) and the document has
--   no import run yet (user- or system-started). The run, its first `question.import` job
--   (idempotency key `question_import:<run>:1`, the API's key scheme, so retry numbering keeps
--   working) and the `question_import.started` activity are attributed to `user` - the parse
--   job's creator, i.e. the uploader - in the document's own workspace; nothing is taken from a
--   client. The job is inserted unpublished: the worker hands it to the broker after the parse
--   job finishes, else the reconciler does after its grace period.
--   quiz_worker still cannot insert runs directly (20261018100000): it gets this one narrow
--   capability instead.

alter table public.question_import_runs
  add column started_by text not null default 'user',
  add constraint question_import_runs_started_by_valid check (started_by in ('user', 'system'));

create unique index question_import_runs_system_document_key
  on public.question_import_runs (source_document_id)
  where started_by = 'system';

create function public.worker_start_question_import(
  p_document_id uuid,
  p_revision_id uuid,
  p_user_id uuid
)
returns table (run_id uuid, job_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  doc record;
  new_run uuid := pg_catalog.gen_random_uuid();
  new_job uuid := pg_catalog.gen_random_uuid();
begin
  if p_document_id is null or p_revision_id is null or p_user_id is null then
    return;
  end if;
  select d.id, d.workspace_id, d.document_type, d.active_revision_id, d.deleted_at
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or doc.document_type <> 'question_paper'
     or doc.active_revision_id is distinct from p_revision_id then
    return;
  end if;
  if not public.worker_workspace_writable(doc.workspace_id, p_user_id, true) then
    return;
  end if;
  if exists (
    select 1 from public.question_import_runs r
     where r.workspace_id = doc.workspace_id and r.source_document_id = p_document_id
  ) then
    return;
  end if;

  insert into public.async_jobs (id, workspace_id, created_by, job_type, schema_version,
                                 idempotency_key, payload)
  values (new_job, doc.workspace_id, p_user_id, 'question.import', 1,
          'question_import:' || new_run::text || ':1',
          pg_catalog.jsonb_build_object('import_id', new_run::text));

  insert into public.question_import_runs (id, workspace_id, created_by, source_document_id,
                                           source_document_revision_id, async_job_id, status,
                                           started_by)
  values (new_run, doc.workspace_id, p_user_id, p_document_id, p_revision_id, new_job, 'queued',
          'system');

  -- Ids only, like the API's own `question_import.started`.
  insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id,
                                      metadata)
  values (doc.workspace_id, p_user_id, 'question_import.started', 'question_import', new_run,
          pg_catalog.jsonb_build_object('started_by', 'system'));

  run_id := new_run;
  job_id := new_job;
  return next;
end;
$$;

comment on function public.worker_start_question_import(uuid, uuid, uuid) is
  'QIMP-AUTO: start the import of a just-published question paper once (quiz_worker only).';

revoke all on function public.worker_start_question_import(uuid, uuid, uuid)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_start_question_import(uuid, uuid, uuid) to quiz_worker;
