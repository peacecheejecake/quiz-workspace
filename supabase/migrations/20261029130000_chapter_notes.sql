-- CHNOTE-B: chapter notes (CHNOTE-01, docs/questions.md §9, docs/workspace-sharing.md §8,
-- docs/architecture.md §5).
--
-- A chapter note summarises one Heatmap chapter group (the questions of exactly one
-- `chapter_id`) from its CONFIRMED questions and their explanations; every item is footnoted
-- with the question(s) it came from. Notes are keyed by `(document_id, section_key)`, so they
-- follow a chapter across corrected revisions of its book (the same rule as
-- documents_remap_question_chapters).
--
-- Additive only: one table, its grants/policies/indexes/triggers, three functions and one
-- trigger on workspace_forks. Nothing existing is altered or replaced (worker_fork_commit is
-- untouched: the fork copy runs from an AFTER UPDATE trigger on workspace_forks, see below).
--
-- chapter_notes: one row per generation (request). The newest *succeeded* row of a chapter is
-- its current note; earlier succeeded rows are its older versions (never deleted,
-- `superseded_at` set). Failed rows keep the error code and are not versions.
--   document_revision_id  the revision whose chapter text was the reference input at request
--                         time (quotes must occur in it)
--   version               1, 2, ... per (document_id, section_key), set when the row succeeds
--   status                queued | running | succeeded | failed; at most one queued/running row
--                         per chapter (partial unique index: POST answers 409
--                         `note-generation-running`)
--   job_id                the `chapter_note.generate` job ({note_id})
--   question_refs         [{tag, question_id, question_revision_id, label}] pinned at request
--                         time: the chapter's live CONFIRMED questions in Heatmap order, tagged
--                         Q1..Qn, `label` = "<n>장 <번호>번". The job reads exactly these revisions.
--   body_hash             SHA-256 of the chapter's reference text (chapter_note_body_hash)
--   input_fingerprint     chapter_note_fingerprint(question_refs, body_hash); stale = the
--                         chapter's current fingerprint differs (computed on read by the API)
--   body                  {sections: [{heading, items: [{text, tags: ["Q1", ...]}]}]}: only
--                         items whose every tag is an input tag (server-validated)
--   usage                 {llm_calls, batches, items, dropped_items, input_tokens,
--                         output_tokens, cost_usd}: counts only
--   batches_total/done    progress of a large chapter ("k/m 묶음")
-- Nothing here stores prompts or raw LLM output; error_code is a stable code.
--
-- quiz_api: reads notes; inserts *queued* rows (POST /chapters/{id}/note) and settles a
--   queued/running row whose job already ended (status/error_code/finished_at only).
-- quiz_worker (`chapter_note.generate`, apps/worker quiz_worker.chapter_note_job): reads notes,
--   moves a row's state and writes its result and the superseded_at of older versions. It
--   cannot insert or delete rows or re-point them at another chapter, job or input.
-- Activity `chapter_note.generated` (ids and counts only) is written by a trigger when a row
--   succeeds, so the worker needs no privilege on activity_events.
--
-- Fork (docs/workspace-sharing.md §8, CHNOTE-01-C07): when a fork completes, for each copied
-- document the newest succeeded note of each chapter is copied with new ids if it is
-- *source-matched at the snapshot*: every question_refs (question, revision) is a question the
-- fork pins in its manifest with exactly that revision (and the chapter exists in the pinned
-- revision). question_refs ids are remapped with fork_remap_id like the copied questions, the
-- fingerprint is recomputed over the remapped refs, and only that version is copied (no older
-- versions, failed rows or usage).

create table public.chapter_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null,
  document_revision_id uuid not null,
  section_key text not null,
  version integer,
  status text not null default 'queued',
  job_id uuid,
  input_fingerprint text not null,
  body_hash text not null,
  question_refs jsonb not null,
  body jsonb,
  dropped_items integer,
  batches_total integer,
  batches_done integer,
  prompt_version text,
  model text,
  error_code text,
  usage jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  superseded_at timestamptz,
  constraint chapter_notes_workspace_id_id_key unique (workspace_id, id),
  constraint chapter_notes_document_fk foreign key (workspace_id, document_id)
    references public.documents (workspace_id, id) on delete cascade,
  constraint chapter_notes_revision_fk
    foreign key (workspace_id, document_id, document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) on delete cascade,
  constraint chapter_notes_job_fk foreign key (workspace_id, job_id)
    references public.async_jobs (workspace_id, id) on delete set null (job_id),
  constraint chapter_notes_section_key_format
    check (section_key ~ '^\S+$' and char_length(section_key) <= 256),
  constraint chapter_notes_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint chapter_notes_version_positive check (version is null or version >= 1),
  constraint chapter_notes_succeeded_has_result
    check ((status = 'succeeded') = (version is not null and body is not null)),
  constraint chapter_notes_superseded_only_succeeded
    check (superseded_at is null or status = 'succeeded'),
  constraint chapter_notes_fingerprint_format check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint chapter_notes_body_hash_format check (body_hash ~ '^[0-9a-f]{64}$'),
  constraint chapter_notes_question_refs_array
    check (jsonb_typeof(question_refs) = 'array' and jsonb_array_length(question_refs) >= 1),
  constraint chapter_notes_question_refs_size check (pg_column_size(question_refs) <= 1048576),
  constraint chapter_notes_body_object check (body is null or jsonb_typeof(body) = 'object'),
  constraint chapter_notes_body_size check (body is null or pg_column_size(body) <= 4194304),
  constraint chapter_notes_usage_object check (usage is null or jsonb_typeof(usage) = 'object'),
  constraint chapter_notes_counts_non_negative
    check ((dropped_items is null or dropped_items >= 0)
           and (batches_total is null or batches_total >= 1)
           and (batches_done is null or batches_done between 0 and coalesce(batches_total, 0))),
  constraint chapter_notes_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint chapter_notes_provenance_length
    check ((prompt_version is null or char_length(prompt_version) <= 200)
           and (model is null or char_length(model) <= 200))
);

comment on table public.chapter_notes is
  'CHNOTE: chapter note generations; succeeded rows are the versions of a chapter''s note.';

-- One version number per chapter; one queued/running generation per chapter.
create unique index chapter_notes_chapter_version_key
  on public.chapter_notes (document_id, section_key, version) where version is not null;
create unique index chapter_notes_chapter_active_key
  on public.chapter_notes (document_id, section_key) where status in ('queued', 'running');
-- Reads: a chapter's generations newest first.
create index chapter_notes_chapter_idx
  on public.chapter_notes (workspace_id, document_id, section_key, created_at desc);
create index chapter_notes_job_idx
  on public.chapter_notes (workspace_id, job_id) where job_id is not null;
create index chapter_notes_created_by_idx on public.chapter_notes (created_by);

create trigger chapter_notes_set_updated_at
  before update on public.chapter_notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Reference text hash of a chapter: its blocks and the blocks of its sub-sections in reading
-- order, joined by newlines (the text the job checks quotes against).
-- ---------------------------------------------------------------------------------------------
create function public.chapter_note_body_hash(p_revision_id uuid, p_section_key text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive tree as (
    select c.id
      from public.chapters c
     where c.document_revision_id = p_revision_id and c.section_key = p_section_key
    union all
    select c.id
      from public.chapters c
      join tree t on c.parent_id = t.id
     where c.document_revision_id = p_revision_id
  )
  select pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             coalesce(pg_catalog.string_agg(b.text, E'\n' order by b.ordinal), ''), 'UTF8')),
           'hex')
    from public.content_blocks b
   where b.document_revision_id = p_revision_id
     and b.chapter_id in (select t.id from tree t)
$$;

comment on function public.chapter_note_body_hash(uuid, text) is
  'CHNOTE: SHA-256 (hex) of a chapter subtree''s block texts in reading order.';

-- ---------------------------------------------------------------------------------------------
-- Input fingerprint: SHA-256 of the sorted `question_id:question_revision_id` lines (byte
-- order), a newline and the body hash. quiz_api computes the same value in Python
-- (quiz_api.chapter_notes.input_fingerprint); supabase/tests checks both agree.
-- ---------------------------------------------------------------------------------------------
create function public.chapter_note_fingerprint(p_refs jsonb, p_body_hash text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             coalesce((select pg_catalog.string_agg(x.line, E'\n' order by x.line collate "C")
                         from (select (r ->> 'question_id') || ':' || (r ->> 'question_revision_id')
                                        as line
                                 from pg_catalog.jsonb_array_elements(p_refs) as r) as x), '')
             || E'\n' || coalesce(p_body_hash, ''), 'UTF8')),
           'hex')
$$;

comment on function public.chapter_note_fingerprint(jsonb, text) is
  'CHNOTE: input fingerprint of a note (sorted question:revision lines + body hash).';

-- ---------------------------------------------------------------------------------------------
-- Activity: `chapter_note.generated` when a row succeeds (ids and counts only).
-- ---------------------------------------------------------------------------------------------
create function public.chapter_notes_record_generated()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id,
                                      metadata)
  values (new.workspace_id, new.created_by, 'chapter_note.generated', 'chapter_note', new.id,
          pg_catalog.jsonb_build_object(
            'document_id', new.document_id::text,
            'version', new.version,
            'question_count', pg_catalog.jsonb_array_length(new.question_refs),
            'dropped_items', coalesce(new.dropped_items, 0)));
  return null;
end;
$$;

comment on function public.chapter_notes_record_generated() is
  'CHNOTE trigger: activity chapter_note.generated (ids and counts only) when a note succeeds.';

create trigger chapter_notes_record_generated
  after update of status on public.chapter_notes
  for each row
  when (new.status = 'succeeded' and old.status is distinct from 'succeeded')
  execute function public.chapter_notes_record_generated();

-- ---------------------------------------------------------------------------------------------
-- Fork copy (see the header). Fires in the worker_fork_commit transaction when the fork row
-- becomes COMPLETED, after the documents, chapters and questions were copied.
-- ---------------------------------------------------------------------------------------------
create function public.fork_copy_chapter_notes()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  salt uuid := (new.source_snapshot_manifest ->> 'id_salt')::uuid;
begin
  if salt is null or new.target_workspace_id is null then
    return null;
  end if;

  insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                    section_key, version, status, job_id, input_fingerprint,
                                    body_hash, question_refs, body, prompt_version, model,
                                    created_by, created_at, finished_at)
  select public.fork_remap_id(salt, n.id), new.target_workspace_id, p.target_document_id,
         p.target_revision_id, n.section_key, 1, 'succeeded', null,
         public.chapter_note_fingerprint(m.refs, n.body_hash), n.body_hash, m.refs, n.body,
         n.prompt_version, n.model, new.forked_by, n.created_at, n.finished_at
    from public.worker_fork_documents(new.id) p
    join public.chapter_notes n
      on n.workspace_id = new.source_workspace_id and n.document_id = p.source_document_id
    cross join lateral (
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'tag', r ->> 'tag',
                 'question_id',
                 public.fork_remap_id(salt, (r ->> 'question_id')::uuid)::text,
                 'question_revision_id',
                 public.fork_remap_id(salt, (r ->> 'question_revision_id')::uuid)::text,
                 'label', r ->> 'label')
               order by x.ord) as refs
        from pg_catalog.jsonb_array_elements(n.question_refs) with ordinality as x(r, ord)
    ) m
   where n.status = 'succeeded'
     and n.superseded_at is null
     and exists (select 1 from public.chapters c
                  where c.document_revision_id = p.source_revision_id
                    and c.section_key = n.section_key)
     and not exists (
       select 1
         from pg_catalog.jsonb_array_elements(n.question_refs) as r
        where not exists (
          select 1
            from pg_catalog.jsonb_array_elements(new.source_snapshot_manifest -> 'questions')
                   as e
            join public.questions q
              on q.id = (e ->> 'question_id')::uuid and q.workspace_id = new.source_workspace_id
           where (e ->> 'question_id')::uuid = (r ->> 'question_id')::uuid
             and (e ->> 'revision_id')::uuid = (r ->> 'question_revision_id')::uuid))
  on conflict (id) do nothing;
  return null;
end;
$$;

comment on function public.fork_copy_chapter_notes() is
  'CHNOTE trigger: copy the source-matched newest chapter notes into a completed fork.';

create trigger workspace_forks_copy_chapter_notes
  after update of status on public.workspace_forks
  for each row
  when (new.status = 'COMPLETED' and old.status is distinct from 'COMPLETED')
  execute function public.fork_copy_chapter_notes();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on public.chapter_notes from public, anon, authenticated;
revoke all on function public.chapter_note_body_hash(uuid, text)
  from public, anon, authenticated;
revoke all on function public.chapter_note_fingerprint(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.chapter_notes_record_generated()
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.fork_copy_chapter_notes()
  from public, anon, authenticated, quiz_api, quiz_worker;
grant execute on function public.chapter_note_body_hash(uuid, text) to quiz_api;

grant select, insert on public.chapter_notes to quiz_api;
grant update (status, error_code, finished_at, updated_at) on public.chapter_notes to quiz_api;
grant select on public.chapter_notes to quiz_worker;
grant update (status, version, body, usage, dropped_items, batches_total, batches_done,
              prompt_version, model, error_code, finished_at, superseded_at, updated_at)
  on public.chapter_notes to quiz_worker;
-- chapters / content_blocks: quiz_worker already reads them (20261017200000_documents.sql).

alter table public.chapter_notes enable row level security;

create policy quiz_api_select on public.chapter_notes
  for select to quiz_api using (true);
create policy quiz_api_insert on public.chapter_notes
  for insert to quiz_api
  with check (status = 'queued' and version is null and body is null and usage is null
              and superseded_at is null and finished_at is null and error_code is null);
-- Settle a queued/running row whose job already ended (never a success, never a version).
create policy quiz_api_update on public.chapter_notes
  for update to quiz_api
  using (status in ('queued', 'running'))
  with check (status = 'failed' and version is null and body is null);
create policy quiz_worker_select on public.chapter_notes
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.chapter_notes
  for update to quiz_worker using (true) with check (true);
