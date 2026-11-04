-- UX9-REDIST-B: chapter redistribution (docs/questions.md §14, docs/architecture.md §5,
-- docs/screens/chapter-redistribution.md CHREDIST-01-C02..C07).
--
-- A question's chapter is a property of the question row (`questions.chapter_id`), not of its
-- content revision: moving a question never creates a revision. This migration records how each
-- chapter was decided and keeps the history of chapter changes.
--
-- questions (additive columns):
--   chapter_source  manual (a person chose it) | auto (CHAPTER-MAP suggestion); not null,
--                   default manual (direct registration, variant generation)
--   chapter_set_by  who set it last (the requester for registrations and applied suggestions)
--   chapter_set_at  when
-- Backfill (user decision 2026-11-02): questions registered from an import draft
-- (`question_drafts.published_question_id`, source_type import) whose draft had
-- `chapter_manual = false` are `auto`; every other existing question stays `manual`.
-- `chapter_set_by`/`chapter_set_at` stay null for existing rows (unknown). The backfill does not
-- touch `updated_at`.
--
-- Who writes chapter_source afterwards:
--   quiz_api  direct registration (manual), PATCH /questions/{id} chapter change (manual, history
--             `edit`), POST /workspaces/{id}/questions/chapter-assignments (manual |
--             recommendation -> auto, history `manual` | `recommendation`).
--   trigger   question_drafts_register_chapter: when an import draft is registered (the API
--             publish and the worker registration job both set `published_question_id`), the
--             new question becomes `auto` unless the reviewer chose the chapter
--             (`chapter_manual`), and a non-null chapter gets one `import` history row.
--   fork      worker_fork_commit copies chapter_source as it is (chapter_set_by/at and the
--             history are not copied).
--   remap     documents_remap_question_chapters (a correction publish) moves the chapter id to
--             the new revision's chapter of the same section and keeps chapter_source.
--
-- question_chapter_changes: append-only history (UX9 on; earlier changes are not reconstructed).
--   from_chapter_id / to_chapter_id  null = "챕터 없음" (set null if the chapter row is removed)
--   source                           manual | recommendation | edit | import
--   changed_by / changed_at          the requester (JWT sub) / when
-- quiz_api: SELECT and INSERT only (UPDATE and DELETE refused by trigger, cascades excepted).
-- quiz_worker, anon, authenticated: nothing.

-- ---------------------------------------------------------------------------------------------
-- questions.chapter_source / chapter_set_by / chapter_set_at
-- ---------------------------------------------------------------------------------------------
alter table public.questions
  add column chapter_source text not null default 'manual',
  add column chapter_set_by uuid references auth.users (id) on delete set null,
  add column chapter_set_at timestamptz,
  add constraint questions_chapter_source_valid check (chapter_source in ('manual', 'auto'));

comment on column public.questions.chapter_source is
  'UX9: how the chapter was decided: manual (a person) | auto (CHAPTER-MAP suggestion).';

create index questions_chapter_set_by_idx on public.questions (chapter_set_by)
  where chapter_set_by is not null;

alter table public.questions disable trigger questions_set_updated_at;
update public.questions q
   set chapter_source = 'auto'
  from public.question_drafts d
 where d.published_question_id = q.id
   and d.workspace_id = q.workspace_id
   and d.source_type = 'import'
   and not d.chapter_manual;
alter table public.questions enable trigger questions_set_updated_at;

-- ---------------------------------------------------------------------------------------------
-- question_chapter_changes
-- ---------------------------------------------------------------------------------------------
create table public.question_chapter_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  question_id uuid not null,
  from_chapter_id uuid references public.chapters (id) on delete set null,
  to_chapter_id uuid references public.chapters (id) on delete set null,
  source text not null,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  constraint question_chapter_changes_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_chapter_changes_source_valid
    check (source in ('manual', 'recommendation', 'edit', 'import'))
);

create index question_chapter_changes_question_idx
  on public.question_chapter_changes (workspace_id, question_id, changed_at);
create index question_chapter_changes_from_idx
  on public.question_chapter_changes (from_chapter_id) where from_chapter_id is not null;
create index question_chapter_changes_to_idx
  on public.question_chapter_changes (to_chapter_id) where to_chapter_id is not null;
create index question_chapter_changes_changed_by_idx
  on public.question_chapter_changes (changed_by) where changed_by is not null;

create function public.question_chapter_changes_append_only()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  -- Referential actions (workspace / question / chapter / user deleted) run inside the RI
  -- trigger.
  if pg_catalog.pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception '% is append-only (% refused)', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

comment on function public.question_chapter_changes_append_only() is
  'UX9 trigger: refuse UPDATE/DELETE on question_chapter_changes (cascades excepted).';

create trigger question_chapter_changes_append_only
  before update or delete on public.question_chapter_changes
  for each row execute function public.question_chapter_changes_append_only();

-- ---------------------------------------------------------------------------------------------
-- Import registration: chapter_source and the `import` history row
-- ---------------------------------------------------------------------------------------------
create function public.question_drafts_register_chapter()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_chapter uuid;
  v_by uuid;
begin
  select q.chapter_id, q.created_by
    into v_chapter, v_by
    from public.questions q
   where q.id = new.published_question_id and q.workspace_id = new.workspace_id;
  if not found then
    return null;
  end if;
  update public.questions
     set chapter_source = case when new.source_type = 'import' and not new.chapter_manual
                               then 'auto' else 'manual' end,
         chapter_set_by = coalesce(chapter_set_by, v_by),
         chapter_set_at = coalesce(chapter_set_at, pg_catalog.now())
   where id = new.published_question_id;
  if new.source_type = 'import' and v_chapter is not null then
    insert into public.question_chapter_changes (workspace_id, question_id, from_chapter_id,
                                                 to_chapter_id, source, changed_by)
    values (new.workspace_id, new.published_question_id, null, v_chapter, 'import', v_by);
  end if;
  return null;
end;
$$;

comment on function public.question_drafts_register_chapter() is
  'UX9 trigger: a registered import draft sets its question''s chapter_source (auto unless the '
  'reviewer chose the chapter) and records the registered chapter.';

create trigger question_drafts_register_chapter
  after update of published_question_id on public.question_drafts
  for each row
  when (old.published_question_id is null and new.published_question_id is not null)
  execute function public.question_drafts_register_chapter();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table public.question_chapter_changes from anon, authenticated;
revoke all on function public.question_chapter_changes_append_only()
  from public, anon, authenticated;
revoke all on function public.question_drafts_register_chapter()
  from public, anon, authenticated;

grant select, insert on public.question_chapter_changes to quiz_api;

alter table public.question_chapter_changes enable row level security;
create policy quiz_api_select on public.question_chapter_changes
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_chapter_changes
  for insert to quiz_api with check (true);

-- ---------------------------------------------------------------------------------------------
-- Fork: copy chapter_source (20261102120000 body; only the questions insert changes).
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
  -- UX7-DBLINT: declarations of the temp tables created below, for plpgsql_check only (a string
  -- constant, so this is a no-op at run time and needs no extension).
  perform 'pragma:table: fork_docs(source_document_id uuid, source_revision_id uuid, '
          'target_workspace_id uuid, target_document_id uuid, target_revision_id uuid, '
          'document_type text, title text, source_object_key text, target_object_key text, '
          'source_parsed_object_key text, target_parsed_object_key text)';
  perform 'pragma:table: fork_summary_runs(srun uuid, trun uuid, target_document_id uuid, '
          'target_revision_id uuid, trigger text, prompt_version text, model text)';
  perform 'pragma:table: fork_questions(sq uuid, srev uuid, tq uuid, trev uuid, entry jsonb)';
  perform 'pragma:table: fork_sources(tq uuid, sid uuid, document_id uuid, '
          'document_revision_id uuid, page_start integer, page_end integer, block_ids text[], '
          'locations jsonb)';

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
                                created_at, chapter_source)
  select fq.tq, tws,
         case when exists (select 1 from pg_temp.fork_docs p
                             join public.chapters c on c.document_revision_id = p.source_revision_id
                            where c.id = q.chapter_id)
              then public.fork_remap_id(salt, q.chapter_id) end,
         q.question_type, q.origin, q.question_number, q.sort_order, 'DRAFT', f.forked_by,
         q.created_at, q.chapter_source
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
  'DOCSUM-B: with the snapshot revision''s summary; UX9: questions keep their chapter_source.';

revoke all on function public.worker_fork_commit(uuid) from public, anon, authenticated;
grant execute on function public.worker_fork_commit(uuid) to quiz_worker;
