-- UX12 CHAPTER-8 Workspace chapters (UX12-CHAPTERADD, docs/screens/ux12-chapter-add.md,
-- docs/questions.md §14.6; user decision 2026-11-06): chapters in a workspace without a book.
--
-- A Workspace chapter is a `chapters` row with neither document nor revision. It is no published
-- content, so revision_content_guard does not apply (no revision to lock) and the API writes it with
-- its existing `chapters` grant. Inner joins through the document or the revision (notes, summaries,
-- search, the outline) skip it, which is right: it has no text. See the spec for every reader.
--
-- workspace_chapter_trees is its lock and version, as the document row is for a book's tree. Not the
-- workspace row: every write holds that FOR SHARE, so taking it stronger would wait on all of them.
-- Lock order: workspace FOR SHARE -> tree row -> documents -> questions. A missing row means there
-- are no Workspace chapters.
--
-- Additive: two columns lose NOT NULL, one nullable column, new constraints hold for every existing
-- row (`not valid`, then validated), one table, one trigger, two function bodies from 20261106160000.
-- Only the new API writes such rows.

alter table public.chapters alter column document_id drop not null;
alter table public.chapters alter column document_revision_id drop not null;

-- chapters_revision_fk reaches the workspace only through a revision, so these rows need a way of
-- their own. Not a foreign key on `workspace_id`: that would also cascade to book chapters, possibly
-- ahead of their revision, which revision_content_guard refuses while the revision is published.
-- This column is the workspace on Workspace chapters and null on all others.
alter table public.chapters
  add column workspace_level_of uuid;

alter table public.chapters
  add constraint chapters_workspace_level_valid check (
    (document_id is null) = (document_revision_id is null)
    and workspace_level_of is not distinct from
        (case when document_revision_id is null then workspace_id end)
    and (document_id is not null
         or (section_key ~ '^user-[0-9a-f-]{36}$' and page is null and heading_block_id is null))
  ) not valid,
  add constraint chapters_workspace_level_fk foreign key (workspace_level_of)
    references public.workspaces (id) on delete cascade not valid,
  -- chapters_parent_fk is not checked when the revision is null.
  add constraint chapters_workspace_parent_fk foreign key (workspace_id, parent_id)
    references public.chapters (workspace_id, id) on delete cascade not valid;
alter table public.chapters validate constraint chapters_workspace_level_valid;
alter table public.chapters validate constraint chapters_workspace_level_fk;
alter table public.chapters validate constraint chapters_workspace_parent_fk;

create index chapters_workspace_level_idx
  on public.chapters (workspace_level_of, sort_order) where workspace_level_of is not null;

comment on column public.chapters.workspace_level_of is
  'UX12-CHAPTERADD: the workspace of a Workspace chapter (the row without document or revision).';

comment on constraint chapters_workspace_level_valid on public.chapters is
  'UX12-CHAPTERADD: a Workspace chapter has neither document nor revision, a user key and no page.';

-- ---------------------------------------------------------------------------------------------
-- A Workspace chapter's parent is a Workspace chapter. After the row: a tree copied in one statement
-- has its parents by the time this runs.
-- ---------------------------------------------------------------------------------------------
create function public.chapters_workspace_parent_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (select 1 from public.chapters p
              where p.id = new.parent_id and p.document_revision_id is not null) then
    raise exception 'the parent of Workspace chapter % is a document chapter', new.id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

comment on function public.chapters_workspace_parent_guard() is
  'UX12-CHAPTERADD trigger: a Workspace chapter hangs under a Workspace chapter or nothing.';

revoke all on function public.chapters_workspace_parent_guard()
  from public, anon, authenticated, quiz_api, quiz_worker;

create trigger chapters_workspace_parent_guard
  after insert or update of parent_id, document_revision_id on public.chapters
  for each row
  when (new.document_revision_id is null and new.parent_id is not null)
  execute function public.chapters_workspace_parent_guard();

-- ---------------------------------------------------------------------------------------------
-- The tree's lock and version
-- ---------------------------------------------------------------------------------------------
create table public.workspace_chapter_trees (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  version bigint not null default 0,
  constraint workspace_chapter_trees_version_non_negative check (version >= 0)
);

comment on table public.workspace_chapter_trees is
  'UX12-CHAPTERADD: lock row and optimistic version of a workspace''s Workspace chapter tree.';

revoke all on table public.workspace_chapter_trees from public, anon, authenticated;
grant select, insert, update on public.workspace_chapter_trees to quiz_api;
alter table public.workspace_chapter_trees enable row level security;
create policy quiz_api_all on public.workspace_chapter_trees
  for all to quiz_api using (true) with check (true);

-- ---------------------------------------------------------------------------------------------
-- Import registration (20261106160000 body): a chosen Workspace chapter stays.
-- ---------------------------------------------------------------------------------------------
create or replace function public.worker_register_import_drafts(p_job_id uuid, p_limit integer)
returns table (outcome text, registered integer, skipped integer, refused integer,
               remaining integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job record;
  run record;
  d record;
  item record;
  ids uuid[];
  v_type text;
  v_accepted jsonb;
  v_rubric text;
  v_options jsonb;
  v_chapter uuid;
  v_question uuid;
  v_revision uuid;
  v_payload jsonb;
  n_registered integer := 0;
  n_skipped integer := 0;
  n_refused integer := 0;
begin
  outcome := 'ok';
  registered := 0;
  skipped := 0;
  refused := 0;
  remaining := 0;
  select j.id, j.workspace_id, j.created_by, j.status, j.job_type, j.payload
    into job
    from public.async_jobs j
   where j.id = p_job_id;
  if not found or job.job_type <> 'question.import_register' then
    outcome := 'not_found';
    return next;
    return;
  end if;
  if job.status <> 'running' then
    outcome := 'not_running';
    return next;
    return;
  end if;
  if not public.worker_workspace_writable(job.workspace_id, job.created_by, true) then
    outcome := 'workspace_unavailable';
    return next;
    return;
  end if;
  select r.id, r.workspace_id, r.source_document_id, r.source_document_revision_id
    into run
    from public.question_import_runs r
   where r.workspace_id = job.workspace_id
     and r.id::text = job.payload ->> 'import_id';
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select pg_catalog.array_agg(x.draft_id order by x.position, x.draft_id)
    into ids
    from (
      select i.draft_id, qd.position
        from public.question_import_registration_items i
        join public.question_drafts qd on qd.id = i.draft_id
       where i.job_id = p_job_id and i.state = 'pending'
       order by qd.position, i.draft_id
       limit greatest(coalesce(p_limit, 0), 0)
    ) x;

  if ids is not null then
    perform 1
       from public.question_drafts qd
      where qd.id = any (ids)
      order by qd.position, qd.id
        for update of qd;
    perform 1
       from public.documents doc
      where doc.workspace_id = job.workspace_id
        and doc.id in (
          select c.document_id
            from public.question_import_registration_items i
            join public.chapters c on c.id = i.chapter_id and c.workspace_id = i.workspace_id
           where i.job_id = p_job_id and i.draft_id = any (ids)
        )
      order by doc.id
        for share of doc;

    for item in
      select i.draft_id, i.version, i.chapter_id, i.state
        from public.question_import_registration_items i
        join public.question_drafts qd on qd.id = i.draft_id
       where i.job_id = p_job_id and i.draft_id = any (ids)
       order by qd.position, i.draft_id
         for update of i
    loop
      continue when item.state <> 'pending';
      select qd.id, qd.import_run_id, qd.question_type, qd.question_number, qd.is_multi_answer,
             qd.rubric, qd.payload, qd.review_status, qd.published_question_id, qd.updated_at
        into d
        from public.question_drafts qd
       where qd.id = item.draft_id;

      if d.published_question_id is not null then
        update public.question_import_registration_items
           set state = 'skipped', question_id = d.published_question_id,
               processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_skipped := n_skipped + 1;
        continue;
      end if;
      if d.import_run_id is distinct from run.id
         or pg_catalog.to_hex(
              (extract(epoch from d.updated_at) * 1000000)::bigint) <> item.version then
        update public.question_import_registration_items
           set state = 'refused', reason = 'stale-draft', processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_refused := n_refused + 1;
        continue;
      end if;
      -- UX6-UPLOAD-B: a chapter whose document is no longer a book (종류 변경 to 문제지 after the
      -- selection) is no registration target: refused as changed since the selection (the
      -- reviewer reloads and sees the new chapter), never filed under a question paper.
      if item.chapter_id is not null and exists (
        select 1
          from public.chapters oc
          join public.documents doc
            on doc.id = oc.document_id and doc.workspace_id = oc.workspace_id
         where oc.id = item.chapter_id and oc.workspace_id = job.workspace_id
           and doc.document_type <> 'book'
      ) then
        update public.question_import_registration_items
           set state = 'refused', reason = 'stale-draft', processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_refused := n_refused + 1;
        continue;
      end if;

      begin
        -- The draft's content as quiz_api.question_drafts.content_of reads it.
        v_type := d.payload ->> 'question_type';
        v_accepted := coalesce(d.payload -> 'accepted_answers', 'null'::jsonb);
        v_rubric := d.rubric;
        if v_type = 'ESSAY' then
          if v_rubric is null and pg_catalog.jsonb_typeof(v_accepted) = 'array'
             and pg_catalog.jsonb_array_length(v_accepted) > 0 then
            select pg_catalog.string_agg(a.value, E'\n' order by a.ord)
              into v_rubric
              from pg_catalog.jsonb_array_elements_text(v_accepted) with ordinality as a (value, ord);
          end if;
          v_accepted := 'null'::jsonb;
        end if;
        select coalesce(pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('id', o.value ->> 'id', 'text', o.value ->> 'text')
                 order by o.ord), '[]'::jsonb)
          into v_options
          from pg_catalog.jsonb_array_elements(coalesce(d.payload -> 'options', '[]'::jsonb))
               with ordinality as o (value, ord);

        -- The chosen chapter in its document's current revision (same section), or none.
        v_chapter := null;
        if item.chapter_id is not null then
          select nc.id
            into v_chapter
            from public.chapters oc
            join public.documents doc
              on doc.id = oc.document_id and doc.workspace_id = oc.workspace_id
             and doc.deleted_at is null
            join public.chapters nc
              on nc.document_revision_id = doc.active_revision_id
             and nc.section_key = oc.section_key
           where oc.id = item.chapter_id and oc.workspace_id = job.workspace_id;
          -- A Workspace chapter has no revision to follow.
          if v_chapter is null then
            select c.id
              into v_chapter
              from public.chapters c
             where c.id = item.chapter_id and c.workspace_id = job.workspace_id
               and c.document_revision_id is null
               for key share;
          end if;
        end if;

        v_question := pg_catalog.gen_random_uuid();
        v_revision := pg_catalog.gen_random_uuid();
        insert into public.questions (id, workspace_id, chapter_id, question_type, origin,
                                      question_number, publication_status, created_by)
        values (v_question, job.workspace_id, v_chapter, v_type, 'import', d.question_number,
                'DRAFT', job.created_by);
        insert into public.question_revisions (id, workspace_id, question_id, version, stem,
                                               options, correct_option_ids, accepted_answers,
                                               is_multi_answer, explanation, rubric, created_by,
                                               stem_tables)
        values (
          v_revision, job.workspace_id, v_question, 1, d.payload ->> 'stem', v_options,
          case when pg_catalog.jsonb_typeof(d.payload -> 'correct_option_ids') = 'array'
               then array(select pg_catalog.jsonb_array_elements_text(
                                   d.payload -> 'correct_option_ids')) end,
          case when pg_catalog.jsonb_typeof(v_accepted) = 'array'
               then array(select pg_catalog.jsonb_array_elements_text(v_accepted)) end,
          d.is_multi_answer, d.payload ->> 'explanation', v_rubric, job.created_by,
          -- Older payloads have no key; a dumped draft has JSON null.
          nullif(d.payload -> 'stem_tables', 'null'::jsonb));
        update public.questions
           set active_revision_id = v_revision, publication_status = 'CONFIRMED'
         where id = v_question;
        insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                            target_id, metadata)
        values (job.workspace_id, job.created_by, 'question.created', 'question', v_question,
                pg_catalog.jsonb_build_object('question_type', v_type,
                                              'publication_status', 'CONFIRMED',
                                              'version', 1, 'origin', 'import'));

        -- One source row summarising every evidence region (question_drafts.source_pages).
        with ev as (
          select e.value as evidence, e.ord as ev_ord
            from pg_catalog.jsonb_array_elements(coalesce(d.payload -> 'evidence', '[]'::jsonb))
                 with ordinality as e (value, ord)
        ),
        ev_locations as (
          select l.value, (ev.ev_ord * 100000 + l.ord) as ord
            from ev,
                 pg_catalog.jsonb_array_elements(coalesce(ev.evidence -> 'locations', '[]'::jsonb))
                 with ordinality as l (value, ord)
        ),
        ev_blocks as (
          select b.value as block_id, (ev.ev_ord * 100000 + b.ord) as ord
            from ev,
                 pg_catalog.jsonb_array_elements_text(
                   coalesce(ev.evidence -> 'block_ids', '[]'::jsonb)) with ordinality as b (value, ord)
        )
        insert into public.question_sources (workspace_id, question_id, document_id,
                                             document_revision_id, page_start, page_end,
                                             block_ids, locations, import_run_id)
        select job.workspace_id, v_question, run.source_document_id,
               case when run.source_document_id is not null
                    then run.source_document_revision_id end,
               (select pg_catalog.min((l.value ->> 'page')::integer) from ev_locations l),
               (select pg_catalog.max((l.value ->> 'page')::integer) from ev_locations l),
               coalesce((select array_agg(b.block_id order by b.first_seen)
                           from (select e.block_id, pg_catalog.min(e.ord) as first_seen
                                   from ev_blocks e group by e.block_id) b), '{}'),
               coalesce((select pg_catalog.jsonb_agg(l.value order by l.ord)
                           from ev_locations l), '[]'::jsonb),
               run.id;

        -- The selection is the approval of exactly the content at the selected version; an
        -- earlier approval (reviewer, time) is kept. Only the link is added then.
        v_payload := d.payload;
        if d.review_status <> 'approved' then
          v_payload := d.payload || pg_catalog.jsonb_build_object(
            'review_status', 'approved', 'options', v_options, 'accepted_answers', v_accepted);
          update public.question_drafts
             set review_status = 'approved', reviewed_by = job.created_by,
                 reviewed_at = pg_catalog.now(), payload = v_payload,
                 published_question_id = v_question
           where id = d.id;
        else
          update public.question_drafts set published_question_id = v_question where id = d.id;
        end if;

        update public.question_import_registration_items
           set state = 'registered', question_id = v_question, processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_registered := n_registered + 1;
      exception
        when check_violation or not_null_violation or foreign_key_violation
             or string_data_right_truncation or invalid_text_representation
             or numeric_value_out_of_range then
          -- Rolled back to the block start: nothing of this draft is kept.
          update public.question_import_registration_items
             set state = 'refused', reason = 'not-publishable', processed_at = pg_catalog.now()
           where job_id = p_job_id and draft_id = item.draft_id;
          n_refused := n_refused + 1;
      end;
    end loop;

    if n_registered > 0 then
      -- Ids and counts only, like the API's own `question_import.published`.
      insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                          target_id, metadata)
      values (job.workspace_id, job.created_by, 'question_import.published', 'question_import',
              run.id, pg_catalog.jsonb_build_object('count', n_registered));
    end if;
  end if;

  registered := n_registered;
  skipped := n_skipped;
  refused := n_refused;
  select pg_catalog.count(*)::integer
    into remaining
    from public.question_import_registration_items i
   where i.job_id = p_job_id and i.state = 'pending';
  return next;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Fork commit (20261106160000 body): the copy carries the Workspace chapter tree.
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

  -- UX12-CHAPTERADD: the tree row before the documents (lock order, docs/questions.md §14.6), so a
  -- Workspace chapter edit commits before the copy or waits for it.
  insert into public.workspace_chapter_trees (workspace_id) values (sws)
  on conflict (workspace_id) do nothing;
  perform 1 from public.workspace_chapter_trees t where t.workspace_id = sws for share;

  perform 1
     from public.documents d
    where d.id in (select p.source_document_id from pg_temp.fork_docs p)
    order by d.id
      for share of d;

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

  -- UX12-CHAPTERADD: the whole Workspace chapter tree, also the chapters without questions.
  insert into public.workspace_chapter_trees (workspace_id) values (tws);
  insert into public.chapters (id, workspace_id, workspace_level_of, parent_id, section_key, level,
                               sort_order, title)
  select public.fork_remap_id(salt, c.id), tws, tws, public.fork_remap_id(salt, c.parent_id),
         c.section_key, c.level, c.sort_order, c.title
    from public.chapters c
   where c.workspace_id = sws and c.document_revision_id is null;

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
                or exists (select 1 from public.chapters c
                            where c.id = q.chapter_id and c.workspace_id = sws
                              and c.document_revision_id is null)
              then public.fork_remap_id(salt, q.chapter_id) end,
         q.question_type, q.origin, q.question_number, q.sort_order, 'DRAFT', f.forked_by,
         q.created_at, q.chapter_source
    from pg_temp.fork_questions fq
    join public.questions q on q.id = fq.sq;

  insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                         correct_option_ids, accepted_answers, is_multi_answer,
                                         explanation, rubric, created_by, stem_tables)
  select fq.trev, tws, fq.tq, 1, qr.stem, qr.options, qr.correct_option_ids, qr.accepted_answers,
         qr.is_multi_answer, qr.explanation, qr.rubric, f.forked_by, qr.stem_tables
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
