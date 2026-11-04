-- UX9-REDIST-B (20261103130000_question_chapter_source.sql): questions.chapter_source and the
-- append-only question_chapter_changes history (CHREDIST-01-C04, C07; docs/questions.md §14).
-- The backfill of existing rows runs once in the migration (its rule is the trigger's rule below:
-- an import draft registered with `chapter_manual = false` is `auto`, every other question
-- `manual`).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

-- Schema -----------------------------------------------------------------------------------------
select has_column('public', 'questions', 'chapter_source', 'questions.chapter_source exists');
select col_not_null('public', 'questions', 'chapter_source', 'chapter_source is not null');
select col_default_is('public', 'questions', 'chapter_source', 'manual'::text,
  'a new question''s chapter is set by hand unless told otherwise');
select fk_ok('public', 'questions', 'chapter_set_by', 'auth', 'users', 'id');
select columns_are('public', 'question_chapter_changes',
  array['id', 'workspace_id', 'question_id', 'from_chapter_id', 'to_chapter_id', 'source',
        'changed_by', 'changed_at']);
select ok((select relrowsecurity from pg_class
            where oid = 'public.question_chapter_changes'::regclass),
  'RLS is enabled on question_chapter_changes');
select table_privs_are('public', 'question_chapter_changes', 'quiz_api',
  array['SELECT', 'INSERT'], 'quiz_api may only read and append the chapter history');
select table_privs_are('public', 'question_chapter_changes', r, array[]::text[],
  format('%s has no privileges on question_chapter_changes', r))
  from unnest(array['anon', 'authenticated', 'quiz_worker']) as r;
select ok(not has_function_privilege('quiz_api',
            'public.question_chapter_changes_append_only()', 'execute')
          and not has_function_privilege('quiz_api',
            'public.question_drafts_register_chapter()', 'execute'),
  'trigger functions are not callable by quiz_api');

-- Fixtures: workspace w with book chapter c1; question q1 (direct), q2/q3 (to be registered from
-- import drafts d2 (suggested chapter) and d3 (reviewer-chosen chapter)). ------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000c4e0001', 'chsrc-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000c4e0001', 'chsrc ws', '00000000-0000-4000-8000-00000c4e0001');
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
values ('20000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001', 'Book',
        'b.pdf', 10, repeat('b', 64),
        'workspaces/10000000-0000-4000-8000-00000c4e0001/documents/20000000-0000-4000-8000-00000c4e0001/revisions/30000000-0000-4000-8000-00000c4e0001/source.pdf',
        '00000000-0000-4000-8000-00000c4e0001', 'book');
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by)
values ('30000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001',
        '20000000-0000-4000-8000-00000c4e0001', 1,
        'workspaces/10000000-0000-4000-8000-00000c4e0001/documents/20000000-0000-4000-8000-00000c4e0001/revisions/30000000-0000-4000-8000-00000c4e0001/source.pdf',
        '00000000-0000-4000-8000-00000c4e0001');
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, title)
values ('40000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001',
        '20000000-0000-4000-8000-00000c4e0001', '30000000-0000-4000-8000-00000c4e0001',
        'sec-ch1', 1, '1장 물의 순환');
insert into public.questions (id, workspace_id, chapter_id, question_type, origin, created_by)
values
  ('50000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001',
   '40000000-0000-4000-8000-00000c4e0001', 'ESSAY', 'manual',
   '00000000-0000-4000-8000-00000c4e0001'),
  ('50000000-0000-4000-8000-00000c4e0002', '10000000-0000-4000-8000-00000c4e0001',
   '40000000-0000-4000-8000-00000c4e0001', 'ESSAY', 'import',
   '00000000-0000-4000-8000-00000c4e0001'),
  ('50000000-0000-4000-8000-00000c4e0003', '10000000-0000-4000-8000-00000c4e0001',
   '40000000-0000-4000-8000-00000c4e0001', 'ESSAY', 'import',
   '00000000-0000-4000-8000-00000c4e0001');
insert into public.question_import_runs (id, workspace_id, created_by) values
  ('60000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001',
   '00000000-0000-4000-8000-00000c4e0001');
insert into public.question_drafts (id, workspace_id, source_type, import_run_id, position,
                                    question_type, payload, review_status, reviewed_by,
                                    reviewed_at, chapter_id, chapter_manual)
values
  ('70000000-0000-4000-8000-00000c4e0002', '10000000-0000-4000-8000-00000c4e0001', 'import',
   '60000000-0000-4000-8000-00000c4e0001', 0, 'ESSAY', '{}', 'approved',
   '00000000-0000-4000-8000-00000c4e0001', now(), null, false),
  ('70000000-0000-4000-8000-00000c4e0003', '10000000-0000-4000-8000-00000c4e0001', 'import',
   '60000000-0000-4000-8000-00000c4e0001', 1, 'ESSAY', '{}', 'approved',
   '00000000-0000-4000-8000-00000c4e0001', now(), '40000000-0000-4000-8000-00000c4e0001', true);

select is((select chapter_source from public.questions
            where id = '50000000-0000-4000-8000-00000c4e0001'), 'manual',
  'a direct registration is manual');
select throws_ok(
  $$ update public.questions set chapter_source = 'guess'
      where id = '50000000-0000-4000-8000-00000c4e0001' $$,
  '23514', null, 'chapter_source is manual or auto');

-- Registration of import drafts (API publish and worker job both set published_question_id) ----
update public.question_drafts set published_question_id = '50000000-0000-4000-8000-00000c4e0002'
 where id = '70000000-0000-4000-8000-00000c4e0002';
update public.question_drafts set published_question_id = '50000000-0000-4000-8000-00000c4e0003'
 where id = '70000000-0000-4000-8000-00000c4e0003';
select results_eq(
  $$ select id::text, chapter_source, chapter_set_by::text, chapter_set_at is not null
       from public.questions
      where id in ('50000000-0000-4000-8000-00000c4e0002', '50000000-0000-4000-8000-00000c4e0003')
      order by id $$,
  $$ values ('50000000-0000-4000-8000-00000c4e0002', 'auto',
             '00000000-0000-4000-8000-00000c4e0001', true),
            ('50000000-0000-4000-8000-00000c4e0003', 'manual',
             '00000000-0000-4000-8000-00000c4e0001', true) $$,
  'a suggested chapter is auto, a reviewer-chosen one manual; set by the registering user');
select results_eq(
  $$ select question_id::text, from_chapter_id, to_chapter_id::text, source, changed_by::text
       from public.question_chapter_changes
      where workspace_id = '10000000-0000-4000-8000-00000c4e0001'
      order by question_id $$,
  $$ values ('50000000-0000-4000-8000-00000c4e0002', null::uuid,
             '40000000-0000-4000-8000-00000c4e0001', 'import',
             '00000000-0000-4000-8000-00000c4e0001'),
            ('50000000-0000-4000-8000-00000c4e0003', null::uuid,
             '40000000-0000-4000-8000-00000c4e0001', 'import',
             '00000000-0000-4000-8000-00000c4e0001') $$,
  'each registration under a chapter is one import history row');
select is((select count(*)::int from public.question_chapter_changes
            where question_id = '50000000-0000-4000-8000-00000c4e0001'), 0,
  'a direct registration writes no history row');

-- Append-only ----------------------------------------------------------------------------------
insert into public.question_chapter_changes (id, workspace_id, question_id, from_chapter_id,
                                             to_chapter_id, source, changed_by)
values ('80000000-0000-4000-8000-00000c4e0001', '10000000-0000-4000-8000-00000c4e0001',
        '50000000-0000-4000-8000-00000c4e0001', '40000000-0000-4000-8000-00000c4e0001', null,
        'manual', '00000000-0000-4000-8000-00000c4e0001');
select throws_ok(
  $$ insert into public.question_chapter_changes (workspace_id, question_id, source)
     values ('10000000-0000-4000-8000-00000c4e0001', '50000000-0000-4000-8000-00000c4e0001',
             'remap') $$,
  '23514', null, 'source is manual, recommendation, edit or import');
select throws_ok(
  $$ update public.question_chapter_changes set source = 'edit'
      where id = '80000000-0000-4000-8000-00000c4e0001' $$,
  '55000', null, 'history rows cannot be updated');
select throws_ok(
  $$ delete from public.question_chapter_changes
      where id = '80000000-0000-4000-8000-00000c4e0001' $$,
  '55000', null, 'history rows cannot be deleted');

-- quiz_api appends and reads ---------------------------------------------------------------------
-- Test-only (rolled back).
grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
set local role quiz_api;
insert into public.question_chapter_changes (workspace_id, question_id, from_chapter_id,
                                             to_chapter_id, source, changed_by)
values ('10000000-0000-4000-8000-00000c4e0001', '50000000-0000-4000-8000-00000c4e0001', null,
        '40000000-0000-4000-8000-00000c4e0001', 'edit', '00000000-0000-4000-8000-00000c4e0001');
select is((select count(*)::int from public.question_chapter_changes
            where question_id = '50000000-0000-4000-8000-00000c4e0001'), 2,
  'quiz_api inserts and reads history rows');
reset role;

-- Cascades still apply: a removed chapter is "챕터 없음", a deleted question takes its rows. ---
update public.questions set chapter_id = null
 where workspace_id = '10000000-0000-4000-8000-00000c4e0001';
update public.question_drafts set chapter_id = null, chapter_manual = true
 where workspace_id = '10000000-0000-4000-8000-00000c4e0001';
delete from public.chapters where id = '40000000-0000-4000-8000-00000c4e0001';
select is((select count(*)::int from public.question_chapter_changes
            where workspace_id = '10000000-0000-4000-8000-00000c4e0001'
              and (from_chapter_id is not null or to_chapter_id is not null)), 0,
  'a deleted chapter is set null in the history');
select is((select count(*)::int from public.question_chapter_changes
            where workspace_id = '10000000-0000-4000-8000-00000c4e0001'), 4,
  'the rows themselves stay');
update public.question_drafts set published_question_id = null, review_status = 'pending',
                                 reviewed_by = null, reviewed_at = null
 where workspace_id = '10000000-0000-4000-8000-00000c4e0001';
delete from public.questions where id = '50000000-0000-4000-8000-00000c4e0002';
select is((select count(*)::int from public.question_chapter_changes
            where question_id = '50000000-0000-4000-8000-00000c4e0002'), 0,
  'a hard-deleted question takes its history rows');
delete from public.workspaces where id = '10000000-0000-4000-8000-00000c4e0001';
select is((select count(*)::int from public.question_chapter_changes
            where workspace_id = '10000000-0000-4000-8000-00000c4e0001'), 0,
  'a deleted workspace takes its history rows');

select * from finish();
rollback;
