-- S3a: workspace forks (docs/workspace-sharing.md §1, §4-§6, docs/screens/workspace-fork.md
-- WS-FORK-01, docs/architecture.md §13).
--
-- A signed-in user holding a usable share link with `allow_fork` asks for an independent copy of
-- the workspace's *published* snapshot. The API pins the snapshot (`source_snapshot_manifest`:
-- the published active revision of every live document and the active revision of every
-- CONFIRMED live question) and enqueues a `workspace.fork` job; the worker copies the Storage
-- objects and indexes the copied revisions (inactive) in Qdrant, then calls
-- `worker_fork_commit`, which re-checks the link under a lock and writes the whole copy in ONE
-- transaction. So:
--   * the target workspace exists only once the fork is COMPLETED: a cancelled or failed fork
--     never leaves DB rows behind (the job's cleanup removes the copied Storage objects and
--     Qdrant points);
--   * a revoke / expiry / allow_fork OFF / source delete that commits before the re-check
--     cancels the fork; one that comes later waits for the commit (FOR SHARE on the source
--     workspace and the link) and no longer affects the finished copy.
--
-- Lifecycle (`status`): PENDING --worker starts--> COPYING --commit--> COMPLETED
--                       PENDING|COPYING --> CANCELLED (link unusable) | FAILED (job failed)
--   terminal states never change again (trigger below).
--
-- Id remap: every copied row gets `fork_remap_id(manifest.id_salt, source id)` (deterministic
-- per fork, so a retried attempt computes the same ids and Storage keys; the random per-fork salt
-- makes them unrelated to the source ids for anyone without the manifest). Content block ids
-- (`content_blocks.block_id`), chapter section keys and MCQ option ids are content identifiers,
-- stable across revisions, and are kept as they are.
--
-- What is copied: documents (with their pinned revision as revision 1), chapters, content
-- blocks, CONFIRMED questions (pinned revision as version 1, chapter remapped when it belongs to
-- a copied revision), their sources in copied documents (cited revision -> the copied revision
-- of that document; block ids are stable), lineage between two copied questions. Never copied:
-- older revisions, drafts, import/generation runs and drafts, practice sessions, attempts,
-- per-user study state (favourite/retry), activity, share links, memberships, upload intents,
-- jobs. Copied rows are created by the forking user; documents and questions keep their
-- `created_at` so the copy lists in the source order.
--
-- `target_workspace_id` deviates from the doc sketch (`not null unique`): it is NULL until the
-- fork is COMPLETED (the workspace does not exist before) and set NULL if an operator ever hard
-- deletes the copy; `source_*` are SET NULL on a hard delete of the source, while
-- `origin_attribution` keeps the provenance (docs/workspace-sharing.md §4).

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------
create table public.workspace_forks (
  id uuid primary key default gen_random_uuid(),
  source_workspace_id uuid references public.workspaces (id) on delete set null,
  source_share_link_id uuid references public.workspace_share_links (id) on delete set null,
  target_workspace_id uuid references public.workspaces (id) on delete set null,
  forked_by uuid not null references auth.users (id) on delete cascade,
  -- Name of the new workspace (same rule as workspaces_name_length).
  name text not null,
  async_job_id uuid references public.async_jobs (id) on delete set null,
  -- {version: 1, id_salt, target_workspace_id, documents: [{document_id, revision_id}],
  --  questions: [{question_id, revision_id}]}; written once by the API.
  source_snapshot_manifest jsonb not null,
  -- {source_workspace_id, source_workspace_name, source_share_link_id, forked_at}; no owner data.
  origin_attribution jsonb not null,
  status text not null default 'PENDING',
  progress smallint not null default 0,
  -- Stable, sanitized error code of a FAILED / CANCELLED fork (never content or secrets).
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint workspace_forks_target_workspace_id_key unique (target_workspace_id),
  constraint workspace_forks_name_length check (btrim(name) <> '' and char_length(name) <= 200),
  constraint workspace_forks_status_valid
    check (status in ('PENDING', 'COPYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  constraint workspace_forks_progress_range check (progress between 0 and 100),
  constraint workspace_forks_completed_at check ((status = 'COMPLETED') = (completed_at is not null)),
  -- The copy is visible only once complete (an operator hard delete may clear it afterwards).
  constraint workspace_forks_target_only_when_completed
    check (status = 'COMPLETED' or target_workspace_id is null),
  constraint workspace_forks_manifest_shape check (
    jsonb_typeof(source_snapshot_manifest) = 'object'
    and jsonb_typeof(source_snapshot_manifest -> 'documents') = 'array'
    and jsonb_typeof(source_snapshot_manifest -> 'questions') = 'array'
    and jsonb_typeof(source_snapshot_manifest -> 'id_salt') = 'string'
    and jsonb_typeof(source_snapshot_manifest -> 'target_workspace_id') = 'string'
  ),
  constraint workspace_forks_manifest_size
    check (pg_column_size(source_snapshot_manifest) <= 4194304),
  constraint workspace_forks_attribution_object check (jsonb_typeof(origin_attribution) = 'object'),
  constraint workspace_forks_attribution_size check (pg_column_size(origin_attribution) <= 8192),
  constraint workspace_forks_last_error_length
    check (last_error is null or char_length(last_error) <= 500)
);

comment on table public.workspace_forks is
  'S3a: independent copies of a shared workspace''s published snapshot (one row per fork request).';

-- GET /me/forks/{id} reads by id; the per-user listing and the FK columns get indexes.
create index workspace_forks_forked_by_created_idx
  on public.workspace_forks (forked_by, created_at desc);
create index workspace_forks_source_workspace_idx
  on public.workspace_forks (source_workspace_id) where source_workspace_id is not null;
create index workspace_forks_source_share_link_idx
  on public.workspace_forks (source_share_link_id) where source_share_link_id is not null;
create index workspace_forks_async_job_idx
  on public.workspace_forks (async_job_id) where async_job_id is not null;

create trigger workspace_forks_set_updated_at
  before update on public.workspace_forks
  for each row execute function public.set_updated_at();

-- Terminal states are final and the request (who, what, which snapshot) is immutable. FK
-- actions (SET NULL of the source / target / job references) still pass.
create function public.workspace_forks_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('COMPLETED', 'FAILED', 'CANCELLED') and new.status is distinct from old.status
  then
    raise exception 'fork % is already %', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.forked_by is distinct from old.forked_by
     or new.name is distinct from old.name
     or new.source_snapshot_manifest is distinct from old.source_snapshot_manifest
     or new.origin_attribution is distinct from old.origin_attribution
     or (new.source_workspace_id is distinct from old.source_workspace_id
         and new.source_workspace_id is not null)
     or (new.source_share_link_id is distinct from old.source_share_link_id
         and new.source_share_link_id is not null)
  then
    raise exception 'fork % request is immutable', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_forks_guard() from public, anon, authenticated;

create trigger workspace_forks_guard
  before update on public.workspace_forks
  for each row execute function public.workspace_forks_guard();

-- ---------------------------------------------------------------------------------------------
-- Id remap and the per-document copy plan (shared by the worker and the commit function, so
-- Storage keys and ids are computed in exactly one place).
-- ---------------------------------------------------------------------------------------------
create function public.fork_remap_id(p_salt uuid, p_id uuid)
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_id is null then null
              else pg_catalog.md5(p_salt::text || ':' || p_id::text)::uuid end
$$;

comment on function public.fork_remap_id(uuid, uuid) is
  'S3a: id of the fork copy of source row p_id (deterministic per fork salt).';

-- One row per pinned document whose pinned revision is still a published revision of it in the
-- fork's source workspace. Keys follow the documents/document_revisions key format checks.
create function public.worker_fork_documents(p_fork_id uuid)
returns table (
  source_document_id uuid,
  source_revision_id uuid,
  target_workspace_id uuid,
  target_document_id uuid,
  target_revision_id uuid,
  document_type text,
  title text,
  source_object_key text,
  target_object_key text,
  source_parsed_object_key text,
  target_parsed_object_key text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with f as (
    select fk.source_workspace_id,
           (fk.source_snapshot_manifest ->> 'id_salt')::uuid as salt,
           (fk.source_snapshot_manifest ->> 'target_workspace_id')::uuid as tws,
           fk.source_snapshot_manifest -> 'documents' as docs
      from public.workspace_forks fk
     where fk.id = p_fork_id
  ),
  pinned as (
    select f.*, (e ->> 'document_id')::uuid as doc, (e ->> 'revision_id')::uuid as rev
      from f, pg_catalog.jsonb_array_elements(f.docs) as e
  ),
  planned as (
    select d.id as sdoc, r.id as srev, p.tws,
           public.fork_remap_id(p.salt, d.id) as tdoc,
           public.fork_remap_id(p.salt, r.id) as trev,
           d.document_type, d.title, d.source_object_key, r.parsed_object_key, d.created_at
      from pinned p
      join public.documents d on d.id = p.doc and d.workspace_id = p.source_workspace_id
      join public.document_revisions r
        on r.id = p.rev and r.document_id = d.id and r.workspace_id = d.workspace_id
       and r.status = 'published'
  )
  select sdoc, srev, tws, tdoc, trev, document_type, title, source_object_key,
         'workspaces/' || tws::text || '/documents/' || tdoc::text || '/revisions/'
           || trev::text || '/source.pdf',
         parsed_object_key,
         case when parsed_object_key is null then null
              else 'workspaces/' || tws::text || '/documents/' || tdoc::text || '/revisions/'
                   || trev::text || '/'
                   || pg_catalog.regexp_replace(parsed_object_key, '^.*/', '') end
    from planned
   order by created_at, sdoc
$$;

comment on function public.worker_fork_documents(uuid) is
  'S3a: copy plan of a fork''s pinned documents (source/target ids and Storage keys).';

-- ---------------------------------------------------------------------------------------------
-- Link re-check (no lock): the worker polls it between steps. True <=> the fork is still
-- running and its link is usable for forking: not revoked, not expired, allow_fork on, link of
-- the fork's source workspace, which is not (being) deleted.
-- ---------------------------------------------------------------------------------------------
create function public.worker_fork_source_usable(p_fork_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select true
      from public.workspace_forks f
      join public.workspaces w on w.id = f.source_workspace_id
      join public.workspace_share_links l
        on l.id = f.source_share_link_id and l.workspace_id = w.id
     where f.id = p_fork_id
       and f.status in ('PENDING', 'COPYING')
       and w.deleted_at is null and w.status <> 'deleted'
       and l.revoked_at is null
       and (l.expires_at is null or l.expires_at > pg_catalog.now())
       and l.allow_fork
  ), false)
$$;

comment on function public.worker_fork_source_usable(uuid) is
  'S3a: may this running fork still copy from its share link? (no lock; see worker_fork_commit)';

-- ---------------------------------------------------------------------------------------------
-- Commit: re-check under a lock, then write the whole copy in the caller's transaction.
-- Returns
--   'completed'  the copy was written now, or by an earlier attempt (idempotent)
--   'unusable'   the link/source is no longer usable for forking: nothing written
--   'cancelled' / 'failed'  the fork already ended that way: nothing written
--   'not_found'  no such fork
-- Lock order (workspace, then link, both FOR SHARE) matches the owner routes (workspace
-- authorization FOR SHARE / FOR NO KEY UPDATE first, then the link UPDATE), so a concurrent
-- revoke / PATCH / delete either committed before (and is seen here) or waits for this commit.
-- `document.index_sync` obligations (same job type, key and attempts as the worker's
-- document_store.INDEX_SYNC_*) make the copied revisions' Qdrant points active even if the
-- worker dies right after the commit.
-- ---------------------------------------------------------------------------------------------
create function public.worker_fork_commit(p_fork_id uuid)
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

  -- Documents (processing until their revision is published below).
  insert into public.documents (id, workspace_id, document_type, title, filename, content_type,
                                size_bytes, sha256, source_object_key, status, created_by,
                                created_at)
  select p.target_document_id, tws, d.document_type, d.title, d.filename, d.content_type,
         d.size_bytes, d.sha256, p.target_object_key, 'processing', f.forked_by, d.created_at
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

  -- Questions: the pinned revision of each pinned question that is still in the source.
  create temporary table fork_questions on commit drop as
    select q.id as sq, qr.id as srev,
           public.fork_remap_id(salt, q.id) as tq,
           public.fork_remap_id(salt, qr.id) as trev
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

  -- Sources in copied documents only; the cited revision becomes the copied revision of that
  -- document (block ids are stable across revisions). Import provenance is not copied.
  insert into public.question_sources (id, workspace_id, question_id, document_id,
                                       document_revision_id, page_start, page_end, block_ids,
                                       locations)
  select public.fork_remap_id(salt, s.id), tws, fq.tq, p.target_document_id,
         case when s.document_revision_id is null then null else p.target_revision_id end,
         s.page_start, s.page_end, s.block_ids, s.locations
    from pg_temp.fork_questions fq
    join public.question_sources s on s.question_id = fq.sq and s.workspace_id = sws
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
  drop table pg_temp.fork_questions;
  return 'completed';
end;
$$;

comment on function public.worker_fork_commit(uuid) is
  'S3a: re-check the fork''s link under a lock and write the whole copy (idempotent).';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table public.workspace_forks from anon, authenticated;

-- quiz_api: create the request (with its job) and read the caller's forks. No UPDATE/DELETE.
grant select, insert on public.workspace_forks to quiz_api;
-- quiz_worker: read the request; move only its progress (PENDING -> COPYING, FAILED, CANCELLED).
-- It cannot complete a fork (completed_at / target_workspace_id stay out of reach); only the
-- commit function does.
grant select on public.workspace_forks to quiz_worker;
grant update (status, progress, last_error, updated_at) on public.workspace_forks to quiz_worker;

revoke all on function public.fork_remap_id(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_fork_documents(uuid) from public, anon, authenticated;
revoke all on function public.worker_fork_source_usable(uuid) from public, anon, authenticated;
revoke all on function public.worker_fork_commit(uuid) from public, anon, authenticated;
grant execute on function public.fork_remap_id(uuid, uuid) to quiz_worker;
grant execute on function public.worker_fork_documents(uuid) to quiz_worker;
grant execute on function public.worker_fork_source_usable(uuid) to quiz_worker;
grant execute on function public.worker_fork_commit(uuid) to quiz_worker;

alter table public.workspace_forks enable row level security;

create policy quiz_api_select on public.workspace_forks
  for select to quiz_api using (true);
create policy quiz_api_insert on public.workspace_forks
  for insert to quiz_api with check (status = 'PENDING' and target_workspace_id is null);
create policy quiz_worker_select on public.workspace_forks
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.workspace_forks
  for update to quiz_worker
  using (status in ('PENDING', 'COPYING'))
  with check (status in ('COPYING', 'FAILED', 'CANCELLED'));
