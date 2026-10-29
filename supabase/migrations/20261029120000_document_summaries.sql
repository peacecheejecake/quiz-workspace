-- DOCSUM-B: AI summaries of a book's published revisions (DOCSUM-01, docs/architecture.md §5-§6,
-- docs/workspace-sharing.md §8).
--
-- Additive only: four nullable columns on documents, three new tables with their grants and RLS
-- policies, one new worker function, and a replaced worker_fork_commit that also copies the
-- snapshot revision's summary.
--
-- documents.summary_enabled_at / summary_enabled_by
--   Set by `요약 만들기` (POST /documents/{id}/summary, quiz_api): the document is opted in and
--   every later publish (correction, restore) summarizes the new revision automatically.
--   null = never opted in, or auto refresh turned off. A document that was never opted in never
--   sends its text to the LLM.
-- documents.summary_disabled_at / summary_disabled_by
--   The last `자동 갱신 끄기` (DELETE /documents/{id}/summary/auto).
--
-- document_summary_runs: one summarization of one published revision.
--   status    queued | running | succeeded | failed | superseded
--   trigger   manual (POST /summary) | publish (worker_start_document_summary) | retry
--   At most one live run (queued, running or succeeded) per revision (partial unique index); a
--   retry is a new run of the same revision after a failed one, which stays. When a run of a newer
--   revision is created, unfinished runs of older revisions become `superseded` and never write.
--   usage: counts and token/cost numbers only ({reused_units, generated_units, input_tokens,
--   output_tokens, cost_usd}); progress: {chapters_done, chapters_total}; error_code: a code
--   (llm_unavailable, llm_timeout, llm_invalid_output, summary_too_large, document_unavailable),
--   never provider text.
-- document_summary_units: content-addressed summaries of one document, unique by
--   (document_id, scope, section_key, input_hash, prompt_version, model). scope `chapter` = one
--   top-level chapter (section_key = the chapter's section key, input_hash = SHA-256 of its
--   normalized block text + pages); scope `document` = the reduce over the chapter units
--   (section_key 'document', input_hash over the chapter hashes). Never shared across documents.
--   body = {title, summary_md, key_points: [{text, pages: {from, to} | null}]}.
-- document_summary_run_units: the units of a run in display order (position 0 = the document
--   summary, 1.. = the chapters in outline order).
--
-- worker_start_document_summary(document, revision, enabled) -> (run_id, job_id) or no row
--   Called by quiz_worker inside the publish transaction of `revision` (the document row is
--   already locked FOR UPDATE there). `enabled` is the worker's own switch
--   (WORKER_DOCUMENT_SUMMARY and an LLM). Starts a run only when the document is a live book
--   (never a question paper) whose active revision is `revision`, it is opted in
--   (summary_enabled_at), its workspace is active, and the revision has no live run yet (a
--   retried or re-delivered parse job starts nothing). The run (trigger `publish`) and its
--   `document.summarize` job (unpublished: the parse job hands it to the broker when it is done,
--   else the reconciler does) are attributed to the person who opted in. Unfinished runs of
--   older revisions are superseded in the same transaction.
--
-- worker_fork_commit (20261018200000) also copies, per copied document, the newest succeeded run
--   of the pinned revision with its units (new ids, no usage, no job) and the opt-in
--   (summary_enabled_at; null stays null). Failed and older runs are not copied.

alter table public.documents
  add column summary_enabled_at timestamptz,
  add column summary_enabled_by uuid references auth.users (id) on delete set null,
  add column summary_disabled_at timestamptz,
  add column summary_disabled_by uuid references auth.users (id) on delete set null;

comment on column public.documents.summary_enabled_at is
  'DOCSUM-B: opted in to AI summaries, auto refresh on every publish; null = off.';
comment on column public.documents.summary_disabled_at is
  'DOCSUM-B: the last time auto refresh was turned off.';

-- ---------------------------------------------------------------------------------------------
-- document_summary_runs
-- ---------------------------------------------------------------------------------------------
create table public.document_summary_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null,
  document_revision_id uuid not null,
  status text not null default 'queued',
  trigger text not null,
  job_id uuid,
  prompt_version text,
  model text,
  error_code text,
  usage jsonb,
  progress jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint document_summary_runs_workspace_id_id_key unique (workspace_id, id),
  constraint document_summary_runs_revision_fk
    foreign key (workspace_id, document_id, document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) on delete cascade,
  constraint document_summary_runs_job_fk foreign key (workspace_id, job_id)
    references public.async_jobs (workspace_id, id) on delete set null (job_id),
  constraint document_summary_runs_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  constraint document_summary_runs_trigger_valid
    check (trigger in ('manual', 'publish', 'retry')),
  constraint document_summary_runs_finished_iff_terminal
    check ((status in ('succeeded', 'failed', 'superseded')) = (finished_at is not null)),
  constraint document_summary_runs_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint document_summary_runs_error_only_failed
    check (error_code is null or status = 'failed'),
  constraint document_summary_runs_prompt_version_length
    check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  constraint document_summary_runs_model_length
    check (model is null or char_length(model) between 1 and 200),
  constraint document_summary_runs_usage_object
    check (usage is null
           or (pg_catalog.jsonb_typeof(usage) = 'object' and pg_column_size(usage) <= 2048)),
  constraint document_summary_runs_progress_object
    check (progress is null
           or (pg_catalog.jsonb_typeof(progress) = 'object' and pg_column_size(progress) <= 512))
);

-- One live run per revision (retry = a new run after a failed one).
create unique index document_summary_runs_live_revision_key
  on public.document_summary_runs (document_revision_id)
  where status in ('queued', 'running', 'succeeded');
create index document_summary_runs_document_created_idx
  on public.document_summary_runs (document_id, created_at desc, id desc);
create index document_summary_runs_revision_idx
  on public.document_summary_runs (workspace_id, document_id, document_revision_id);
create index document_summary_runs_job_idx
  on public.document_summary_runs (workspace_id, job_id) where job_id is not null;
create index document_summary_runs_created_by_idx
  on public.document_summary_runs (created_by);

-- ---------------------------------------------------------------------------------------------
-- document_summary_units
-- ---------------------------------------------------------------------------------------------
create table public.document_summary_units (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null,
  scope text not null,
  section_key text not null,
  input_hash text not null,
  prompt_version text not null,
  model text not null,
  body jsonb not null,
  page_from integer,
  page_to integer,
  usage jsonb,
  created_at timestamptz not null default now(),
  constraint document_summary_units_workspace_id_id_key unique (workspace_id, id),
  constraint document_summary_units_content_key
    unique (document_id, scope, section_key, input_hash, prompt_version, model),
  constraint document_summary_units_document_fk foreign key (workspace_id, document_id)
    references public.documents (workspace_id, id) on delete cascade,
  constraint document_summary_units_scope_valid check (scope in ('chapter', 'document')),
  constraint document_summary_units_section_key_length
    check (char_length(section_key) between 1 and 200),
  constraint document_summary_units_input_hash_format check (input_hash ~ '^[0-9a-f]{64}$'),
  constraint document_summary_units_prompt_version_length
    check (char_length(prompt_version) between 1 and 100),
  constraint document_summary_units_model_length check (char_length(model) between 1 and 200),
  constraint document_summary_units_body_object
    check (pg_catalog.jsonb_typeof(body) = 'object' and pg_column_size(body) <= 65536),
  constraint document_summary_units_pages_valid
    check ((page_from is null or page_from >= 1)
           and (page_to is null or page_to >= 1)
           and (page_from is null or page_to is null or page_from <= page_to)),
  constraint document_summary_units_usage_object
    check (usage is null
           or (pg_catalog.jsonb_typeof(usage) = 'object' and pg_column_size(usage) <= 2048))
);

-- ---------------------------------------------------------------------------------------------
-- document_summary_run_units
-- ---------------------------------------------------------------------------------------------
create table public.document_summary_run_units (
  workspace_id uuid not null,
  run_id uuid not null,
  unit_id uuid not null,
  position integer not null,
  constraint document_summary_run_units_pkey primary key (run_id, position),
  constraint document_summary_run_units_run_unit_key unique (run_id, unit_id),
  constraint document_summary_run_units_run_fk foreign key (workspace_id, run_id)
    references public.document_summary_runs (workspace_id, id) on delete cascade,
  constraint document_summary_run_units_unit_fk foreign key (workspace_id, unit_id)
    references public.document_summary_units (workspace_id, id) on delete cascade,
  constraint document_summary_run_units_position_range check (position between 0 and 10000)
);

create index document_summary_run_units_unit_idx
  on public.document_summary_run_units (workspace_id, unit_id);

-- ---------------------------------------------------------------------------------------------
-- worker_start_document_summary
-- ---------------------------------------------------------------------------------------------
create function public.worker_start_document_summary(
  p_document_id uuid,
  p_revision_id uuid,
  p_enabled boolean
)
returns table (run_id uuid, job_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  doc record;
  ws_status text;
  new_run uuid := pg_catalog.gen_random_uuid();
  new_job uuid := pg_catalog.gen_random_uuid();
begin
  if p_document_id is null or p_revision_id is null or not coalesce(p_enabled, false) then
    return;
  end if;
  select d.id, d.workspace_id, d.document_type, d.active_revision_id, d.deleted_at,
         d.summary_enabled_at, d.summary_enabled_by
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or doc.document_type <> 'book'
     or doc.summary_enabled_at is null
     or doc.active_revision_id is distinct from p_revision_id then
    return;
  end if;
  select w.status
    into ws_status
    from public.workspaces w
   where w.id = doc.workspace_id and w.deleted_at is null
     for share;
  if ws_status is distinct from 'active' then
    return;
  end if;
  if exists (
    select 1 from public.document_summary_runs r
     where r.document_revision_id = p_revision_id
       and r.status in ('queued', 'running', 'succeeded')
  ) then
    return;
  end if;

  update public.document_summary_runs r
     set status = 'superseded', finished_at = pg_catalog.now()
   where r.document_id = p_document_id
     and r.status in ('queued', 'running')
     and r.document_revision_id <> p_revision_id;

  insert into public.async_jobs (id, workspace_id, created_by, job_type, schema_version,
                                 idempotency_key, payload)
  values (new_job, doc.workspace_id, doc.summary_enabled_by, 'document.summarize', 1,
          'document_summary:' || new_run::text,
          pg_catalog.jsonb_build_object('run_id', new_run::text,
                                        'document_id', p_document_id::text));

  insert into public.document_summary_runs (id, workspace_id, document_id, document_revision_id,
                                            status, trigger, job_id, created_by)
  values (new_run, doc.workspace_id, p_document_id, p_revision_id, 'queued', 'publish', new_job,
          doc.summary_enabled_by);

  run_id := new_run;
  job_id := new_job;
  return next;
end;
$$;

comment on function public.worker_start_document_summary(uuid, uuid, boolean) is
  'DOCSUM-B: start the summary of a just-published revision of an opted-in book once '
  '(quiz_worker only).';

revoke all on function public.worker_start_document_summary(uuid, uuid, boolean)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_start_document_summary(uuid, uuid, boolean)
  to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- worker_fork_commit: 20261018200000 plus the summary copy (marked DOCSUM-B below).
-- Only the function body changes; owner, SECURITY DEFINER and grants stay as they are.
-- ---------------------------------------------------------------------------------------------
create or replace function public.worker_fork_commit(p_fork_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f public.workspace_forks%rowtype;
  salt uuid;
  tws uuid;
  sws uuid;
begin
  select * into f from public.workspace_forks where id = p_fork_id for update;
  if not found then
    return 'not_found';
  end if;
  if f.status = 'COMPLETED' then
    return 'completed';
  end if;
  if f.status in ('FAILED', 'CANCELLED') then
    return pg_catalog.lower(f.status);
  end if;

  sws := f.source_workspace_id;
  perform 1 from public.workspaces w
   where w.id = sws and w.deleted_at is null and w.status <> 'deleted'
     for share;
  if not found then
    return 'unusable';
  end if;
  perform 1 from public.workspace_share_links l
   where l.id = f.source_share_link_id and l.workspace_id = sws
     and l.revoked_at is null
     and (l.expires_at is null or l.expires_at > pg_catalog.now())
     and l.allow_fork
     for share;
  if not found then
    return 'unusable';
  end if;

  salt := (f.source_snapshot_manifest ->> 'id_salt')::uuid;
  tws := (f.source_snapshot_manifest ->> 'target_workspace_id')::uuid;

  insert into public.workspaces (id, name, owner_id, status)
  values (tws, f.name, f.forked_by, 'active');
  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (tws, f.forked_by, 'owner');

  create temporary table fork_docs on commit drop as
    select * from public.worker_fork_documents(p_fork_id);

  -- Documents (processing until their revision is published below). DOCSUM-B: the summary
  -- opt-in is copied as it is (null stays null), attributed to the person forking.
  insert into public.documents (id, workspace_id, document_type, title, filename, content_type,
                                size_bytes, sha256, source_object_key, status, created_by,
                                created_at, summary_enabled_at, summary_enabled_by)
  select p.target_document_id, tws, d.document_type, d.title, d.filename, d.content_type,
         d.size_bytes, d.sha256, p.target_object_key, 'processing', f.forked_by, d.created_at,
         d.summary_enabled_at,
         case when d.summary_enabled_at is not null then f.forked_by end
    from pg_temp.fork_docs p
    join public.documents d on d.id = p.source_document_id;

  -- The pinned revision becomes revision 1 (a draft while its content is written).
  insert into public.document_revisions (id, workspace_id, document_id, revision_number, status,
                                         content_hash, parser_version, source_object_key,
                                         parsed_object_key, created_by)
  select p.target_revision_id, tws, p.target_document_id, 1, 'draft', r.content_hash,
         r.parser_version, p.target_object_key, p.target_parsed_object_key, f.forked_by
    from pg_temp.fork_docs p
    join public.document_revisions r on r.id = p.source_revision_id;

  insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                               section_key, level, sort_order, title, page, heading_block_id)
  select public.fork_remap_id(salt, c.id), tws, p.target_document_id, p.target_revision_id,
         public.fork_remap_id(salt, c.parent_id), c.section_key, c.level, c.sort_order, c.title,
         c.page, c.heading_block_id
    from pg_temp.fork_docs p
    join public.chapters c on c.document_revision_id = p.source_revision_id;

  insert into public.content_blocks (id, workspace_id, document_id, document_revision_id,
                                     block_id, ordinal, chapter_id, block_type, text, page,
                                     provenance, attributes, edited)
  select public.fork_remap_id(salt, b.id), tws, p.target_document_id, p.target_revision_id,
         b.block_id, b.ordinal, public.fork_remap_id(salt, b.chapter_id), b.block_type, b.text,
         b.page, b.provenance, b.attributes, b.edited
    from pg_temp.fork_docs p
    join public.content_blocks b on b.document_revision_id = p.source_revision_id;

  update public.document_revisions r
     set status = 'published', published_at = pg_catalog.now()
    from pg_temp.fork_docs p
   where r.id = p.target_revision_id;

  update public.documents d
     set active_revision_id = p.target_revision_id, status = 'ready'
    from pg_temp.fork_docs p
   where d.id = p.target_document_id;

  -- DOCSUM-B: the newest succeeded summary of each pinned revision, with its units, under new
  -- ids. History, failed runs, usage and the job are not copied.
  create temporary table fork_summary_runs on commit drop as
    select distinct on (p.source_document_id)
           r.id as srun, public.fork_remap_id(salt, r.id) as trun,
           p.target_document_id, p.target_revision_id, r.trigger, r.prompt_version, r.model
      from pg_temp.fork_docs p
      join public.document_summary_runs r
        on r.document_id = p.source_document_id
       and r.document_revision_id = p.source_revision_id
       and r.workspace_id = sws
       and r.status = 'succeeded'
     order by p.source_document_id, r.created_at desc, r.id desc;

  insert into public.document_summary_runs (id, workspace_id, document_id, document_revision_id,
                                            status, trigger, prompt_version, model, created_by,
                                            started_at, finished_at)
  select fr.trun, tws, fr.target_document_id, fr.target_revision_id, 'succeeded', fr.trigger,
         fr.prompt_version, fr.model, f.forked_by, pg_catalog.now(), pg_catalog.now()
    from pg_temp.fork_summary_runs fr;

  insert into public.document_summary_units (id, workspace_id, document_id, scope, section_key,
                                             input_hash, prompt_version, model, body, page_from,
                                             page_to)
  select public.fork_remap_id(salt, u.id), tws, fr.target_document_id, u.scope, u.section_key,
         u.input_hash, u.prompt_version, u.model, u.body, u.page_from, u.page_to
    from pg_temp.fork_summary_runs fr
    join public.document_summary_run_units ru on ru.run_id = fr.srun
    join public.document_summary_units u on u.id = ru.unit_id and u.workspace_id = sws
  on conflict do nothing;

  insert into public.document_summary_run_units (workspace_id, run_id, unit_id, position)
  select tws, fr.trun, public.fork_remap_id(salt, ru.unit_id), ru.position
    from pg_temp.fork_summary_runs fr
    join public.document_summary_run_units ru on ru.run_id = fr.srun;

  -- Questions: the pinned revision of each pinned question that is still in the source.
  create temporary table fork_questions on commit drop as
    select q.id as sq, qr.id as srev,
           public.fork_remap_id(salt, q.id) as tq,
           public.fork_remap_id(salt, qr.id) as trev,
           e as entry
      from pg_catalog.jsonb_array_elements(f.source_snapshot_manifest -> 'questions') as e
      join public.questions q on q.id = (e ->> 'question_id')::uuid and q.workspace_id = sws
      join public.question_revisions qr
        on qr.id = (e ->> 'revision_id')::uuid and qr.question_id = q.id and qr.workspace_id = sws;

  insert into public.questions (id, workspace_id, chapter_id, question_type, origin,
                                question_number, sort_order, publication_status, created_by,
                                created_at)
  select fq.tq, tws,
         case when exists (select 1 from pg_temp.fork_docs p
                             join public.chapters c on c.document_revision_id = p.source_revision_id
                            where c.id = q.chapter_id)
              then public.fork_remap_id(salt, q.chapter_id) end,
         q.question_type, q.origin, q.question_number, q.sort_order, 'DRAFT', f.forked_by,
         q.created_at
    from pg_temp.fork_questions fq
    join public.questions q on q.id = fq.sq;

  insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                         correct_option_ids, accepted_answers, is_multi_answer,
                                         explanation, rubric, created_by)
  select fq.trev, tws, fq.tq, 1, qr.stem, qr.options, qr.correct_option_ids, qr.accepted_answers,
         qr.is_multi_answer, qr.explanation, qr.rubric, f.forked_by
    from pg_temp.fork_questions fq
    join public.question_revisions qr on qr.id = fq.srev;

  update public.questions q
     set active_revision_id = fq.trev, publication_status = 'CONFIRMED'
    from pg_temp.fork_questions fq
   where q.id = fq.tq;

  -- Sources as pinned in the manifest at request time (`questions[].sources`, the rows the
  -- pinned revision was shown with), so a source edit after the request never reaches the copy.
  -- Manifests written before 20261018200000 have no `sources` key: their sources are read from
  -- the table as before. Only sources in copied documents are kept; the cited revision becomes
  -- the copied revision of that document (block ids are stable across revisions). Import
  -- provenance is not copied.
  create temporary table fork_sources on commit drop as
    select fq.tq, (s ->> 'id')::uuid as sid, (s ->> 'document_id')::uuid as document_id,
           (s ->> 'document_revision_id')::uuid as document_revision_id,
           (s ->> 'page_start')::integer as page_start, (s ->> 'page_end')::integer as page_end,
           coalesce(array(select pg_catalog.jsonb_array_elements_text(s -> 'block_ids')),
                    '{}'::text[]) as block_ids,
           coalesce(s -> 'locations', '[]'::jsonb) as locations
      from pg_temp.fork_questions fq
      cross join lateral pg_catalog.jsonb_array_elements(fq.entry -> 'sources') as s
     where pg_catalog.jsonb_typeof(fq.entry -> 'sources') = 'array'
    union all
    select fq.tq, s.id, s.document_id, s.document_revision_id, s.page_start, s.page_end,
           s.block_ids, s.locations
      from pg_temp.fork_questions fq
      join public.question_sources s on s.question_id = fq.sq and s.workspace_id = sws
     where not (fq.entry ? 'sources');

  insert into public.question_sources (id, workspace_id, question_id, document_id,
                                       document_revision_id, page_start, page_end, block_ids,
                                       locations)
  select public.fork_remap_id(salt, s.sid), tws, s.tq, p.target_document_id,
         case when s.document_revision_id is null then null else p.target_revision_id end,
         s.page_start, s.page_end, s.block_ids, s.locations
    from pg_temp.fork_sources s
    join pg_temp.fork_docs p on p.source_document_id = s.document_id;

  -- Lineage between two copied questions; the parent's only revision in the copy is the source.
  insert into public.question_lineage (id, workspace_id, parent_question_id, child_question_id,
                                       source_question_revision_id, variation_type, llm_model,
                                       prompt_version, source_block_ids)
  select public.fork_remap_id(salt, l.id), tws, parent.tq, child.tq, parent.trev,
         l.variation_type, l.llm_model, l.prompt_version, l.source_block_ids
    from public.question_lineage l
    join pg_temp.fork_questions parent on parent.sq = l.parent_question_id
    join pg_temp.fork_questions child on child.sq = l.child_question_id
   where l.workspace_id = sws;

  insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id,
                                      metadata)
  values (tws, f.forked_by, 'workspace.forked', 'workspace', tws,
          pg_catalog.jsonb_build_object('name', f.name, 'fork_id', f.id::text));

  insert into public.async_jobs (workspace_id, created_by, job_type, schema_version,
                                 idempotency_key, payload, max_attempts)
  select tws, f.forked_by, 'document.index_sync', 1, 'index_sync:' || p.target_revision_id::text,
         pg_catalog.jsonb_build_object('document_id', p.target_document_id::text,
                                       'revision_id', p.target_revision_id::text),
         8
    from pg_temp.fork_docs p;

  update public.workspace_forks
     set status = 'COMPLETED', progress = 100, target_workspace_id = tws,
         completed_at = pg_catalog.now(), last_error = null
   where id = p_fork_id;

  drop table pg_temp.fork_docs;
  drop table pg_temp.fork_summary_runs;
  drop table pg_temp.fork_questions;
  drop table pg_temp.fork_sources;
  return 'completed';
end;
$$;

comment on function public.worker_fork_commit(uuid) is
  'S3a: re-check the fork''s link under a lock and write the whole copy (idempotent); '
  'DOCSUM-B: with the snapshot revision''s summary.';

revoke all on function public.worker_fork_commit(uuid) from public, anon, authenticated;
grant execute on function public.worker_fork_commit(uuid) to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.document_summary_runs,
  public.document_summary_units,
  public.document_summary_run_units
from anon, authenticated;

-- quiz_api: reads everything; `요약 만들기` / `다시 시도` create runs (and supersede older ones).
-- Units and run links are written by the worker only.
grant select, insert, update on public.document_summary_runs to quiz_api;
grant select on public.document_summary_units to quiz_api;
grant select on public.document_summary_run_units to quiz_api;

-- quiz_worker (document.summarize): moves a run through its states and writes units and the
-- run's unit links. Runs are created only through worker_start_document_summary.
grant select on public.document_summary_runs to quiz_worker;
grant update (status, prompt_version, model, error_code, usage, progress, started_at, finished_at)
  on public.document_summary_runs to quiz_worker;
grant select, insert on public.document_summary_units to quiz_worker;
grant select, insert on public.document_summary_run_units to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- Row level security: enabled everywhere; policies only for the roles granted above.
-- ---------------------------------------------------------------------------------------------
alter table public.document_summary_runs enable row level security;
alter table public.document_summary_units enable row level security;
alter table public.document_summary_run_units enable row level security;

create policy quiz_api_all on public.document_summary_runs
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.document_summary_units
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.document_summary_run_units
  for all to quiz_api using (true) with check (true);

create policy quiz_worker_select on public.document_summary_runs
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.document_summary_runs
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.document_summary_units
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.document_summary_units
  for insert to quiz_worker with check (true);
create policy quiz_worker_select on public.document_summary_run_units
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.document_summary_run_units
  for insert to quiz_worker with check (true);
