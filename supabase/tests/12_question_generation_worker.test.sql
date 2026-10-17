-- M6.2 (20261018150000): generation drafts are unique per (run, position), carry the reviewer's
-- acknowledged codes, runs keep their passages, and quiz_worker may only read runs and questions,
-- move a run's state, and insert pending, unreviewed, unpublished generation drafts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000006b6201', 'm62-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000006b6201', 'generation ws', '00000000-0000-4000-8000-0000006b6201');
insert into public.questions (id, workspace_id, question_type) values
  ('40000000-0000-4000-8000-0000006b6201', '10000000-0000-4000-8000-0000006b6201', 'SHORT_ANSWER');
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('50000000-0000-4000-8000-0000006b6201', '10000000-0000-4000-8000-0000006b6201',
   '40000000-0000-4000-8000-0000006b6201', 1, 'source');
insert into public.question_generation_runs (id, workspace_id, created_by, source_question_id,
                                             source_question_revision_id, variation_types) values
  ('20000000-0000-4000-8000-0000006b6201', '10000000-0000-4000-8000-0000006b6201',
   '00000000-0000-4000-8000-0000006b6201', '40000000-0000-4000-8000-0000006b6201',
   '50000000-0000-4000-8000-0000006b6201', array['PARAPHRASE']);
insert into public.question_drafts (id, workspace_id, source_type, generation_run_id, position,
                                    question_type, payload) values
  ('30000000-0000-4000-8000-0000006b6201', '10000000-0000-4000-8000-0000006b6201', 'generation',
   '20000000-0000-4000-8000-0000006b6201', 0, 'SHORT_ANSWER', '{}');

-- Schema ------------------------------------------------------------------------------------------
select col_default_is('public', 'question_generation_runs', 'passages', '[]',
  'runs start without passages');
select throws_ok(
  $$ update public.question_generation_runs set passages = '{}'
      where id = '20000000-0000-4000-8000-0000006b6201' $$,
  '23514', null, 'passages is a JSON array');
select col_default_is('public', 'question_drafts', 'acknowledged_codes', '{}',
  'drafts start with nothing acknowledged');
select lives_ok(
  $$ update public.question_drafts set acknowledged_codes = array['answer_count_changed']
      where id = '30000000-0000-4000-8000-0000006b6201' $$,
  'a confirmable code can be acknowledged');
select throws_ok(
  $$ update public.question_drafts set acknowledged_codes = array['duplicate_of_source']
      where id = '30000000-0000-4000-8000-0000006b6201' $$,
  '23514', null, 'only confirmable codes can be acknowledged');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, generation_run_id, position,
                                         question_type, payload)
     values ('10000000-0000-4000-8000-0000006b6201', 'generation',
             '20000000-0000-4000-8000-0000006b6201', 0, 'SHORT_ANSWER', '{}') $$,
  '23505', null, 'one draft per (generation run, position)');

-- Privileges --------------------------------------------------------------------------------------
select ok(has_table_privilege('quiz_worker', 'public.question_generation_runs', 'select'),
  'quiz_worker reads runs');
select ok(not has_table_privilege('quiz_worker', 'public.question_generation_runs', 'insert')
          and not has_table_privilege('quiz_worker', 'public.question_generation_runs', 'delete'),
  'quiz_worker cannot create or delete runs');
select is(
  (select array_agg(column_name::text order by column_name::text)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'question_generation_runs'
      and grantee = 'quiz_worker' and privilege_type = 'UPDATE'),
  array['finished_at', 'llm_model', 'passages', 'prompt_version', 'status', 'updated_at'],
  'quiz_worker moves only the run state (never its source revision, job or creator)');
select table_privs_are('public', t, 'quiz_worker', array['SELECT'],
  format('quiz_worker only reads %s', t))
from unnest(array['questions', 'question_revisions', 'question_sources']) as t;
select ok(not has_table_privilege('quiz_worker', 'public.question_lineage', 'select')
          and not has_table_privilege('quiz_worker', 'public.question_attempts', 'select'),
  'quiz_worker has nothing on lineage or attempts');

-- Row level security as quiz_worker -----------------------------------------------------------------
grant quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select is((select count(*)::int from public.question_generation_runs
            where id = '20000000-0000-4000-8000-0000006b6201'), 1, 'quiz_worker sees runs');
select is((select count(*)::int from public.question_drafts
            where generation_run_id = '20000000-0000-4000-8000-0000006b6201'), 1,
  'quiz_worker sees generation drafts');
select lives_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, generation_run_id, position,
                                         question_type, payload)
     values ('10000000-0000-4000-8000-0000006b6201', 'generation',
             '20000000-0000-4000-8000-0000006b6201', 1, 'SHORT_ANSWER', '{}') $$,
  'quiz_worker inserts a pending generation draft');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, generation_run_id, position,
                                         question_type, payload, review_status, reviewed_at)
     values ('10000000-0000-4000-8000-0000006b6201', 'generation',
             '20000000-0000-4000-8000-0000006b6201', 2, 'SHORT_ANSWER', '{}', 'approved',
             now()) $$,
  '42501', null, 'but not an approved one');
select throws_ok(
  $$ insert into public.question_drafts (workspace_id, source_type, generation_run_id, position,
                                         question_type, payload, acknowledged_codes)
     values ('10000000-0000-4000-8000-0000006b6201', 'generation',
             '20000000-0000-4000-8000-0000006b6201', 3, 'SHORT_ANSWER', '{}',
             array['answer_count_changed']) $$,
  '42501', null, 'nor one with a reviewer confirmation');
select lives_ok(
  $$ update public.question_generation_runs set status = 'running'
      where id = '20000000-0000-4000-8000-0000006b6201' $$,
  'quiz_worker updates the run status');
select throws_ok(
  $$ update public.question_drafts set review_status = 'approved'
      where id = '30000000-0000-4000-8000-0000006b6201' $$,
  '42501', null, 'quiz_worker never updates a draft');
reset role;

select * from finish();
rollback;
