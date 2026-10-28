-- UX6-UPLOAD-B (20261028120000): auto-classified documents, worker_classify_document (once, first
-- revision, never after a user choice) and worker_start_question_import for books with questions.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000b8001', 'classify-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000b8001', 'classify ws', '00000000-0000-4000-8000-0000000b8001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000b8001', '00000000-0000-4000-8000-0000000b8001', 'owner');

-- d1 auto (paper content), d2 auto (mixed content), d3 user book, d4 auto deleted,
-- d6 auto with a correction draft.
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type, type_source)
select d.id::uuid, '10000000-0000-4000-8000-0000000b8001', 'Doc', 'doc.pdf', 10, repeat('a', 64),
       'workspaces/10000000-0000-4000-8000-0000000b8001/documents/' || d.id || '/revisions/'
         || '30000000' || substr(d.id, 9) || '/source.pdf',
       '00000000-0000-4000-8000-0000000b8001', 'book', d.src
  from (values
    ('20000000-0000-4000-8000-0000000b8001', 'auto'),
    ('20000000-0000-4000-8000-0000000b8002', 'auto'),
    ('20000000-0000-4000-8000-0000000b8003', 'user'),
    ('20000000-0000-4000-8000-0000000b8004', 'auto'),
    ('20000000-0000-4000-8000-0000000b8006', 'auto')
  ) as d (id, src);
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by, status, content_hash,
                                       published_at)
select ('30000000' || substr(d.id::text, 9))::uuid, d.workspace_id, d.id, 1, d.source_object_key,
       d.created_by, 'published', repeat('b', 64), now()
  from public.documents d where d.id::text like '20000000-0000-4000-8000-0000000b800%';
update public.documents d set active_revision_id = r.id, status = 'ready'
  from public.document_revisions r where r.document_id = d.id
   and d.id::text like '20000000-0000-4000-8000-0000000b800%';
update public.documents set deleted_at = now() where id = '20000000-0000-4000-8000-0000000b8004';
-- d6: a correction draft (revision 2, parent = revision 1).
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       parent_revision_id, source_object_key, created_by)
select '31000000-0000-4000-8000-0000000b8006', workspace_id, id, 2,
       '30000000-0000-4000-8000-0000000b8006', source_object_key, created_by
  from public.documents where id = '20000000-0000-4000-8000-0000000b8006';

-- Schema ----------------------------------------------------------------------------------------
select col_default_is('public', 'documents', 'type_source', 'user',
  'documents are user-typed by default (every row before this migration)');
select col_is_null('public', 'documents', 'content_kind', 'content_kind is null until classified');
select col_default_is('public', 'document_uploads', 'auto_classify', 'false',
  'upload intents are explicit by default');
select throws_ok(
  $$ update public.documents set type_source = 'robot'
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'type_source is user or auto');
select throws_ok(
  $$ update public.documents set content_kind = 'novel'
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'content_kind is book, question_paper or mixed');
select throws_ok(
  $$ update public.documents set content_kind = 'question_paper'
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'a question_paper kind needs document_type question_paper');
select throws_ok(
  $$ update public.documents set document_type = 'question_paper', content_kind = 'mixed'
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'a mixed kind is a book');
select lives_ok(
  $$ update public.documents set document_type = 'question_paper', content_kind = 'question_paper'
      where id = '20000000-0000-4000-8000-0000000b8003';
     update public.documents set document_type = 'book', content_kind = 'mixed'
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  'consistent kinds are accepted');
select throws_ok(
  $$ update public.documents set detection = '[1, 2]'::jsonb
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'detection is a JSON object');
select throws_ok(
  $$ update public.documents
        set detection = jsonb_build_object('x', repeat('y', 3000))
      where id = '20000000-0000-4000-8000-0000000b8003' $$,
  '23514', null, 'detection stays small');
select throws_ok(
  $$ insert into public.document_uploads (workspace_id, user_id, document_id, revision_id,
                                          document_type, auto_classify, title, filename,
                                          expected_size_bytes, expected_sha256, object_key,
                                          expires_at)
     values ('10000000-0000-4000-8000-0000000b8001', '00000000-0000-4000-8000-0000000b8001',
             '21000000-0000-4000-8000-0000000b8001', '32000000-0000-4000-8000-0000000b8001',
             'question_paper', true, 'x', 'x.pdf', 10, repeat('a', 64),
             'workspaces/10000000-0000-4000-8000-0000000b8001/documents/21000000-0000-4000-8000-0000000b8001/revisions/32000000-0000-4000-8000-0000000b8001/source.pdf',
             now() + interval '1 hour') $$,
  '23514', null, 'an auto-classified upload starts as a book');

-- Privileges ------------------------------------------------------------------------------------
select ok(has_function_privilege('quiz_worker',
  'public.worker_classify_document(uuid, uuid, text, jsonb)', 'execute'),
  'quiz_worker may classify');
select ok(not has_function_privilege('quiz_api',
  'public.worker_classify_document(uuid, uuid, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated',
  'public.worker_classify_document(uuid, uuid, text, jsonb)', 'execute')
  and not has_function_privilege('anon',
  'public.worker_classify_document(uuid, uuid, text, jsonb)', 'execute'), 'nobody else may');
select ok(not has_column_privilege('quiz_worker', 'public.documents', 'document_type', 'update')
  and not has_column_privilege('quiz_worker', 'public.documents', 'content_kind', 'update')
  and not has_column_privilege('quiz_worker', 'public.documents', 'type_source', 'update')
  and not has_column_privilege('quiz_worker', 'public.documents', 'detection', 'update'),
  'quiz_worker cannot change a kind directly');
select ok(has_function_privilege('quiz_worker',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('quiz_api',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute'),
  'worker_start_question_import keeps its grants');

-- Behaviour as quiz_worker ----------------------------------------------------------------------
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8001',
  '30000000-0000-4000-8000-0000000b8001', 'question_paper',
  '{"kind": "question_paper", "confidence": "high"}'), 'question_paper',
  'an auto document is classified as a question paper');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8001',
  '30000000-0000-4000-8000-0000000b8001', 'book', '{}'), null,
  'a classified document is never reclassified');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8002',
  '30000000-0000-4000-8000-0000000b8002', 'mixed', '{"kind": "mixed"}'), 'book',
  'a book with questions stays a book');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8003',
  '30000000-0000-4000-8000-0000000b8003', 'question_paper', '{}'), null,
  'a user-typed document is never classified');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8004',
  '30000000-0000-4000-8000-0000000b8004', 'question_paper', '{}'), null,
  'a deleted document is never classified');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8006',
  '31000000-0000-4000-8000-0000000b8006', 'question_paper', '{}'), null,
  'a correction revision never classifies');
select is(public.worker_classify_document('20000000-0000-4000-8000-0000000b8006',
  '30000000-0000-4000-8000-0000000b8002', 'question_paper', '{}'), null,
  'a revision of another document never classifies');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000b8002', '30000000-0000-4000-8000-0000000b8002',
  '00000000-0000-4000-8000-0000000b8001')), 1, 'a book with questions starts its import');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000b8001', '30000000-0000-4000-8000-0000000b8001',
  '00000000-0000-4000-8000-0000000b8001')), 1, 'a classified question paper starts its import');
reset role;

select results_eq(
  $$ select id::text, document_type, content_kind, type_source, detection->>'kind'
       from public.documents
      where id in ('20000000-0000-4000-8000-0000000b8001', '20000000-0000-4000-8000-0000000b8002',
                   '20000000-0000-4000-8000-0000000b8006')
      order by id $$,
  $$ values ('20000000-0000-4000-8000-0000000b8001', 'question_paper', 'question_paper', 'auto',
             'question_paper'),
            ('20000000-0000-4000-8000-0000000b8002', 'book', 'mixed', 'auto', 'mixed'),
            ('20000000-0000-4000-8000-0000000b8006', 'book', null, 'auto', null) $$,
  'kinds and detections as classified; untouched documents unchanged');

-- A plain book (user-typed or classified as book) still starts nothing.
update public.documents set document_type = 'book', content_kind = 'book'
 where id = '20000000-0000-4000-8000-0000000b8003';
set local role quiz_worker;
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000b8003', '30000000-0000-4000-8000-0000000b8003',
  '00000000-0000-4000-8000-0000000b8001')), 0, 'a book without questions starts nothing');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000b8006', '30000000-0000-4000-8000-0000000b8006',
  '00000000-0000-4000-8000-0000000b8001')), 0, 'an unclassified auto document starts nothing');
reset role;

select * from finish();
rollback;
