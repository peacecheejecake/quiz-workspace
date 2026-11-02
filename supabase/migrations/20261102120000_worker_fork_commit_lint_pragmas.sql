-- UX7-DBLINT: `make db-lint` (plpgsql_check) reported
--   public.worker_fork_commit: relation "pg_temp.fork_docs" does not exist
-- This is a false positive, not a runtime bug: worker_fork_commit creates fork_docs,
-- fork_summary_runs, fork_questions and fork_sources itself (CREATE TEMPORARY TABLE ... ON COMMIT
-- DROP) in the same call that reads them, after every early return, and drops them before it
-- returns; the worker calls it as one statement in one transaction (PostgresForkStore.commit), so
-- no other session, pooled connection or retry depends on a temp table from an earlier step.
-- plpgsql_check checks every statement statically, before any of them runs, so it cannot see
-- those tables. The fix declares them with plpgsql_check's `table` pragma, written in its
-- string-constant form (`perform 'pragma:...'`): a no-op at run time that needs neither the
-- extension nor a stub plpgsql_check_pragma() function in production, while the lint still
-- checks every column reference against the declared shape (keep them in sync with the CREATE
-- statements below).
-- Only the body changes (20261029120000 plus the pragma lines); owner, SECURITY DEFINER, comment
-- and grants stay as they are and are restated for clarity.

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
