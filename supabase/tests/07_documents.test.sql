-- M3.2a: document domain structure, workspace-scoped integrity, revision immutability, upload
-- intents, the deferred M4.1 FKs, private Storage buckets, grants and RLS.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(144);

-- Structure -------------------------------------------------------------------------------------
select columns_are('public', 'documents',
  array['id', 'workspace_id', 'document_type', 'title', 'filename', 'content_type', 'size_bytes',
        'sha256', 'source_object_key', 'status', 'active_revision_id', 'last_error', 'created_by',
        'created_at', 'updated_at', 'deleted_at',
        -- UX6-UPLOAD-B (20261028120000)
        'type_source', 'content_kind', 'detection']);
select columns_are('public', 'document_revisions',
  array['id', 'workspace_id', 'document_id', 'revision_number', 'parent_revision_id', 'status',
        'content_hash', 'parser_version', 'source_object_key', 'parsed_object_key',
        'published_at', 'created_by', 'created_at', 'updated_at']);
select columns_are('public', 'chapters',
  array['id', 'workspace_id', 'document_id', 'document_revision_id', 'parent_id', 'section_key',
        'level', 'sort_order', 'title', 'page', 'heading_block_id', 'created_at']);
select columns_are('public', 'content_blocks',
  array['id', 'workspace_id', 'document_id', 'document_revision_id', 'block_id', 'ordinal',
        'chapter_id', 'block_type', 'text', 'page', 'provenance', 'attributes', 'edited',
        'created_at', 'updated_at']);
select columns_are('public', 'document_uploads',
  array['id', 'workspace_id', 'user_id', 'document_id', 'revision_id', 'document_type', 'title',
        'filename', 'content_type', 'expected_size_bytes', 'expected_sha256', 'object_key',
        'status', 'expires_at', 'completed_at', 'completed_document_id', 'completed_job_id',
        'created_at', 'updated_at',
        -- UX6-UPLOAD-B (20261028120000)
        'auto_classify']);
select col_is_pk('public', t, 'id', format('%s PK is id', t))
from unnest(array['documents', 'document_revisions', 'chapters', 'content_blocks',
                  'document_uploads']) as t;

-- Composite (workspace-scoped) foreign keys
select fk_ok('public', 'document_revisions', array['workspace_id', 'document_id'],
             'public', 'documents', array['workspace_id', 'id']);
select fk_ok('public', 'documents', array['workspace_id', 'id', 'active_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'document_revisions',
             array['workspace_id', 'document_id', 'parent_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'chapters', array['workspace_id', 'document_id', 'document_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'chapters', array['document_revision_id', 'parent_id'],
             'public', 'chapters', array['document_revision_id', 'id']);
select fk_ok('public', 'content_blocks',
             array['workspace_id', 'document_id', 'document_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'content_blocks', array['document_revision_id', 'chapter_id'],
             'public', 'chapters', array['document_revision_id', 'id']);
select fk_ok('public', 'document_uploads', array['workspace_id', 'completed_document_id'],
             'public', 'documents', array['workspace_id', 'id']);
select fk_ok('public', 'document_uploads', array['workspace_id', 'completed_job_id'],
             'public', 'async_jobs', array['workspace_id', 'id']);
-- Deferred from M4.1
select fk_ok('public', 'questions', array['workspace_id', 'chapter_id'],
             'public', 'chapters', array['workspace_id', 'id']);
select fk_ok('public', 'question_sources', array['workspace_id', 'document_id'],
             'public', 'documents', array['workspace_id', 'id']);
select fk_ok('public', 'question_sources',
             array['workspace_id', 'document_id', 'document_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'question_import_runs', array['workspace_id', 'source_document_id'],
             'public', 'documents', array['workspace_id', 'id']);
select fk_ok('public', 'question_import_runs',
             array['workspace_id', 'source_document_id', 'source_document_revision_id'],
             'public', 'document_revisions', array['workspace_id', 'document_id', 'id']);
select fk_ok('public', 'question_import_runs', array['workspace_id', 'target_chapter_id'],
             'public', 'chapters', array['workspace_id', 'id']);
select is_empty(
  $$ select conname from pg_constraint
      where conrelid in ('public.questions'::regclass, 'public.question_sources'::regclass,
                         'public.question_import_runs'::regclass)
        and not convalidated $$,
  'the deferred M4.1 constraints are validated');
select has_index('public', 'documents', 'documents_workspace_created_idx',
  array['workspace_id', 'created_at', 'id'], 'library listing index');

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000032a001', 'm32a-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000032a001', 'm32a ws one', '00000000-0000-4000-8000-00000032a001'),
  ('10000000-0000-4000-8000-00000032a002', 'm32a ws two', '00000000-0000-4000-8000-00000032a001');
-- Document d1 (ws one) with revision r1; document d2 (ws one); document d3 (ws two).
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key, created_by)
values
  ('20000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001', 'Book one',
   'book-one.pdf', 1024, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf',
   '00000000-0000-4000-8000-00000032a001'),
  ('20000000-0000-4000-8000-00000032a002', '10000000-0000-4000-8000-00000032a001', 'Book two',
   'book-two.pdf', 2048, repeat('b', 64),
   'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a002/revisions/30000000-0000-4000-8000-00000032a002/source.pdf',
   null),
  ('20000000-0000-4000-8000-00000032a003', '10000000-0000-4000-8000-00000032a002', 'Book three',
   'book-three.pdf', 2048, repeat('c', 64),
   'workspaces/10000000-0000-4000-8000-00000032a002/documents/20000000-0000-4000-8000-00000032a003/revisions/30000000-0000-4000-8000-00000032a003/source.pdf',
   null);
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key)
values
  ('30000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001',
   '20000000-0000-4000-8000-00000032a001', 1,
   'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf'),
  ('30000000-0000-4000-8000-00000032a002', '10000000-0000-4000-8000-00000032a001',
   '20000000-0000-4000-8000-00000032a002', 1,
   'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a002/revisions/30000000-0000-4000-8000-00000032a002/source.pdf');
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, parent_id, section_key, level,
   sort_order, title, page, heading_block_id)
values
  ('40000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001',
   '20000000-0000-4000-8000-00000032a001', '30000000-0000-4000-8000-00000032a001', null,
   'sec-1', 1, 0, 'Chapter 1', 1, 'blk-1'),
  ('40000000-0000-4000-8000-00000032a002', '10000000-0000-4000-8000-00000032a001',
   '20000000-0000-4000-8000-00000032a001', '30000000-0000-4000-8000-00000032a001',
   '40000000-0000-4000-8000-00000032a001', 'sec-1.1', 2, 0, 'Section 1.1', 2, null),
  ('40000000-0000-4000-8000-00000032a003', '10000000-0000-4000-8000-00000032a001',
   '20000000-0000-4000-8000-00000032a002', '30000000-0000-4000-8000-00000032a002', null,
   'sec-1', 1, 0, 'Other chapter', 1, null);
insert into public.content_blocks
  (workspace_id, document_id, document_revision_id, block_id, ordinal, chapter_id, block_type,
   text, page, provenance)
values
  ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001',
   '30000000-0000-4000-8000-00000032a001', 'blk-1', 0, '40000000-0000-4000-8000-00000032a001',
   'heading', 'Chapter 1', 1, '{"locations": [{"page": 1}]}'),
  ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001',
   '30000000-0000-4000-8000-00000032a001', 'blk-2', 1, '40000000-0000-4000-8000-00000032a002',
   'text', 'Body', 2, '{"locations": [{"page": 2}], "source_block_ids": ["p-2"]}');

-- documents -------------------------------------------------------------------------------------
select is(
  (select row(document_type, status, content_type, deleted_at is null)::text
     from public.documents where id = '20000000-0000-4000-8000-00000032a001'),
  row('book', 'processing', 'application/pdf', true)::text,
  'a new document is a processing book PDF');
select throws_ok(
  $$ update public.documents set document_type = 'novel'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'unknown document type is rejected');
select lives_ok(
  $$ update public.documents set document_type = 'question_paper'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  'a question paper is a document type');
select throws_ok(
  $$ update public.documents set sha256 = 'ABC' where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'sha256 is lowercase hex');
select throws_ok(
  $$ update public.documents set size_bytes = 52428801
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'size is at most 50 MiB');
select throws_ok(
  $$ update public.documents set size_bytes = 0
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'size is positive');
select throws_ok(
  $$ update public.documents set content_type = 'text/plain'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'only PDFs');
select throws_ok(
  $$ update public.documents set title = '   ' where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'title is not blank');
select throws_ok(
  $$ update public.documents
        set source_object_key = 'workspaces/10000000-0000-4000-8000-00000032a002/documents/20000000-0000-4000-8000-00000032a002/revisions/30000000-0000-4000-8000-00000032a002/source.pdf'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'the source object key lives under the document''s own workspace and id');
select throws_ok(
  $$ update public.documents set source_object_key = '../../etc/passwd'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'the source object key follows the server-generated scheme');
select throws_ok(
  $$ update public.documents set status = 'deleted'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'unknown status is rejected');
select throws_ok(
  $$ update public.documents set status = 'ready'
      where id = '20000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'ready requires an active revision');
select throws_ok(
  $$ update public.documents set active_revision_id = '30000000-0000-4000-8000-00000032a001'
      where id = '20000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'the active revision must be published');
select throws_ok(
  $$ update public.documents set last_error = repeat('x', 501)
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'last_error is bounded');

-- document_revisions ----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.document_revisions
       (workspace_id, document_id, revision_number, source_object_key)
     values ('10000000-0000-4000-8000-00000032a002', '20000000-0000-4000-8000-00000032a001', 2,
       'workspaces/10000000-0000-4000-8000-00000032a002/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf') $$,
  '23503', null, 'a revision cannot claim another workspace');
select throws_ok(
  $$ insert into public.document_revisions
       (workspace_id, document_id, revision_number, source_object_key)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001', 1,
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf') $$,
  '23505', null, 'revision numbers are unique per document');
select throws_ok(
  $$ insert into public.document_revisions
       (workspace_id, document_id, revision_number, source_object_key)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001', 0,
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf') $$,
  '23514', null, 'revision numbers start at 1');
select throws_ok(
  $$ insert into public.document_revisions
       (workspace_id, document_id, revision_number, parent_revision_id, source_object_key)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001', 2,
       '30000000-0000-4000-8000-00000032a002',
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf') $$,
  '23503', null, 'the parent revision belongs to the same document');
select throws_ok(
  $$ insert into public.document_revisions
       (workspace_id, document_id, revision_number, source_object_key)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001', 2,
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a002/revisions/30000000-0000-4000-8000-00000032a002/source.pdf') $$,
  '23514', null, 'a revision points at its own document''s original');
select throws_ok(
  $$ update public.document_revisions set status = 'published'
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'published requires published_at');
select throws_ok(
  $$ update public.document_revisions set content_hash = 'nope'
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'content_hash is a hex SHA-256');
select throws_ok(
  $$ update public.document_revisions
        set parsed_object_key = 'workspaces/x/parsed_document.json'
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'parsed artifacts live under the revision''s own prefix');
select lives_ok(
  $$ update public.document_revisions
        set parsed_object_key = 'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/parsed_document.json',
            content_hash = repeat('d', 64), parser_version = 'docling-2.0'
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  'a draft revision records its parse result');
select lives_ok(
  $$ update public.document_revisions set status = 'published', published_at = now()
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  'a draft revision can be published');
select lives_ok(
  $$ update public.documents
        set active_revision_id = '30000000-0000-4000-8000-00000032a001', status = 'ready'
      where id = '20000000-0000-4000-8000-00000032a001' $$,
  'a published revision becomes the active one and the document ready');
select throws_ok(
  $$ update public.documents set active_revision_id = '30000000-0000-4000-8000-00000032a001'
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  '23503', null, 'the active revision belongs to the same document');
select throws_ok(
  $$ update public.document_revisions set status = 'draft', published_at = null
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'a published revision never goes back to draft');
select throws_ok(
  $$ update public.document_revisions set content_hash = repeat('e', 64)
      where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'a published revision keeps its content hash');
select throws_ok(
  $$ update public.document_revisions set revision_number = 7
      where id = '30000000-0000-4000-8000-00000032a002' $$,
  '23514', null, 'revision identity is immutable even for drafts');
select lives_ok(
  $$ insert into public.document_revisions
       (id, workspace_id, document_id, revision_number, parent_revision_id, source_object_key)
     values ('30000000-0000-4000-8000-00000032a011', '10000000-0000-4000-8000-00000032a001',
       '20000000-0000-4000-8000-00000032a001', 2, '30000000-0000-4000-8000-00000032a001',
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a001/revisions/30000000-0000-4000-8000-00000032a001/source.pdf') $$,
  'a correction is a new draft revision on the same original');

-- chapters / content_blocks ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, parent_id, section_key, level, title)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', '40000000-0000-4000-8000-00000032a001',
       'sec-x', 2, 'Cross revision child') $$,
  '23503', null, 'a chapter parent belongs to the same revision');
select throws_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, section_key, level, title)
     values ('10000000-0000-4000-8000-00000032a002', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'sec-y', 1, 'Wrong workspace') $$,
  '23503', null, 'a chapter cannot claim another workspace');
select throws_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, section_key, level, title)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'sec-1', 1, 'Duplicate key') $$,
  '23505', null, 'section keys are unique per revision');
select throws_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, section_key, level, title)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'has space', 1, 'Bad key') $$,
  '23514', null, 'section keys are opaque identifiers without whitespace');
select throws_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, section_key, level, title, page)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'sec-z', 1, 'Bad page', 0) $$,
  '23514', null, 'pages start at 1');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-9', 0, 'video', 1,
       '{"locations": [{"page": 1}]}') $$,
  '23514', null, 'unknown block type is rejected');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-9', 0, 'text', 1, '{"locations": []}') $$,
  '23514', null, 'a block has at least one source location');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance, chapter_id)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-9', 0, 'text', 1,
       '{"locations": [{"page": 1}]}', '40000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'a block''s chapter belongs to the same revision');
select lives_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance, chapter_id)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-9', 0, 'text', 1,
       '{"locations": [{"page": 1}]}', '40000000-0000-4000-8000-00000032a003') $$,
  'a block is written into a draft revision');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-9', 1, 'text', 1,
       '{"locations": [{"page": 1}]}') $$,
  '23505', null, 'block ids are unique per revision');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
       '30000000-0000-4000-8000-00000032a002', 'blk-10', 0, 'text', 1,
       '{"locations": [{"page": 1}]}') $$,
  '23505', null, 'ordinals are unique per revision');
-- r1 is published now: its content is frozen.
select throws_ok(
  $$ update public.content_blocks set text = 'edited in place', edited = true
      where document_revision_id = '30000000-0000-4000-8000-00000032a001' and block_id = 'blk-2' $$,
  '23514', null, 'blocks of a published revision cannot be edited');
select throws_ok(
  $$ delete from public.content_blocks
      where document_revision_id = '30000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'blocks of a published revision cannot be deleted');
select throws_ok(
  $$ insert into public.content_blocks
       (workspace_id, document_id, document_revision_id, block_id, ordinal, block_type, page,
        provenance)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001',
       '30000000-0000-4000-8000-00000032a001', 'blk-3', 2, 'text', 1,
       '{"locations": [{"page": 1}]}') $$,
  '23514', null, 'blocks cannot be added to a published revision');
select throws_ok(
  $$ update public.chapters set title = 'Renamed'
      where id = '40000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'chapters of a published revision cannot be edited');
select lives_ok(
  $$ delete from public.chapters where id = '40000000-0000-4000-8000-00000032a003' $$,
  'chapters of a draft revision can be replaced');
select is(
  (select chapter_id from public.content_blocks
    where document_revision_id = '30000000-0000-4000-8000-00000032a002' and block_id = 'blk-9'),
  null::uuid, 'deleting a draft chapter detaches its blocks');

-- document_uploads ------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.document_uploads
       (id, workspace_id, user_id, document_id, revision_id, title, filename,
        expected_size_bytes, expected_sha256, object_key, expires_at)
     values ('50000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001',
       '00000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a009',
       '30000000-0000-4000-8000-00000032a009', 'New', 'new.pdf', 100, repeat('f', 64),
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a009/revisions/30000000-0000-4000-8000-00000032a009/source.pdf',
       now() + interval '1 hour') $$,
  'an upload intent reserves the document and revision ids');
select throws_ok(
  $$ insert into public.document_uploads
       (workspace_id, user_id, document_id, revision_id, title, filename,
        expected_size_bytes, expected_sha256, object_key, expires_at)
     values ('10000000-0000-4000-8000-00000032a001', '00000000-0000-4000-8000-00000032a001',
       gen_random_uuid(), gen_random_uuid(), 'New', 'new.pdf', 100, repeat('f', 64),
       'workspaces/10000000-0000-4000-8000-00000032a001/anything.pdf',
       now() + interval '1 hour') $$,
  '23514', null, 'the object key is derived from the server-generated ids');
select throws_ok(
  $$ insert into public.document_uploads
       (workspace_id, user_id, document_id, revision_id, title, filename,
        expected_size_bytes, expected_sha256, object_key, expires_at)
     select '10000000-0000-4000-8000-00000032a001', '00000000-0000-4000-8000-00000032a001',
       d, r, 'Big', 'big.pdf', 52428801, repeat('f', 64),
       format('workspaces/10000000-0000-4000-8000-00000032a001/documents/%s/revisions/%s/source.pdf', d, r),
       now() + interval '1 hour'
       from (select gen_random_uuid() as d, gen_random_uuid() as r) ids $$,
  '23514', null, 'upload intents are limited to 50 MiB');
select throws_ok(
  $$ insert into public.document_uploads
       (workspace_id, user_id, document_id, revision_id, title, filename,
        expected_size_bytes, expected_sha256, object_key, expires_at, created_at)
     select '10000000-0000-4000-8000-00000032a001', '00000000-0000-4000-8000-00000032a001',
       d, r, 'Old', 'old.pdf', 10, repeat('f', 64),
       format('workspaces/10000000-0000-4000-8000-00000032a001/documents/%s/revisions/%s/source.pdf', d, r),
       now(), now()
       from (select gen_random_uuid() as d, gen_random_uuid() as r) ids $$,
  '23514', null, 'an intent expires after it was created');
select throws_ok(
  $$ update public.document_uploads set status = 'completed', completed_at = now()
      where id = '50000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'a completed intent names the document it created');
select throws_ok(
  $$ update public.document_uploads
        set status = 'completed', completed_at = now(),
            completed_document_id = '20000000-0000-4000-8000-00000032a001'
      where id = '50000000-0000-4000-8000-00000032a001' $$,
  '23514', null, 'a completed intent created exactly its reserved document');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values ('20000000-0000-4000-8000-00000032a009', '10000000-0000-4000-8000-00000032a001', 'New',
  'new.pdf', 100, repeat('f', 64),
  'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a009/revisions/30000000-0000-4000-8000-00000032a009/source.pdf');
insert into public.async_jobs (id, workspace_id, job_type)
values ('60000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001',
        'document.parse'),
       ('60000000-0000-4000-8000-00000032a002', '10000000-0000-4000-8000-00000032a002',
        'document.parse');
select throws_ok(
  $$ update public.document_uploads
        set status = 'completed', completed_at = now(),
            completed_document_id = '20000000-0000-4000-8000-00000032a009',
            completed_job_id = '60000000-0000-4000-8000-00000032a002'
      where id = '50000000-0000-4000-8000-00000032a001' $$,
  '23503', null, 'the completion job belongs to the same workspace');
select lives_ok(
  $$ update public.document_uploads
        set status = 'completed', completed_at = now(),
            completed_document_id = '20000000-0000-4000-8000-00000032a009',
            completed_job_id = '60000000-0000-4000-8000-00000032a001'
      where id = '50000000-0000-4000-8000-00000032a001' $$,
  'an intent completes with its document and job');

-- Deferred M4.1 references ----------------------------------------------------------------------
insert into public.questions (id, workspace_id, question_type)
values ('70000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a001', 'MCQ'),
       ('70000000-0000-4000-8000-00000032a002', '10000000-0000-4000-8000-00000032a002', 'MCQ');
select throws_ok(
  $$ update public.questions set chapter_id = '40000000-0000-4000-8000-00000032a001'
      where id = '70000000-0000-4000-8000-00000032a002' $$,
  '23503', null, 'a question cannot cite a chapter of another workspace');
select throws_ok(
  $$ update public.questions set chapter_id = gen_random_uuid()
      where id = '70000000-0000-4000-8000-00000032a001' $$,
  '23503', null, 'a question chapter must exist');
select lives_ok(
  $$ update public.questions set chapter_id = '40000000-0000-4000-8000-00000032a001'
      where id = '70000000-0000-4000-8000-00000032a001' $$,
  'a question is filed under a chapter of its workspace');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, document_id)
     values ('10000000-0000-4000-8000-00000032a002', '70000000-0000-4000-8000-00000032a002',
             '20000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'a source cannot cite a document of another workspace');
select throws_ok(
  $$ insert into public.question_sources
       (workspace_id, question_id, document_id, document_revision_id)
     values ('10000000-0000-4000-8000-00000032a001', '70000000-0000-4000-8000-00000032a001',
             '20000000-0000-4000-8000-00000032a002', '30000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'a source revision belongs to the cited document');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, document_revision_id)
     values ('10000000-0000-4000-8000-00000032a001', '70000000-0000-4000-8000-00000032a001',
             '30000000-0000-4000-8000-00000032a001') $$,
  '23514', null, 'a source revision needs its document');
select lives_ok(
  $$ insert into public.question_sources
       (workspace_id, question_id, document_id, document_revision_id, block_ids)
     values ('10000000-0000-4000-8000-00000032a001', '70000000-0000-4000-8000-00000032a001',
             '20000000-0000-4000-8000-00000032a001', '30000000-0000-4000-8000-00000032a001',
             array['blk-2']) $$,
  'a source cites a document revision of its workspace');
select throws_ok(
  $$ insert into public.question_import_runs (workspace_id, source_document_id)
     values ('10000000-0000-4000-8000-00000032a002', '20000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'an import run cannot read a document of another workspace');
select throws_ok(
  $$ insert into public.question_import_runs
       (workspace_id, source_document_id, source_document_revision_id)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a002',
             '30000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'an import run revision belongs to its document');
select throws_ok(
  $$ insert into public.question_import_runs (workspace_id, source_document_revision_id)
     values ('10000000-0000-4000-8000-00000032a001', '30000000-0000-4000-8000-00000032a001') $$,
  '23514', null, 'an import run revision needs its document');
select throws_ok(
  $$ insert into public.question_import_runs (workspace_id, target_chapter_id)
     values ('10000000-0000-4000-8000-00000032a002', '40000000-0000-4000-8000-00000032a001') $$,
  '23503', null, 'an import run cannot target a chapter of another workspace');
select lives_ok(
  $$ insert into public.question_import_runs
       (workspace_id, source_document_id, source_document_revision_id, target_chapter_id)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a001',
             '30000000-0000-4000-8000-00000032a001', '40000000-0000-4000-8000-00000032a002') $$,
  'an import run reads a document revision and targets a chapter of its workspace');

-- Hard deletes ----------------------------------------------------------------------------------
select throws_ok(
  $$ delete from public.documents where id = '20000000-0000-4000-8000-00000032a001' $$,
  '23503', null, 'a cited document cannot be hard-deleted on its own');
select throws_ok(
  $$ delete from public.document_revisions where id = '30000000-0000-4000-8000-00000032a001' $$,
  '23503', null, 'the active revision cannot be hard-deleted on its own');

-- Storage ---------------------------------------------------------------------------------------
select results_eq(
  $$ select id, public, file_size_limit, allowed_mime_types from storage.buckets
      where id in ('source-pdfs', 'parsed-artifacts') order by id $$,
  $$ values ('parsed-artifacts'::text, false, 52428800::bigint, array['application/json']::text[]),
            ('source-pdfs'::text, false, 52428800::bigint, array['application/pdf']::text[]) $$,
  'private source and parsed-artifact buckets with size and type limits');
select ok(
  (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
  'Storage RLS is enabled on storage.objects');
select is_empty(
  $$ select tablename, policyname from pg_policies
      where schemaname = 'storage'
        and roles && array['anon', 'authenticated', 'public']::name[] $$,
  'no Storage policy lets anon/authenticated clients read or write objects');

-- Privileges / RLS ------------------------------------------------------------------------------
select table_privs_are('public', t, r, array[]::text[],
  format('%s has no privileges on %s', r, t))
from unnest(array['documents', 'document_revisions', 'chapters', 'content_blocks',
                  'document_uploads']) as t,
     unnest(array['anon', 'authenticated']) as r;
select table_privs_are('public', 'documents', 'quiz_api', array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'document_revisions', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'chapters', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
select table_privs_are('public', 'content_blocks', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
select table_privs_are('public', 'document_uploads', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'documents', 'quiz_worker', array['SELECT']);
select table_privs_are('public', 'document_revisions', 'quiz_worker', array['SELECT', 'INSERT']);
select table_privs_are('public', 'chapters', 'quiz_worker', array['SELECT', 'INSERT', 'DELETE']);
select table_privs_are('public', 'content_blocks', 'quiz_worker',
  array['SELECT', 'INSERT', 'DELETE']);
select table_privs_are('public', 'document_uploads', 'quiz_worker', array['SELECT']);
select is(
  (select array_agg(column_name::text order by column_name::text)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'documents' and grantee = 'quiz_worker'
      and privilege_type = 'UPDATE'),
  array['active_revision_id', 'last_error', 'status', 'updated_at'],
  'quiz_worker may update only the document processing state');
select is(
  (select array_agg(column_name::text order by column_name::text)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'document_revisions'
      and grantee = 'quiz_worker' and privilege_type = 'UPDATE'),
  array['content_hash', 'parsed_object_key', 'parser_version', 'published_at', 'status',
        'updated_at'],
  'quiz_worker may update only the revision parse/publication state');
select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.documents'::regclass, 'public.document_revisions'::regclass,
                  'public.chapters'::regclass, 'public.content_blocks'::regclass,
                  'public.document_uploads'::regclass)),
  'RLS is enabled on every document table');
select function_privs_are('public', f, array[]::text[], r, array[]::text[],
  format('%s cannot execute %s', r, f))
from unnest(array['document_revisions_guard', 'documents_active_revision_published',
                  'revision_content_guard']) as f,
     unnest(array['anon', 'authenticated']) as r;

-- Roles work within their grants ----------------------------------------------------------------
grant quiz_api, quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api, quiz_worker;

set local role quiz_api;
select is(
  (select count(*)::int from public.documents
    where workspace_id = '10000000-0000-4000-8000-00000032a001'),
  3, 'quiz_api reads documents through its policy');
select lives_ok(
  $$ update public.documents set deleted_at = now()
      where id = '20000000-0000-4000-8000-00000032a002' $$,
  'quiz_api soft-deletes a document');
select throws_ok(
  $$ delete from public.documents where id = '20000000-0000-4000-8000-00000032a002' $$,
  '42501', null, 'quiz_api cannot hard-delete documents');
reset role;

set local role quiz_worker;
select is(
  (select count(*)::int from public.document_uploads
    where id = '50000000-0000-4000-8000-00000032a001'),
  1, 'quiz_worker reads upload intents');
select lives_ok(
  $$ update public.documents set status = 'failed', last_error = 'parse failed'
      where id = '20000000-0000-4000-8000-00000032a009' $$,
  'quiz_worker moves the document processing state');
select lives_ok(
  $$ insert into public.document_revisions
       (id, workspace_id, document_id, revision_number, source_object_key)
     values ('30000000-0000-4000-8000-00000032a009', '10000000-0000-4000-8000-00000032a001',
       '20000000-0000-4000-8000-00000032a009', 1,
       'workspaces/10000000-0000-4000-8000-00000032a001/documents/20000000-0000-4000-8000-00000032a009/revisions/30000000-0000-4000-8000-00000032a009/source.pdf') $$,
  'quiz_worker creates a revision');
select lives_ok(
  $$ insert into public.chapters
       (workspace_id, document_id, document_revision_id, section_key, level, title)
     values ('10000000-0000-4000-8000-00000032a001', '20000000-0000-4000-8000-00000032a009',
       '30000000-0000-4000-8000-00000032a009', 'sec-1', 1, 'Parsed') $$,
  'quiz_worker writes the parsed chapter tree');
select lives_ok(
  $$ delete from public.chapters
      where document_revision_id = '30000000-0000-4000-8000-00000032a009' $$,
  'quiz_worker replaces a partial draft on retry');
select throws_ok(
  $$ update public.documents set title = 'hijack'
      where id = '20000000-0000-4000-8000-00000032a009' $$,
  '42501', null, 'quiz_worker cannot rename documents');
select throws_ok(
  $$ update public.documents set workspace_id = '10000000-0000-4000-8000-00000032a002'
      where id = '20000000-0000-4000-8000-00000032a009' $$,
  '42501', null, 'quiz_worker cannot move documents');
select throws_ok(
  $$ insert into public.documents
       (workspace_id, title, filename, size_bytes, sha256, source_object_key)
     values ('10000000-0000-4000-8000-00000032a001', 'x', 'x.pdf', 1, repeat('a', 64), 'x') $$,
  '42501', null, 'quiz_worker cannot create documents');
select throws_ok(
  $$ update public.document_uploads set title = 'x'
      where id = '50000000-0000-4000-8000-00000032a001' $$,
  '42501', null, 'quiz_worker cannot change upload intents');
select throws_ok(
  $$ delete from public.document_revisions where id = '30000000-0000-4000-8000-00000032a009' $$,
  '42501', null, 'quiz_worker cannot delete revisions');
select throws_ok(
  $$ select 1 from public.workspaces limit 1 $$,
  '42501', null, 'quiz_worker still cannot read workspaces');
reset role;

-- A workspace hard delete (operator) still cascades through everything above.
select lives_ok(
  $$ delete from public.workspaces
      where id in ('10000000-0000-4000-8000-00000032a001', '10000000-0000-4000-8000-00000032a002') $$,
  'a workspace hard delete cascades through documents and their citations');
select is(
  (select count(*)::int from public.documents
    where workspace_id in ('10000000-0000-4000-8000-00000032a001',
                           '10000000-0000-4000-8000-00000032a002')),
  0, 'no document rows survive their workspace');

select * from finish();
rollback;
