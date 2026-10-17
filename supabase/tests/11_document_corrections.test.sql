-- M3.4 (20261018003400): switching a document's active revision remaps question chapter links to
-- the same section of the new revision (or null), for the switching role quiz_worker, without
-- giving it any privilege on questions. The end-to-end flow (API draft -> worker publish) is
-- covered by tests/integration/workspaces/test_document_revisions.py.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000034001', 'm34-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-000000034001', 'm34 ws', '00000000-0000-4000-8000-000000034001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000034001', '00000000-0000-4000-8000-000000034001', 'owner');
-- Two documents: the remap of one must not touch questions of the other.
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-000000034001', '10000000-0000-4000-8000-000000034001', 'Doc',
   'doc.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-000000034001/documents/20000000-0000-4000-8000-000000034001/revisions/30000000-0000-4000-8000-000000034001/source.pdf'),
  ('20000000-0000-4000-8000-000000034002', '10000000-0000-4000-8000-000000034001', 'Other',
   'other.pdf', 10, repeat('b', 64),
   'workspaces/10000000-0000-4000-8000-000000034001/documents/20000000-0000-4000-8000-000000034002/revisions/30000000-0000-4000-8000-000000034009/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key)
values
  ('30000000-0000-4000-8000-000000034001', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034001', 1,
   'workspaces/10000000-0000-4000-8000-000000034001/documents/20000000-0000-4000-8000-000000034001/revisions/30000000-0000-4000-8000-000000034001/source.pdf'),
  ('30000000-0000-4000-8000-000000034009', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034002', 1,
   'workspaces/10000000-0000-4000-8000-000000034001/documents/20000000-0000-4000-8000-000000034002/revisions/30000000-0000-4000-8000-000000034009/source.pdf');
-- Revision 1: sections a, b (b nested under a); the other document: section a.
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, parent_id, section_key, level, title)
values
  ('40000000-0000-4000-8000-000000034001', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034001', '30000000-0000-4000-8000-000000034001', null,
   'sec-a', 1, 'A'),
  ('40000000-0000-4000-8000-000000034002', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034001', '30000000-0000-4000-8000-000000034001',
   '40000000-0000-4000-8000-000000034001', 'sec-b', 2, 'B'),
  ('40000000-0000-4000-8000-000000034009', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034002', '30000000-0000-4000-8000-000000034009', null,
   'sec-a', 1, 'Other A');
update public.document_revisions set status = 'published', published_at = now()
 where id in ('30000000-0000-4000-8000-000000034001', '30000000-0000-4000-8000-000000034009');
update public.documents set active_revision_id = '30000000-0000-4000-8000-000000034001',
       status = 'ready'
 where id = '20000000-0000-4000-8000-000000034001';
update public.documents set active_revision_id = '30000000-0000-4000-8000-000000034009',
       status = 'ready'
 where id = '20000000-0000-4000-8000-000000034002';

insert into public.questions (id, workspace_id, chapter_id, question_type) values
  ('50000000-0000-4000-8000-000000034001', '10000000-0000-4000-8000-000000034001',
   '40000000-0000-4000-8000-000000034001', 'ESSAY'),
  ('50000000-0000-4000-8000-000000034002', '10000000-0000-4000-8000-000000034001',
   '40000000-0000-4000-8000-000000034002', 'ESSAY'),
  ('50000000-0000-4000-8000-000000034003', '10000000-0000-4000-8000-000000034001',
   '40000000-0000-4000-8000-000000034009', 'ESSAY'),
  ('50000000-0000-4000-8000-000000034004', '10000000-0000-4000-8000-000000034001', null, 'ESSAY');
-- A soft-deleted question follows too (it may be restored later).
update public.questions set deleted_at = now()
 where id = '50000000-0000-4000-8000-000000034002';

-- Revision 2 (a correction draft): section a only (b was dropped).
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, parent_revision_id, source_object_key)
values
  ('30000000-0000-4000-8000-000000034002', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034001', 2, '30000000-0000-4000-8000-000000034001',
   'workspaces/10000000-0000-4000-8000-000000034001/documents/20000000-0000-4000-8000-000000034001/revisions/30000000-0000-4000-8000-000000034001/source.pdf');
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, section_key, level, title)
values
  ('40000000-0000-4000-8000-000000034011', '10000000-0000-4000-8000-000000034001',
   '20000000-0000-4000-8000-000000034001', '30000000-0000-4000-8000-000000034002',
   'sec-a', 1, 'A corrected');

-- Privileges -------------------------------------------------------------------------------------
select is(
  (select prosecdef from pg_proc
    where oid = 'public.documents_remap_question_chapters()'::regprocedure),
  true, 'the remap function is SECURITY DEFINER');
select is(
  (select proconfig from pg_proc
    where oid = 'public.documents_remap_question_chapters()'::regprocedure),
  array['search_path=""'], 'with a fixed empty search_path');
select ok(
  not has_function_privilege('quiz_worker', 'public.documents_remap_question_chapters()', 'execute')
  and not has_function_privilege('quiz_api', 'public.documents_remap_question_chapters()', 'execute')
  and not has_function_privilege('authenticated', 'public.documents_remap_question_chapters()',
                                 'execute')
  and not has_function_privilege('anon', 'public.documents_remap_question_chapters()', 'execute'),
  'nobody can call the remap function directly');
select ok(
  not has_table_privilege('quiz_worker', 'public.questions', 'select')
  and not has_table_privilege('quiz_worker', 'public.questions', 'update'),
  'quiz_worker still has no privilege on questions');

-- A draft does not move anything ----------------------------------------------------------------
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034001'),
  '40000000-0000-4000-8000-000000034001'::uuid, 'questions stay on the active revision meanwhile');

-- The publish switch, as the worker does it -----------------------------------------------------
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select lives_ok(
  $$ update public.document_revisions set status = 'published', published_at = now(),
            content_hash = repeat('c', 64)
      where id = '30000000-0000-4000-8000-000000034002' $$,
  'quiz_worker publishes the draft');
select lives_ok(
  $$ update public.documents set active_revision_id = '30000000-0000-4000-8000-000000034002'
      where id = '20000000-0000-4000-8000-000000034001' $$,
  'quiz_worker switches the active revision (the trigger remaps on its behalf)');
reset role;

select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034001'),
  '40000000-0000-4000-8000-000000034011'::uuid, 'same section_key: moved to the new chapter');
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034002'),
  null, 'section gone from the new revision: link cleared (soft-deleted question too)');
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034003'),
  '40000000-0000-4000-8000-000000034009'::uuid, 'questions of another document are untouched');
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034004'),
  null, 'questions without a chapter are untouched');

-- Switching back (a rollback to revision 1) follows the same rule -------------------------------
update public.documents set active_revision_id = '30000000-0000-4000-8000-000000034001'
 where id = '20000000-0000-4000-8000-000000034001';
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034001'),
  '40000000-0000-4000-8000-000000034001'::uuid, 'switching back maps to the older chapter again');
-- Other column updates do not fire it.
update public.questions set chapter_id = '40000000-0000-4000-8000-000000034002'
 where id = '50000000-0000-4000-8000-000000034004';
update public.documents set last_error = 'x' where id = '20000000-0000-4000-8000-000000034001';
select is(
  (select chapter_id from public.questions where id = '50000000-0000-4000-8000-000000034004'),
  '40000000-0000-4000-8000-000000034002'::uuid, 'an unrelated document update remaps nothing');

select * from finish();
rollback;
