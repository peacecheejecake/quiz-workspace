-- M4.4a (20261018100000): import drafts are unique per (run, position), carry question_number /
-- is_multi_answer, and quiz_worker may only read runs, move their state, and insert pending,
-- unreviewed, unpublished import drafts (never update/delete a draft).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000004a4a01', 'm44a-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000004a4a01', 'import ws', '00000000-0000-4000-8000-0000004a4a01');
insert into public.question_import_runs (id, workspace_id, created_by) values
  ('20000000-0000-4000-8000-0000004a4a01', '10000000-0000-4000-8000-0000004a4a01',
   '00000000-0000-4000-8000-0000004a4a01');
insert into public.question_drafts (id, workspace_id, source_type, import_run_id, position,
                                    question_type, payload) values
  ('30000000-0000-4000-8000-0000004a4a01', '10000000-0000-4000-8000-0000004a4a01', 'import',
   '20000000-0000-4000-8000-0000004a4a01', 0, 'ESSAY', '{}');

-- Schema ------------------------------------------------------------------------------------------
select has_column('public', 'question_drafts', 'question_number', 'drafts carry the printed number');
select has_column('public', 'question_drafts', 'rubric', 'drafts carry an essay model answer (20261018120000)');
select col_not_null('public', 'question_drafts', 'is_multi_answer', 'is_multi_answer is not null');
select col_default_is('public', 'question_drafts', 'is_multi_answer', 'false',
  'is_multi_answer defaults to false');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, import_run_id, position,
                                         question_type, payload)
     values ('10000000-0000-4000-8000-0000004a4a01', 'import',
             '20000000-0000-4000-8000-0000004a4a01', 0, 'ESSAY', '{}') $$,
  '23505', null, 'one draft per (import run, position)');
select throws_ok(
  $$ update public.question_drafts set question_number = 0
      where id = '30000000-0000-4000-8000-0000004a4a01' $$,
  '23514', null, 'question_number is positive');

-- Privileges --------------------------------------------------------------------------------------
select ok(has_table_privilege('quiz_worker', 'public.question_import_runs', 'select'),
  'quiz_worker reads runs');
select ok(not has_table_privilege('quiz_worker', 'public.question_import_runs', 'insert')
          and not has_table_privilege('quiz_worker', 'public.question_import_runs', 'delete'),
  'quiz_worker cannot create or delete runs');
select ok(has_column_privilege('quiz_worker', 'public.question_import_runs', 'status', 'update')
          and has_column_privilege('quiz_worker', 'public.question_import_runs', 'finished_at',
                                   'update'),
  'quiz_worker moves the run state');
select ok(not has_column_privilege('quiz_worker', 'public.question_import_runs',
                                   'source_document_revision_id', 'update')
          and not has_column_privilege('quiz_worker', 'public.question_import_runs',
                                       'async_job_id', 'update')
          and not has_column_privilege('quiz_worker', 'public.question_import_runs',
                                       'created_by', 'update'),
  'but cannot re-point it at another revision, job or creator');
select ok(has_table_privilege('quiz_worker', 'public.question_drafts', 'select')
          and has_table_privilege('quiz_worker', 'public.question_drafts', 'insert'),
  'quiz_worker reads and inserts drafts');
select ok(not has_table_privilege('quiz_worker', 'public.question_drafts', 'update')
          and not has_table_privilege('quiz_worker', 'public.question_drafts', 'delete'),
  'quiz_worker never updates or deletes a draft');

-- Row level security as quiz_worker -----------------------------------------------------------------
grant quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select is((select count(*)::int from public.question_import_runs
            where id = '20000000-0000-4000-8000-0000004a4a01'), 1, 'quiz_worker sees runs');
select lives_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, import_run_id, position,
                                         question_type, payload)
     values ('10000000-0000-4000-8000-0000004a4a01', 'import',
             '20000000-0000-4000-8000-0000004a4a01', 1, 'ESSAY', '{}') $$,
  'quiz_worker inserts a pending import draft');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, import_run_id, position,
                                         question_type, payload, review_status, reviewed_at)
     values ('10000000-0000-4000-8000-0000004a4a01', 'import',
             '20000000-0000-4000-8000-0000004a4a01', 2, 'ESSAY', '{}', 'approved', now()) $$,
  '42501', null, 'but not an approved one');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, import_run_id, position,
                                         question_type, payload, reviewed_by)
     values ('10000000-0000-4000-8000-0000004a4a01', 'import',
             '20000000-0000-4000-8000-0000004a4a01', 3, 'ESSAY', '{}',
             '00000000-0000-4000-8000-0000004a4a01') $$,
  '42501', null, 'nor a reviewed one');
select lives_ok(
  $$ update public.question_import_runs set status = 'running'
      where id = '20000000-0000-4000-8000-0000004a4a01' $$,
  'quiz_worker updates the run status');
reset role;
select is(
  (select status from public.question_import_runs
    where id = '20000000-0000-4000-8000-0000004a4a01'),
  'running', 'the status moved');

select * from finish();
rollback;
