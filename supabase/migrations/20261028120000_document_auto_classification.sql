-- UX6-UPLOAD-B: one upload place for every PDF; the server tells body text and question papers
-- apart (DOC-01-AC07/AC08, docs/questions.md §6). Until now the uploader chose the kind
-- (`document_type` book | question_paper) by where they uploaded.
--
-- Additive only: defaulted/nullable columns, consistency checks over them, one new worker
-- function, and a replaced worker_start_question_import that also starts for books with
-- questions. Existing rows keep their meaning (type_source 'user', content_kind null = derived
-- from document_type).
--
-- documents.document_type stays "is this body text?" and keeps driving search, generation
-- sources and chapter matching: `book` for a book and for a book that also prints questions.
--
-- documents.type_source
--   'user'   the kind was chosen by a person: the upload's explicit document_type (as before,
--            the default) or a later override (PATCH /documents/{id}, `종류 변경`)
--   'auto'   uploaded with document_type 'auto': created as a `book`, classified by the
--            `document.parse` job before its first revision is published
-- documents.content_kind (null = not classified yet / a document from before this migration,
--   read as its document_type)
--   'book' | 'question_paper' | 'mixed' (= a book that also prints questions; document_type book)
--   Always consistent with document_type: question_paper <=> 'question_paper'.
-- documents.detection
--   The classifier's numbers (book_core ContentDetection: kind, confidence, strong_questions,
--   coverage, page_share, answered_ratio, gap_ratio, version). Never document text. Kept after a
--   user override, so a later calibration can compare.
-- document_uploads.auto_classify
--   The intent was created with document_type 'auto' (its document_type column then says
--   'book', the kind the document starts as).
--
-- worker_classify_document(document, revision, kind, detection) -> the document_type set, or null
--   Called by quiz_worker inside the publish transaction of the first revision (document row
--   already locked FOR UPDATE there). Applies only to a live document with type_source 'auto'
--   that was never classified, for its first revision (no parent): a retried or redelivered
--   parse job, a correction revision or a document the user re-typed meanwhile is never
--   reclassified. quiz_worker gets no UPDATE on document_type / content_kind / detection: only
--   this narrow capability.
--
-- worker_start_question_import (20261021120000) also starts for a `book` whose content_kind is
--   'mixed'. The worker calls it for a question paper, and for a mixed book only when the
--   classifier was confident (a low-confidence one is labelled and waits for the user).

alter table public.documents
  add column type_source text not null default 'user',
  add column content_kind text,
  add column detection jsonb,
  add constraint documents_type_source_valid check (type_source in ('user', 'auto')),
  add constraint documents_content_kind_valid
    check (content_kind is null or content_kind in ('book', 'question_paper', 'mixed')),
  add constraint documents_content_kind_matches_type
    check (content_kind is null
           or (content_kind = 'question_paper') = (document_type = 'question_paper')),
  add constraint documents_detection_object
    check (detection is null
           or (pg_catalog.jsonb_typeof(detection) = 'object'
               and pg_catalog.octet_length(detection::text) <= 2000));

alter table public.document_uploads
  add column auto_classify boolean not null default false,
  add constraint document_uploads_auto_classify_book
    check (not auto_classify or document_type = 'book');

comment on column public.documents.type_source is
  'UX6-UPLOAD-B: user = kind chosen by a person (upload type or override); auto = classified.';
comment on column public.documents.content_kind is
  'UX6-UPLOAD-B: book | question_paper | mixed; null = not classified (read as document_type).';
comment on column public.documents.detection is
  'UX6-UPLOAD-B: content classifier numbers (no document text).';

create function public.worker_classify_document(
  p_document_id uuid,
  p_revision_id uuid,
  p_kind text,
  p_detection jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  doc record;
  new_type text;
begin
  if p_document_id is null or p_revision_id is null
     or p_kind is null or p_kind not in ('book', 'question_paper', 'mixed') then
    return null;
  end if;
  select d.id, d.type_source, d.content_kind, d.deleted_at
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or doc.type_source <> 'auto'
     or doc.content_kind is not null then
    return null;
  end if;
  if not exists (
    select 1 from public.document_revisions r
     where r.id = p_revision_id and r.document_id = p_document_id
       and r.parent_revision_id is null
  ) then
    return null;
  end if;
  new_type := case when p_kind = 'question_paper' then 'question_paper' else 'book' end;
  update public.documents
     set document_type = new_type, content_kind = p_kind, detection = p_detection
   where id = p_document_id;
  return new_type;
end;
$$;

comment on function public.worker_classify_document(uuid, uuid, text, jsonb) is
  'UX6-UPLOAD-B: set the kind of an auto-classified document once (quiz_worker only).';

revoke all on function public.worker_classify_document(uuid, uuid, text, jsonb)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_classify_document(uuid, uuid, text, jsonb) to quiz_worker;

create or replace function public.worker_start_question_import(
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
  select d.id, d.workspace_id, d.document_type, d.content_kind, d.active_revision_id,
         d.deleted_at
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or not (doc.document_type = 'question_paper'
             or doc.content_kind is not distinct from 'mixed')
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
  'QIMP-AUTO / UX6-UPLOAD-B: start the import of a just-published question paper or book with '
  'questions once (quiz_worker only).';

revoke all on function public.worker_start_question_import(uuid, uuid, uuid)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_start_question_import(uuid, uuid, uuid) to quiz_worker;
