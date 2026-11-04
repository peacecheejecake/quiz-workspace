-- CHAP-MATCH (20261105090000_chapter_rematch.sql): worker_rematch_chapters applies matcher moves
-- to auto questions with no chapter or a question-paper fallback chapter, rechecked under lock.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

select ok(has_function_privilege('quiz_worker', 'public.worker_rematch_chapters(uuid, jsonb)',
  'execute'), 'quiz_worker can execute worker_rematch_chapters');
select ok(not has_function_privilege('quiz_api', 'public.worker_rematch_chapters(uuid, jsonb)',
  'execute') and not has_function_privilege('authenticated',
  'public.worker_rematch_chapters(uuid, jsonb)', 'execute') and not has_function_privilege('anon',
  'public.worker_rematch_chapters(uuid, jsonb)', 'execute'), 'nobody else can');
select is((select proconfig from pg_proc
            where oid = 'public.worker_rematch_chapters(uuid, jsonb)'::regprocedure),
  array['search_path=""'], 'SECURITY DEFINER with an empty search_path');
select ok(not has_table_privilege('quiz_worker', 'public.questions', 'update'),
  'quiz_worker still cannot update questions');

-- Fixtures: ws1 (+ ws2) with a book b (chapters bc), a question paper p (chapters pc level 1,
-- pc2 level 2) and questions q1..q8.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0001', 'cr-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000c0001', 'cr ws1', '00000000-0000-4000-8000-0000000c0001'),
  ('10000000-0000-4000-8000-0000000c0002', 'cr ws2', '00000000-0000-4000-8000-0000000c0001');
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
select ('20000000-0000-4000-8000-0000000c00' || d)::uuid, w::uuid, 'D' || d, d || '.pdf', 10,
       repeat('b', 64),
       format('workspaces/%s/documents/%s/revisions/%s/source.pdf', w,
              '20000000-0000-4000-8000-0000000c00' || d, '30000000-0000-4000-8000-0000000c00' || d),
       '00000000-0000-4000-8000-0000000c0001', t
  from (values ('01', '10000000-0000-4000-8000-0000000c0001', 'book'),
               ('02', '10000000-0000-4000-8000-0000000c0001', 'question_paper'),
               ('03', '10000000-0000-4000-8000-0000000c0002', 'book')) v(d, w, t);
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by)
select ('30000000-0000-4000-8000-0000000c00' || right(id::text, 2))::uuid, workspace_id, id, 1,
       source_object_key, created_by
  from public.documents where workspace_id::text like '10000000-0000-4000-8000-0000000c000%';
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, title)
values
  ('40000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', 's1', 1, 'B1'),
  ('40000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0002', '30000000-0000-4000-8000-0000000c0002', 'p1', 1, 'P1'),
  ('40000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0002', '30000000-0000-4000-8000-0000000c0002', 'p2', 2, 'P2'),
  ('40000000-0000-4000-8000-0000000c0004', '10000000-0000-4000-8000-0000000c0002',
   '20000000-0000-4000-8000-0000000c0003', '30000000-0000-4000-8000-0000000c0003', 'o1', 1, 'O1');
update public.document_revisions set status = 'published', published_at = now()
 where workspace_id::text like '10000000-0000-4000-8000-0000000c000%';
update public.documents set active_revision_id =
  ('30000000-0000-4000-8000-0000000c00' || right(id::text, 2))::uuid, status = 'ready'
 where workspace_id::text like '10000000-0000-4000-8000-0000000c000%';
-- q1 auto/none, q2 auto/paper, q3 manual/none, q4 auto/book, q5 auto/none (other ws),
-- q6 auto/none (DRAFT), q7 auto/none (for a level-2 paper target), q8 auto/paper (to paper).
insert into public.questions (id, workspace_id, chapter_id, question_type, origin, created_by,
                              chapter_source)
select ('50000000-0000-4000-8000-0000000c000' || n)::uuid, w::uuid, c::uuid, 'ESSAY', 'import',
       '00000000-0000-4000-8000-0000000c0001', s
  from (values
    (1, '10000000-0000-4000-8000-0000000c0001', null, 'auto'),
    (2, '10000000-0000-4000-8000-0000000c0001', '40000000-0000-4000-8000-0000000c0002', 'auto'),
    (3, '10000000-0000-4000-8000-0000000c0001', null, 'manual'),
    (4, '10000000-0000-4000-8000-0000000c0001', '40000000-0000-4000-8000-0000000c0001', 'auto'),
    (5, '10000000-0000-4000-8000-0000000c0002', null, 'auto'),
    (6, '10000000-0000-4000-8000-0000000c0001', null, 'auto'),
    (7, '10000000-0000-4000-8000-0000000c0001', null, 'auto'),
    (8, '10000000-0000-4000-8000-0000000c0001', '40000000-0000-4000-8000-0000000c0002', 'auto'))
    v(n, w, c, s);
insert into public.question_revisions (id, workspace_id, question_id, version, stem)
select ('60000000-0000-4000-8000-0000000c000' || right(id::text, 1))::uuid, workspace_id, id, 1, 's'
  from public.questions where workspace_id::text like '10000000-0000-4000-8000-0000000c000%';
update public.questions set
  active_revision_id = ('60000000-0000-4000-8000-0000000c000' || right(id::text, 1))::uuid,
  publication_status = 'CONFIRMED'
 where workspace_id::text like '10000000-0000-4000-8000-0000000c000%'
   and right(id::text, 1) <> '6';

create function pg_temp.mv(q int, expected text, target text) returns jsonb language sql as $$
  select jsonb_build_object('question_id', '50000000-0000-4000-8000-0000000c000' || q,
    'expected_chapter_id', expected, 'chapter_id', target) $$;
create function pg_temp.chap(q int) returns uuid language sql as $$
  select chapter_id from public.questions
   where id = ('50000000-0000-4000-8000-0000000c000' || q)::uuid $$;

select is(public.worker_rematch_chapters('10000000-0000-4000-8000-0000000c0001',
  jsonb_build_array(
    pg_temp.mv(1, null, '40000000-0000-4000-8000-0000000c0001'),
    pg_temp.mv(2, '40000000-0000-4000-8000-0000000c0002', '40000000-0000-4000-8000-0000000c0001'),
    pg_temp.mv(3, null, '40000000-0000-4000-8000-0000000c0001'),
    pg_temp.mv(4, '40000000-0000-4000-8000-0000000c0001', '40000000-0000-4000-8000-0000000c0001'),
    pg_temp.mv(5, null, '40000000-0000-4000-8000-0000000c0004'),
    pg_temp.mv(6, null, '40000000-0000-4000-8000-0000000c0001'),
    pg_temp.mv(7, null, '40000000-0000-4000-8000-0000000c0003'),
    pg_temp.mv(8, '40000000-0000-4000-8000-0000000c0002', '40000000-0000-4000-8000-0000000c0002'))),
  2, 'only the eligible moves apply (q1 none -> book, q2 paper -> book)');
select is(pg_temp.chap(1), '40000000-0000-4000-8000-0000000c0001'::uuid, 'q1 got the book chapter');
select is(pg_temp.chap(2), '40000000-0000-4000-8000-0000000c0001'::uuid, 'q2: fallback upgraded');
select is(pg_temp.chap(3), null::uuid, 'a manual question is never touched');
select is(pg_temp.chap(5), null::uuid, 'another workspace''s question is not touched');
select is(pg_temp.chap(6), null::uuid, 'a DRAFT question is not touched');
select is(pg_temp.chap(7), null::uuid, 'a level-2 question-paper chapter is no target');
select is(pg_temp.chap(8), '40000000-0000-4000-8000-0000000c0002'::uuid,
  'a paper chapter never replaces a chapter');
select is((select chapter_source from public.questions
            where id = '50000000-0000-4000-8000-0000000c0001'), 'auto', 'chapter_source stays auto');
select is((select count(*)::int from public.question_chapter_changes
            where source = 'recommendation' and changed_by is null
              and workspace_id = '10000000-0000-4000-8000-0000000c0001'), 2,
  'one recommendation history row per move');

-- A paper fallback for a chapterless question; idempotent; a stale expected chapter is skipped.
select is(public.worker_rematch_chapters('10000000-0000-4000-8000-0000000c0001',
  jsonb_build_array(pg_temp.mv(7, null, '40000000-0000-4000-8000-0000000c0002'))), 1,
  'a level-1 paper chapter is a target for a chapterless question');
select is(public.worker_rematch_chapters('10000000-0000-4000-8000-0000000c0001',
  jsonb_build_array(pg_temp.mv(1, null, '40000000-0000-4000-8000-0000000c0001'),
                    pg_temp.mv(7, null, '40000000-0000-4000-8000-0000000c0002'))), 0,
  'a second run moves nothing (stale expected chapter)');
update public.workspaces set status = 'archived', archived_at = now()
 where id = '10000000-0000-4000-8000-0000000c0001';
select is(public.worker_rematch_chapters('10000000-0000-4000-8000-0000000c0001',
  jsonb_build_array(pg_temp.mv(2, '40000000-0000-4000-8000-0000000c0001',
                               '40000000-0000-4000-8000-0000000c0001'))), 0,
  'an archived workspace is read-only');

select * from finish();
rollback;
