-- UX12-SHARE-1 + SHARE-2 (docs/workspace-sharing.md §12, docs/screens/ux12-share-scope.md).
--
-- Per-link scope. `include_notes`, `include_ai_explanations` and `include_summary` default to
-- true, so every existing link keeps exposing what it exposes today. `include_owner_records`
-- defaults to false: guests read the workspace owner's own attempts and highlights only where the
-- owner opted in. FastAPI checks these flags on every shared request; the database only stores
-- them. quiz_api's table-level SELECT, INSERT and UPDATE cover the new columns.
--
-- Fork. The API pins the three content flags in the manifest (`include`). The commit reads the
-- link again under the lock it already takes and copies an item only when both are on, so a flag
-- turned off while a fork runs leaves that item out, and one turned on after the request does not
-- add it. A flag change never cancels a fork. Manifests written before this migration have no
-- `include` key: the pinned value reads as on and the current flag still applies.
-- `include_owner_records` is not pinned: attempts, study states and highlights are never copied.
--
-- worker_fork_commit, sixth definition (20261103130000 body; only the summary lines change, marked
-- UX12-SHARE). Notes and AI explanations are copied by their own triggers, redefined here with one
-- added check each. All three run in the commit's transaction, so they read the same locked link.

alter table public.workspace_share_links
  add column include_notes boolean not null default true,
  add column include_ai_explanations boolean not null default true,
  add column include_summary boolean not null default true,
  add column include_owner_records boolean not null default false;

comment on column public.workspace_share_links.include_notes is
  'UX12-SHARE: guests read chapter notes and forks copy them.';
comment on column public.workspace_share_links.include_ai_explanations is
  'UX12-SHARE: guests read AI explanations and forks copy them.';
comment on column public.workspace_share_links.include_summary is
  'UX12-SHARE: guests read document summaries and forks copy them.';
comment on column public.workspace_share_links.include_owner_records is
  'UX12-SHARE: guests read the workspace owner''s own attempts and highlights. Never forked.';

-- ---------------------------------------------------------------------------------------------
-- May this fork copy this item? Pinned at request time AND on the link right now. A link that
-- cannot be read refuses (fail closed); the commit has already checked that it exists.
-- ---------------------------------------------------------------------------------------------
create function public.fork_item_included(p_fork public.workspace_forks, p_item text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((p_fork.source_snapshot_manifest -> 'include' ->> p_item)::boolean, true)
         and coalesce((
           select case p_item
                    when 'notes' then l.include_notes
                    when 'ai_explanations' then l.include_ai_explanations
                    when 'summary' then l.include_summary
                    else false
                  end
             from public.workspace_share_links l
            where l.id = p_fork.source_share_link_id
              and l.workspace_id = p_fork.source_workspace_id
         ), false)
$$;

comment on function public.fork_item_included(public.workspace_forks, text) is
  'UX12-SHARE: an item is copied only when the manifest pinned it on and the link still has it on.';

-- ---------------------------------------------------------------------------------------------
-- Fork commit and copy triggers
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
  keep_summary boolean;
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
  -- UX12-SHARE: read after the link's FOR SHARE lock above, so a PATCH either committed before
  -- this line or waits for this commit.
  keep_summary := public.fork_item_included(f, 'summary');

  insert into public.workspaces (id, name, owner_id, status)
  values (tws, f.name, f.forked_by, 'active');
  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (tws, f.forked_by, 'owner');

  create temporary table fork_docs on commit drop as
    select * from public.worker_fork_documents(p_fork_id);

  -- Documents (processing until their revision is published below). DOCSUM-B: the summary
  -- opt-in is copied as it is (null stays null), attributed to the person forking. UX12-SHARE:
  -- a link without summaries copies no opt-in either.
  insert into public.documents (id, workspace_id, document_type, title, filename, content_type,
                                size_bytes, sha256, source_object_key, status, created_by,
                                created_at, summary_enabled_at, summary_enabled_by)
  select p.target_document_id, tws, d.document_type, d.title, d.filename, d.content_type,
         d.size_bytes, d.sha256, p.target_object_key, 'processing', f.forked_by, d.created_at,
         case when keep_summary then d.summary_enabled_at end,
         case when keep_summary and d.summary_enabled_at is not null then f.forked_by end
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
     where keep_summary
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

create or replace function public.fork_copy_chapter_notes()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  salt uuid := (new.source_snapshot_manifest ->> 'id_salt')::uuid;
begin
  if salt is null or new.target_workspace_id is null
     or not public.fork_item_included(new, 'notes') then
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

create or replace function public.fork_copy_question_ai_explanations()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  salt uuid := (new.source_snapshot_manifest ->> 'id_salt')::uuid;
begin
  if salt is null or new.target_workspace_id is null
     or not public.fork_item_included(new, 'ai_explanations') then
    return null;
  end if;

  insert into public.question_ai_explanations (id, workspace_id, question_id,
                                               question_revision_id, version, regenerated, status,
                                               job_id, prompt_version, model, body, sources,
                                               error_code, truncated, dropped_citations,
                                               created_by, created_at, started_at, finished_at)
  select public.fork_remap_id(salt, e.id), new.target_workspace_id,
         public.fork_remap_id(salt, e.question_id),
         public.fork_remap_id(salt, e.question_revision_id), 1, false, 'succeeded', null,
         e.prompt_version, e.model, e.body, s.sources, null, e.truncated, e.dropped_citations,
         new.forked_by, e.created_at, e.started_at, e.finished_at
    from (
      select distinct on (x.question_revision_id) x.*
        from pg_catalog.jsonb_array_elements(new.source_snapshot_manifest -> 'questions') as m
        join public.question_ai_explanations x
          on x.question_id = (m ->> 'question_id')::uuid
         and x.question_revision_id = (m ->> 'revision_id')::uuid
         and x.workspace_id = new.source_workspace_id
       where x.status = 'succeeded'
         and x.superseded_at is null
       order by x.question_revision_id, x.created_at desc, x.id desc
    ) e
    -- The copied question must exist in the target (worker_fork_commit copied it).
    join public.questions tq
      on tq.id = public.fork_remap_id(salt, e.question_id)
     and tq.workspace_id = new.target_workspace_id
    cross join lateral (
      select coalesce(
               pg_catalog.jsonb_agg(
                 src || pg_catalog.jsonb_build_object(
                          'document_id', p.target_document_id::text,
                          'document_revision_id', p.target_revision_id::text,
                          'chapter_id', case when src ->> 'chapter_id' is null then null
                                             else public.fork_remap_id(
                                                    salt, (src ->> 'chapter_id')::uuid)::text
                                        end)
                 order by el.ord),
               '[]'::jsonb) as sources
        from pg_catalog.jsonb_array_elements(e.sources) with ordinality as el(src, ord)
        join public.worker_fork_documents(new.id) p
          on p.source_document_id = (src ->> 'document_id')::uuid
    ) s
  on conflict (id) do nothing;
  return null;
end;
$$;

comment on function public.fork_copy_chapter_notes() is
  'CHNOTE trigger: copy the source-matched newest chapter notes into a completed fork.';

comment on function public.fork_copy_question_ai_explanations() is
  'EXPL trigger: copy the newest succeeded AI explanation of each copied question revision.';

-- ---------------------------------------------------------------------------------------------
-- Privileges: called only from the SECURITY DEFINER functions above, as their owner.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.fork_item_included(public.workspace_forks, text)
  from public, anon, authenticated, quiz_api, quiz_worker;
