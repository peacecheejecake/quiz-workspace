-- M3.2a document domain: documents, immutable revisions, revision-scoped chapter tree and
-- canonical content blocks, upload intents, the private Storage buckets, and the composite FKs
-- that M4.1 (20261017180000) deferred to this Task.
--
-- Sources: docs/architecture.md §4 (immutable original + sha256, ParsedDocument / DocumentRevision
-- contracts, indexing flow), §5 (documents, document_revisions, chapters(parent_id),
-- content_blocks(source_location)), docs/deployment.md §2 (upload-intent → direct private upload →
-- complete-upload re-verification → 202 job), §4 (server-generated object keys), docs/auth.md §4
-- (private buckets, signed URLs only after a membership check), implementation-plan §7
-- (`documents.document_type = 'question_paper'` for question PDFs; quiz_worker grants come from
-- the Task's own migration).
--
-- Security model is the baseline's (20261017120000): RLS on every table, no anon/authenticated
-- grants or policies; quiz_api and quiz_worker get exactly the grants listed at the bottom.
--
-- Workspace integrity: every child row carries `workspace_id` and references its parent through a
-- composite FK that includes it, so a revision, chapter, block or upload can never point at a row
-- of another workspace.
--
-- Lifecycle:
--   document_uploads  pending --(complete-upload re-verified the object)--> completed
--                     An intent reserves the document and revision ids up front, so the object key
--                     is final at upload time: workspaces/{ws}/documents/{doc}/revisions/{rev}/source.pdf
--   documents.status  uploading | processing (parse/index job queued or running) | ready | failed
--                     `ready` requires an active (published) revision. A failed re-parse of a ready
--                     document keeps it ready on its previous revision (M3.2b).
--   document_revisions draft --> published (never back). The original PDF is immutable: every
--                     revision of a document points at the same source object.
--
-- Hard deletes: documents are soft-deleted (`deleted_at`); quiz_api has no DELETE on them.
-- Revisions, chapters and blocks cascade only when the document or workspace is hard-deleted by
-- an operator. References from the question domain (and the active revision / upload intent) use
-- NO ACTION, as M4.1 does for history: a stray hard delete of a cited document, revision or
-- chapter fails, while a workspace hard delete (which cascades to both sides in one statement)
-- still works.

-- ---------------------------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- 'question_paper' = a question PDF imported through the same upload path (excluded from book
  -- search by default; implementation-plan §7).
  document_type text not null default 'book',
  title text not null,
  -- Original client filename, display only (never part of an object key).
  filename text not null,
  content_type text not null default 'application/pdf',
  size_bytes bigint not null,
  -- SHA-256 of the immutable original, verified server-side by complete-upload.
  sha256 text not null,
  -- Private bucket object of the original PDF (`source-pdfs`).
  source_object_key text not null,
  status text not null default 'processing',
  -- The published revision search and the viewer use. FK below (needs document_revisions).
  active_revision_id uuid,
  -- Sanitized, user-presentable failure reason of the last processing attempt (no book text).
  last_error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint documents_workspace_id_id_key unique (workspace_id, id),
  constraint documents_source_object_key_key unique (source_object_key),
  constraint documents_document_type_valid check (document_type in ('book', 'question_paper')),
  constraint documents_title_length check (btrim(title) <> '' and char_length(title) <= 300),
  constraint documents_filename_length
    check (btrim(filename) <> '' and char_length(filename) <= 255),
  constraint documents_content_type_pdf check (content_type = 'application/pdf'),
  -- 50 MiB: the `source-pdfs` bucket limit below and the Storage global limit (config.toml).
  constraint documents_size_bytes_range check (size_bytes between 1 and 52428800),
  constraint documents_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint documents_source_object_key_format check (
    source_object_key ~ ('^workspaces/' || workspace_id::text || '/documents/' || id::text
                         || '/revisions/[0-9a-f-]{36}/source\.pdf$')
  ),
  constraint documents_status_valid
    check (status in ('uploading', 'processing', 'ready', 'failed')),
  constraint documents_ready_has_active_revision
    check (status <> 'ready' or active_revision_id is not null),
  constraint documents_last_error_length
    check (last_error is null or char_length(last_error) <= 500)
);

-- Library listing: a workspace's live documents, newest first.
create index documents_workspace_created_idx
  on public.documents (workspace_id, created_at desc, id desc)
  where deleted_at is null;
create index documents_created_by_idx on public.documents (created_by);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- document_revisions: canonical content versions of one document (book_core DocumentRevision).
--   revision_number   1, 2, ... per document
--   parent_revision_id the revision this one was derived from (null for the first parse)
--   content_hash      book_core revision_content_hash of sections + blocks (set by the writer)
--   parser_version    parser that produced the underlying ParsedDocument
--   source_object_key the document's immutable original (same for every revision)
--   parsed_object_key parsed_document.json in `parsed-artifacts` (null until parsed)
-- ---------------------------------------------------------------------------------------------
create table public.document_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  revision_number integer not null,
  parent_revision_id uuid,
  status text not null default 'draft',
  content_hash text,
  parser_version text,
  source_object_key text not null,
  parsed_object_key text,
  published_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_revisions_document_fk foreign key (workspace_id, document_id)
    references public.documents (workspace_id, id) on delete cascade,
  constraint document_revisions_document_number_key unique (document_id, revision_number),
  constraint document_revisions_workspace_id_id_key unique (workspace_id, id),
  constraint document_revisions_workspace_document_id_key unique (workspace_id, document_id, id),
  -- The parent is a revision of the same document.
  constraint document_revisions_parent_fk
    foreign key (workspace_id, document_id, parent_revision_id)
    references public.document_revisions (workspace_id, document_id, id),
  constraint document_revisions_not_own_parent check (parent_revision_id <> id),
  constraint document_revisions_number_positive check (revision_number >= 1),
  constraint document_revisions_status_valid check (status in ('draft', 'published')),
  constraint document_revisions_published_at
    check ((status = 'published') = (published_at is not null)),
  constraint document_revisions_content_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  constraint document_revisions_parser_version_length
    check (parser_version is null or char_length(parser_version) between 1 and 100),
  constraint document_revisions_source_object_key_format check (
    source_object_key ~ ('^workspaces/' || workspace_id::text || '/documents/' || document_id::text
                         || '/revisions/[0-9a-f-]{36}/source\.pdf$')
  ),
  constraint document_revisions_parsed_object_key_format check (
    parsed_object_key is null
    or parsed_object_key ~ ('^workspaces/' || workspace_id::text || '/documents/'
                            || document_id::text || '/revisions/' || id::text || '/[A-Za-z0-9._-]{1,100}$')
  )
);

create index document_revisions_document_idx
  on public.document_revisions (workspace_id, document_id, revision_number desc);
create index document_revisions_parent_idx
  on public.document_revisions (parent_revision_id) where parent_revision_id is not null;

create trigger document_revisions_set_updated_at
  before update on public.document_revisions
  for each row execute function public.set_updated_at();

-- A published revision stays published and keeps its content identity (search, question sources
-- and forks cite it); drafts may change freely.
create function public.document_revisions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'published' and (
       new.status is distinct from old.status
       or new.content_hash is distinct from old.content_hash
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

revoke all on function public.document_revisions_guard() from public, anon, authenticated;

create trigger document_revisions_guard
  before update on public.document_revisions
  for each row execute function public.document_revisions_guard();

-- documents.active_revision_id -> a revision of the same document (composite FK) ...
alter table public.documents
  add constraint documents_active_revision_fk
    foreign key (workspace_id, id, active_revision_id)
    references public.document_revisions (workspace_id, document_id, id);

-- ... that is published (a CHECK cannot look at another table).
create function public.documents_active_revision_published()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.active_revision_id is not null
     and (tg_op = 'INSERT' or new.active_revision_id is distinct from old.active_revision_id)
     and not exists (
       select 1 from public.document_revisions r
        where r.id = new.active_revision_id and r.status = 'published'
     ) then
    raise exception 'active revision of document % must be published', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.documents_active_revision_published()
  from public, anon, authenticated;

create trigger documents_active_revision_published
  before insert or update of active_revision_id on public.documents
  for each row execute function public.documents_active_revision_published();

-- ---------------------------------------------------------------------------------------------
-- chapters: the chapter/section tree of one revision (book_core Section).
--   section_key       the parser's section id, stable across revisions of the document; lets
--                     later revisions (and questions.chapter_id remaps) find "the same" chapter
--   parent_id         parent chapter in the same revision (null = top level)
--   heading_block_id  content_blocks.block_id of the heading that opens it, when known
--   page              1-based PDF page of that heading
-- ---------------------------------------------------------------------------------------------
create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  document_revision_id uuid not null,
  parent_id uuid,
  section_key text not null,
  level smallint not null,
  sort_order integer not null default 0,
  title text not null,
  page integer,
  heading_block_id text,
  created_at timestamptz not null default now(),
  constraint chapters_revision_fk foreign key (workspace_id, document_id, document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) on delete cascade,
  constraint chapters_workspace_id_id_key unique (workspace_id, id),
  constraint chapters_revision_id_key unique (document_revision_id, id),
  constraint chapters_revision_section_key unique (document_revision_id, section_key),
  constraint chapters_parent_fk foreign key (document_revision_id, parent_id)
    references public.chapters (document_revision_id, id) on delete cascade,
  constraint chapters_not_own_parent check (parent_id <> id),
  constraint chapters_section_key_format
    check (section_key ~ '^\S+$' and char_length(section_key) <= 256),
  constraint chapters_level_range check (level between 1 and 20),
  constraint chapters_sort_order_non_negative check (sort_order >= 0),
  constraint chapters_title_length check (btrim(title) <> '' and char_length(title) <= 1000),
  constraint chapters_page_positive check (page is null or page >= 1),
  constraint chapters_heading_block_id_format
    check (heading_block_id is null
           or (heading_block_id ~ '^\S+$' and char_length(heading_block_id) <= 256))
);

-- Outline: a revision's tree in order.
create index chapters_revision_tree_idx
  on public.chapters (document_revision_id, parent_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- content_blocks: canonical, user-correctable blocks of one revision (book_core Block).
--   block_id    opaque book_core Identifier, stable across revisions of the document
--               (question_sources.block_ids, search chunks and lineage cite it)
--   ordinal     reading order within the revision
--   chapter_id  the section the block belongs to (same revision)
--   page        first PDF page of the block (navigation); full provenance in `provenance`
--   provenance  {"locations": SourceLocation[], "source_block_ids": [...]}
--   attributes  type-specific data: heading_level, table cells, caption_block_id
--   edited      the text was corrected by a user in this or an earlier revision
-- ---------------------------------------------------------------------------------------------
create table public.content_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  document_revision_id uuid not null,
  block_id text not null,
  ordinal integer not null,
  chapter_id uuid,
  block_type text not null,
  text text not null default '',
  page integer not null,
  provenance jsonb not null,
  attributes jsonb not null default '{}'::jsonb,
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_blocks_revision_fk foreign key (workspace_id, document_id, document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) on delete cascade,
  constraint content_blocks_chapter_fk foreign key (document_revision_id, chapter_id)
    references public.chapters (document_revision_id, id) on delete set null (chapter_id),
  constraint content_blocks_workspace_id_id_key unique (workspace_id, id),
  constraint content_blocks_revision_block_key unique (document_revision_id, block_id),
  constraint content_blocks_revision_ordinal_key unique (document_revision_id, ordinal),
  constraint content_blocks_block_id_format
    check (block_id ~ '^\S+$' and char_length(block_id) <= 256),
  constraint content_blocks_ordinal_non_negative check (ordinal >= 0),
  constraint content_blocks_block_type_valid
    check (block_type in ('heading', 'text', 'table', 'image', 'formula')),
  constraint content_blocks_text_length check (char_length(text) <= 200000),
  constraint content_blocks_page_positive check (page >= 1),
  constraint content_blocks_provenance_shape check (
    jsonb_typeof(provenance) = 'object'
    and jsonb_typeof(provenance -> 'locations') = 'array'
    and jsonb_array_length(provenance -> 'locations') >= 1
  ),
  constraint content_blocks_provenance_size check (pg_column_size(provenance) <= 65536),
  constraint content_blocks_attributes_object check (jsonb_typeof(attributes) = 'object'),
  constraint content_blocks_attributes_size check (pg_column_size(attributes) <= 262144)
);

create index content_blocks_chapter_idx
  on public.content_blocks (chapter_id) where chapter_id is not null;
-- PDF page -> blocks (viewer sync).
create index content_blocks_revision_page_idx
  on public.content_blocks (document_revision_id, page, ordinal);

create trigger content_blocks_set_updated_at
  before update on public.content_blocks
  for each row execute function public.set_updated_at();

-- The content of a published revision is frozen: chapters and blocks can only be written while
-- their revision is a draft (a correction creates a new draft revision, DOC-02-AC02). A cascade
-- from a hard delete of the revision itself still goes through: by then the revision row is gone.
create function public.revision_content_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  revision_id uuid := case when tg_op = 'DELETE' then old.document_revision_id
                           else new.document_revision_id end;
begin
  if exists (
       select 1 from public.document_revisions r
        where r.id = revision_id and r.status = 'published'
     )
     or (tg_op = 'UPDATE' and new.document_revision_id is distinct from old.document_revision_id
         and exists (select 1 from public.document_revisions r
                      where r.id = old.document_revision_id and r.status = 'published')) then
    raise exception 'content of published document revision % is immutable', revision_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.revision_content_guard() from public, anon, authenticated;

create trigger chapters_revision_content_guard
  before insert or update or delete on public.chapters
  for each row execute function public.revision_content_guard();
create trigger content_blocks_revision_content_guard
  before insert or update or delete on public.content_blocks
  for each row execute function public.revision_content_guard();

-- ---------------------------------------------------------------------------------------------
-- document_uploads: upload intents (docs/deployment.md §2). Created by upload-intent with the ids
-- the document and its first revision will get; completed once by complete-upload after the API
-- re-verified the stored object (existence, size, sha256). Never trusted from Storage events.
-- ---------------------------------------------------------------------------------------------
create table public.document_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The uploader: only they can complete the intent (verified JWT sub at creation).
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null,
  revision_id uuid not null,
  document_type text not null default 'book',
  title text not null,
  filename text not null,
  content_type text not null default 'application/pdf',
  expected_size_bytes bigint not null,
  expected_sha256 text not null,
  object_key text not null,
  status text not null default 'pending',
  expires_at timestamptz not null,
  completed_at timestamptz,
  completed_document_id uuid,
  completed_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_uploads_workspace_id_id_key unique (workspace_id, id),
  constraint document_uploads_document_id_key unique (document_id),
  constraint document_uploads_revision_id_key unique (revision_id),
  constraint document_uploads_object_key_key unique (object_key),
  constraint document_uploads_document_fk foreign key (workspace_id, completed_document_id)
    references public.documents (workspace_id, id),
  constraint document_uploads_job_fk foreign key (workspace_id, completed_job_id)
    references public.async_jobs (workspace_id, id) on delete set null (completed_job_id),
  constraint document_uploads_document_type_valid
    check (document_type in ('book', 'question_paper')),
  constraint document_uploads_title_length
    check (btrim(title) <> '' and char_length(title) <= 300),
  constraint document_uploads_filename_length
    check (btrim(filename) <> '' and char_length(filename) <= 255),
  constraint document_uploads_content_type_pdf check (content_type = 'application/pdf'),
  constraint document_uploads_size_range check (expected_size_bytes between 1 and 52428800),
  constraint document_uploads_sha256_format check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  -- The key is derived from server-generated ids only.
  constraint document_uploads_object_key_derived check (
    object_key = 'workspaces/' || workspace_id::text || '/documents/' || document_id::text
                 || '/revisions/' || revision_id::text || '/source.pdf'
  ),
  constraint document_uploads_status_valid check (status in ('pending', 'completed')),
  constraint document_uploads_completed_state check (
    (status = 'pending' and completed_at is null and completed_document_id is null
       and completed_job_id is null)
    or (status = 'completed' and completed_at is not null
          and completed_document_id is not distinct from document_id)
  ),
  constraint document_uploads_expiry_after_creation check (expires_at > created_at)
);

create index document_uploads_user_idx on public.document_uploads (user_id);
-- Sweep of stale intents (and their orphaned objects).
create index document_uploads_pending_expiry_idx
  on public.document_uploads (expires_at) where status = 'pending';

create trigger document_uploads_set_updated_at
  before update on public.document_uploads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Deferred M4.1 references: composite (workspace_id, col) FKs to the tables above. Added NOT VALID
-- and validated separately so the scan does not hold the stronger lock.
-- ---------------------------------------------------------------------------------------------
alter table public.questions
  add constraint questions_chapter_fk foreign key (workspace_id, chapter_id)
    references public.chapters (workspace_id, id) not valid;

alter table public.question_sources
  add constraint question_sources_document_fk foreign key (workspace_id, document_id)
    references public.documents (workspace_id, id) not valid,
  -- The revision belongs to the cited document.
  add constraint question_sources_document_revision_fk
    foreign key (workspace_id, document_id, document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) not valid,
  add constraint question_sources_revision_needs_document
    check (document_revision_id is null or document_id is not null) not valid;

alter table public.question_import_runs
  add constraint question_import_runs_document_fk foreign key (workspace_id, source_document_id)
    references public.documents (workspace_id, id) not valid,
  add constraint question_import_runs_document_revision_fk
    foreign key (workspace_id, source_document_id, source_document_revision_id)
    references public.document_revisions (workspace_id, document_id, id) not valid,
  add constraint question_import_runs_revision_needs_document
    check (source_document_revision_id is null or source_document_id is not null) not valid,
  add constraint question_import_runs_target_chapter_fk foreign key (workspace_id, target_chapter_id)
    references public.chapters (workspace_id, id) not valid;

alter table public.questions validate constraint questions_chapter_fk;
alter table public.question_sources validate constraint question_sources_document_fk;
alter table public.question_sources validate constraint question_sources_document_revision_fk;
alter table public.question_sources validate constraint question_sources_revision_needs_document;
alter table public.question_import_runs validate constraint question_import_runs_document_fk;
alter table public.question_import_runs
  validate constraint question_import_runs_document_revision_fk;
alter table public.question_import_runs
  validate constraint question_import_runs_revision_needs_document;
alter table public.question_import_runs validate constraint question_import_runs_target_chapter_fk;

create index question_import_runs_source_document_idx
  on public.question_import_runs (source_document_id) where source_document_id is not null;
create index question_import_runs_target_chapter_idx
  on public.question_import_runs (target_chapter_id) where target_chapter_id is not null;
create index question_sources_document_revision_idx
  on public.question_sources (document_revision_id) where document_revision_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Private Storage buckets. Objects are reached only by the API/worker with the server-side secret
-- key (which bypasses Storage RLS) or through short-lived signed URLs the API issues after a
-- membership check. storage.objects has RLS enabled by Supabase and this migration adds no
-- policy for anon/authenticated, so the Storage API refuses every direct client request.
-- Limits are enforced by Storage on upload, independently of the API's own validation.
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('source-pdfs', 'source-pdfs', false, 52428800, array['application/pdf']),
  ('parsed-artifacts', 'parsed-artifacts', false, 52428800, array['application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.documents,
  public.document_revisions,
  public.chapters,
  public.content_blocks,
  public.document_uploads
from anon, authenticated;

-- quiz_api: soft delete is an UPDATE (no DELETE on documents). Draft revisions are rebuilt by
-- replacing their chapters/blocks, hence DELETE there.
grant select, insert, update on public.documents to quiz_api;
grant select, insert, update on public.document_revisions to quiz_api;
grant select, insert, update, delete on public.chapters to quiz_api;
grant select, insert, update, delete on public.content_blocks to quiz_api;
grant select, insert, update on public.document_uploads to quiz_api;

-- quiz_worker (parse/index jobs, M3.2b): reads the upload intent and the document, writes the
-- parse result into the revision (chapters + blocks; DELETE so a retried attempt can replace a
-- partial draft) and moves the document's processing state. It cannot create documents, change a
-- document's identity, workspace or source object, or touch uploads.
grant select on public.document_uploads to quiz_worker;
grant select on public.documents to quiz_worker;
grant update (status, active_revision_id, last_error, updated_at) on public.documents
  to quiz_worker;
grant select, insert on public.document_revisions to quiz_worker;
grant update (status, content_hash, parser_version, parsed_object_key, published_at, updated_at)
  on public.document_revisions to quiz_worker;
grant select, insert, delete on public.chapters to quiz_worker;
grant select, insert, delete on public.content_blocks to quiz_worker;

-- Trigger functions need no EXECUTE grant to fire (as in the baseline's set_updated_at).

-- ---------------------------------------------------------------------------------------------
-- Row level security: enabled everywhere; policies only for the roles granted above.
-- ---------------------------------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.document_revisions enable row level security;
alter table public.chapters enable row level security;
alter table public.content_blocks enable row level security;
alter table public.document_uploads enable row level security;

create policy quiz_api_all on public.documents
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.document_revisions
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.chapters
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.content_blocks
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.document_uploads
  for all to quiz_api using (true) with check (true);

create policy quiz_worker_select on public.document_uploads
  for select to quiz_worker using (true);
create policy quiz_worker_select on public.documents
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.documents
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.document_revisions
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.document_revisions
  for insert to quiz_worker with check (true);
create policy quiz_worker_update on public.document_revisions
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.chapters
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.chapters
  for insert to quiz_worker with check (true);
create policy quiz_worker_delete on public.chapters
  for delete to quiz_worker using (true);
create policy quiz_worker_select on public.content_blocks
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.content_blocks
  for insert to quiz_worker with check (true);
create policy quiz_worker_delete on public.content_blocks
  for delete to quiz_worker using (true);
