-- UX12 CHAPTER-4 chapter editing on the active revision (CHMAN-01, docs/questions.md §14.5, D-9).
--
-- A published revision stays frozen except through one path: the `chapter_edit_*` functions below.
-- They are SECURITY DEFINER and carry the function-level setting `quiz.chapter_edit = on`. The
-- guards trust the setting only when the current role is not one of the login roles, so
-- `quiz_api` cannot enable the path with a plain `set_config`. Inside the path:
--   chapters        UPDATE of title, parent_id, level, sort_order only; INSERT of a `user-<uuid>`
--                   chapter without page or heading; DELETE
--   content_blocks  UPDATE of chapter_id only
--   document_revisions.content_hash of a published revision (it covers the section tree and the
--                   worker's load_content verifies it, so it must follow the edit)
-- Every function takes the document row FOR UPDATE itself; the API has already taken the workspace
-- FOR SHARE and the document first (lock order Workspace -> document -> questions, §14.3).
--
-- quiz_api gets EXECUTE only: no new table grant. The API computes the new tree and hash, the
-- functions write them and refuse a tree whose levels do not follow its parents (which also
-- refuses a cycle).
--
-- Correction drafts are copies, so an edit is mirrored into them (`chapter_edit_sync_draft`), by
-- section_key: otherwise publishing the draft would drop `user-*` chapters and null their
-- questions (documents_remap_question_chapters). Restoring an older revision goes through the same
-- function, so it carries the current tree.

alter table public.documents add column chapter_tree_version bigint not null default 0;

comment on column public.documents.chapter_tree_version is
  'CHMAN-01: optimistic lock of the chapter tree; each chapter edit and active revision switch adds 1.';

-- ---------------------------------------------------------------------------------------------
-- A publish changes every chapter id: a screen that read the tree before it is stale.
-- ---------------------------------------------------------------------------------------------
create function public.documents_bump_chapter_tree_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.chapter_tree_version := old.chapter_tree_version + 1;
  return new;
end;
$$;

comment on function public.documents_bump_chapter_tree_version() is
  'CHMAN-01 trigger: a new active revision invalidates chapter_tree_version.';

revoke all on function public.documents_bump_chapter_tree_version()
  from public, anon, authenticated, quiz_api, quiz_worker;

create trigger documents_bump_chapter_tree_version
  before update of active_revision_id on public.documents
  for each row
  when (old.active_revision_id is distinct from new.active_revision_id)
  execute function public.documents_bump_chapter_tree_version();

-- ---------------------------------------------------------------------------------------------
-- History source
-- ---------------------------------------------------------------------------------------------
alter table public.question_chapter_changes
  drop constraint question_chapter_changes_source_valid;
alter table public.question_chapter_changes
  add constraint question_chapter_changes_source_valid
    check (source in ('manual', 'recommendation', 'edit', 'import', 'chapter_edit')) not valid;
alter table public.question_chapter_changes
  validate constraint question_chapter_changes_source_valid;

-- ---------------------------------------------------------------------------------------------
-- Guards: the same rules, plus the chapter_edit path.
-- ---------------------------------------------------------------------------------------------
create function public.chapter_edit_active()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.current_setting('quiz.chapter_edit', true), '') = 'on'
     and current_user not in ('quiz_api', 'quiz_worker', 'authenticated', 'anon', 'service_role')
$$;

comment on function public.chapter_edit_active() is
  'CHMAN-01: true only inside a chapter_edit_* function (their owner role and function setting).';

create or replace function public.revision_content_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  revision_id uuid := case when tg_op = 'DELETE' then old.document_revision_id
                           else new.document_revision_id end;
  now_row jsonb := case when tg_op = 'DELETE' then null else pg_catalog.to_jsonb(new) end;
  was_row jsonb := case when tg_op = 'INSERT' then null else pg_catalog.to_jsonb(old) end;
begin
  if exists (
       select 1 from public.document_revisions r
        where r.id = revision_id and r.status = 'published'
     )
     or (tg_op = 'UPDATE' and new.document_revision_id is distinct from old.document_revision_id
         and exists (select 1 from public.document_revisions r
                      where r.id = old.document_revision_id and r.status = 'published')) then
    if public.chapter_edit_active() and (
         (tg_table_name = 'chapters' and (
            tg_op = 'DELETE'
            or (tg_op = 'INSERT'
                and (now_row ->> 'section_key') ~ '^user-[0-9a-f-]{36}$'
                and (now_row ->> 'page') is null
                and (now_row ->> 'heading_block_id') is null)
            or (tg_op = 'UPDATE'
                and now_row - array['title', 'parent_id', 'level', 'sort_order']
                    = was_row - array['title', 'parent_id', 'level', 'sort_order'])))
         or (tg_table_name = 'content_blocks' and tg_op = 'UPDATE'
             and now_row - array['chapter_id', 'updated_at']
                 = was_row - array['chapter_id', 'updated_at'])
       ) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    raise exception 'content of published document revision % is immutable', revision_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.document_revisions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'published' and (
       new.status is distinct from old.status
       or (new.content_hash is distinct from old.content_hash
           and not public.chapter_edit_active())
       or new.published_at is distinct from old.published_at
       or new.parsed_object_key is distinct from old.parsed_object_key
     ) then
    raise exception 'published document revision % is immutable', old.id
      using errcode = 'check_violation';
  end if;
  if new.source_object_key is distinct from old.source_object_key
     or new.revision_number is distinct from old.revision_number
     or new.parent_revision_id is distinct from old.parent_revision_id then
    raise exception 'document revision % identity is immutable', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The path
-- ---------------------------------------------------------------------------------------------

-- The active revision of a live book, with the document locked. Internal: not callable by a role.
create function public.chapter_edit_revision(p_workspace_id uuid, p_document_id uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  rev uuid;
begin
  select d.active_revision_id into rev
    from public.documents d
   where d.id = p_document_id and d.workspace_id = p_workspace_id and d.deleted_at is null
     and d.document_type = 'book'
     for update;
  if rev is null then
    raise exception 'document % has no chapter tree to edit', p_document_id
      using errcode = 'no_data_found';
  end if;
  return rev;
end;
$$;

comment on function public.chapter_edit_revision(uuid, uuid) is
  'CHMAN-01: lock a live book and return its active revision.';

create function public.chapter_edit_create(
  p_workspace_id uuid, p_document_id uuid, p_chapter_id uuid, p_parent_id uuid, p_title text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
set quiz.chapter_edit = 'on'
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
begin
  -- level and sort_order are placeholders until chapter_edit_tree in the same transaction.
  insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                               section_key, level, sort_order, title)
  values (p_chapter_id, p_workspace_id, p_document_id, rev, p_parent_id,
          'user-' || p_chapter_id::text, 1, 0, p_title);
end;
$$;

comment on function public.chapter_edit_create(uuid, uuid, uuid, uuid, text) is
  'CHMAN-01: add a user chapter to the active revision; chapter_edit_tree places it.';

create function public.chapter_edit_rename(
  p_workspace_id uuid, p_document_id uuid, p_chapter_id uuid, p_title text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
set quiz.chapter_edit = 'on'
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
begin
  update public.chapters c set title = p_title
   where c.id = p_chapter_id and c.document_revision_id = rev;
  if not found then
    raise exception 'chapter % is not in the active revision', p_chapter_id
      using errcode = 'no_data_found';
  end if;
end;
$$;

comment on function public.chapter_edit_rename(uuid, uuid, uuid, text) is
  'CHMAN-01: rename a chapter of the active revision.';

-- Questions must have left first (questions_chapter_fk has no action). Its blocks and children go
-- to its parent; chapter_edit_tree then normalizes levels and order.
create function public.chapter_edit_delete(
  p_workspace_id uuid, p_document_id uuid, p_chapter_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
set quiz.chapter_edit = 'on'
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
  heir uuid;
begin
  select c.parent_id into heir
    from public.chapters c
   where c.id = p_chapter_id and c.document_revision_id = rev;
  if not found then
    raise exception 'chapter % is not in the active revision', p_chapter_id
      using errcode = 'no_data_found';
  end if;
  update public.content_blocks b set chapter_id = heir
   where b.document_revision_id = rev and b.chapter_id = p_chapter_id;
  update public.chapters c set parent_id = heir
   where c.document_revision_id = rev and c.parent_id = p_chapter_id;
  delete from public.chapters c where c.id = p_chapter_id and c.document_revision_id = rev;
end;
$$;

comment on function public.chapter_edit_delete(uuid, uuid, uuid) is
  'CHMAN-01: delete a chapter of the active revision; blocks and children go to its parent.';

-- p_nodes: the whole revision, [{id, parent_id, level, sort_order}].
create function public.chapter_edit_tree(
  p_workspace_id uuid, p_document_id uuid, p_nodes jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
set quiz.chapter_edit = 'on'
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
begin
  update public.chapters c
     set parent_id = n.parent_id, level = n.level, sort_order = n.sort_order
    from pg_catalog.jsonb_to_recordset(p_nodes)
           as n(id uuid, parent_id uuid, level smallint, sort_order integer)
   where c.id = n.id and c.document_revision_id = rev
     and (c.parent_id is distinct from n.parent_id or c.level <> n.level
          or c.sort_order <> n.sort_order);
  if (select pg_catalog.count(*) from public.chapters c where c.document_revision_id = rev)
       <> pg_catalog.jsonb_array_length(p_nodes)
     or exists (
       select 1
         from public.chapters c
         left join public.chapters p on p.id = c.parent_id
        where c.document_revision_id = rev
          and c.level <> coalesce(p.level, 0) + 1
     ) then
    raise exception 'chapter tree of revision % is inconsistent', rev
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function public.chapter_edit_tree(uuid, uuid, jsonb) is
  'CHMAN-01: write parents, levels and pre-order of the whole active revision.';

-- Last step of each edit: the hash of the edited content and the next tree version.
create function public.chapter_edit_finish(
  p_workspace_id uuid, p_document_id uuid, p_content_hash text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
set quiz.chapter_edit = 'on'
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
  next_version bigint;
begin
  update public.document_revisions r set content_hash = p_content_hash where r.id = rev;
  update public.documents d set chapter_tree_version = d.chapter_tree_version + 1
   where d.id = p_document_id
  returning d.chapter_tree_version into next_version;
  return next_version;
end;
$$;

comment on function public.chapter_edit_finish(uuid, uuid, text) is
  'CHMAN-01: store the active revision''s new content hash and bump chapter_tree_version.';

-- Give a draft the active revision's tree, matching chapters by section_key: draft chapters the
-- active revision no longer has hand their blocks to the nearest ancestor that stays, then leave.
-- Titles of parser chapters stay the draft's (a heading correction or a restored title);
-- `p_renamed_key` is the one chapter just renamed; `user-*` chapters follow the active revision.
create function public.chapter_edit_sync_draft(
  p_workspace_id uuid, p_document_id uuid, p_draft_id uuid, p_renamed_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  rev uuid := public.chapter_edit_revision(p_workspace_id, p_document_id);
begin
  if not exists (select 1 from public.document_revisions r
                  where r.id = p_draft_id and r.document_id = p_document_id
                    and r.workspace_id = p_workspace_id and r.status = 'draft') then
    raise exception 'revision % is not a draft of document %', p_draft_id, p_document_id
      using errcode = 'no_data_found';
  end if;

  with recursive gone as (
    select d.id, d.parent_id
      from public.chapters d
     where d.document_revision_id = p_draft_id
       and not exists (select 1 from public.chapters a
                        where a.document_revision_id = rev and a.section_key = d.section_key)
  ), climb (id, heir) as (
    select g.id, g.parent_id from gone g
    union all
    select c.id, g.parent_id from climb c join gone g on g.id = c.heir
  )
  update public.content_blocks b
     set chapter_id = c.heir
    from climb c
   where b.document_revision_id = p_draft_id
     and b.chapter_id = c.id
     and not exists (select 1 from gone g where g.id = c.heir);

  insert into public.chapters (workspace_id, document_id, document_revision_id, section_key, level,
                               sort_order, title, page)
  select a.workspace_id, a.document_id, p_draft_id, a.section_key, a.level, a.sort_order, a.title,
         a.page
    from public.chapters a
   where a.document_revision_id = rev
     and not exists (select 1 from public.chapters d
                      where d.document_revision_id = p_draft_id
                        and d.section_key = a.section_key);

  update public.chapters d
     set parent_id = (select np.id
                        from public.chapters ap
                        join public.chapters np
                          on np.document_revision_id = p_draft_id
                         and np.section_key = ap.section_key
                       where ap.id = a.parent_id),
         level = a.level,
         sort_order = a.sort_order,
         title = case when a.section_key = p_renamed_key or a.section_key like 'user-%'
                      then a.title else d.title end
    from public.chapters a
   where a.document_revision_id = rev
     and d.document_revision_id = p_draft_id
     and d.section_key = a.section_key;

  delete from public.chapters d
   where d.document_revision_id = p_draft_id
     and not exists (select 1 from public.chapters a
                      where a.document_revision_id = rev and a.section_key = d.section_key);
end;
$$;

comment on function public.chapter_edit_sync_draft(uuid, uuid, uuid, text) is
  'CHMAN-01: give a correction or restored draft the active revision''s chapter tree.';

revoke all on function public.chapter_edit_active() from public, anon, authenticated;
revoke all on function public.chapter_edit_revision(uuid, uuid)
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.chapter_edit_create(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, quiz_worker;
revoke all on function public.chapter_edit_rename(uuid, uuid, uuid, text)
  from public, anon, authenticated, quiz_worker;
revoke all on function public.chapter_edit_delete(uuid, uuid, uuid)
  from public, anon, authenticated, quiz_worker;
revoke all on function public.chapter_edit_tree(uuid, uuid, jsonb)
  from public, anon, authenticated, quiz_worker;
revoke all on function public.chapter_edit_finish(uuid, uuid, text)
  from public, anon, authenticated, quiz_worker;
revoke all on function public.chapter_edit_sync_draft(uuid, uuid, uuid, text)
  from public, anon, authenticated, quiz_worker;

-- The guards run as the writing role, so both login roles need the check itself.
grant execute on function public.chapter_edit_active() to quiz_api, quiz_worker;
grant execute on function public.chapter_edit_create(uuid, uuid, uuid, uuid, text) to quiz_api;
grant execute on function public.chapter_edit_rename(uuid, uuid, uuid, text) to quiz_api;
grant execute on function public.chapter_edit_delete(uuid, uuid, uuid) to quiz_api;
grant execute on function public.chapter_edit_tree(uuid, uuid, jsonb) to quiz_api;
grant execute on function public.chapter_edit_finish(uuid, uuid, text) to quiz_api;
grant execute on function public.chapter_edit_sync_draft(uuid, uuid, uuid, text) to quiz_api;

-- ---------------------------------------------------------------------------------------------
-- Fork commit (20261106140000 body): the source documents are held FOR SHARE from the copy plan on,
-- so a chapter edit commits before the copy or waits for it, and a chapter created while the copy
-- runs cannot leave a question pointing at a chapter the copy does not have.
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
