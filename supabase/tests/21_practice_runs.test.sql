-- QVIEW-B (20261102120000_practice_runs.sql): practice runs, their grants and RLS, immutability
-- (only finished_at, once), the practice session run link (pair, range, one session per position,
-- same user/workspace, the position's question, never re-linked) and immutable attempts
-- (QVIEW-01-C04).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

-- Shape, grants, RLS ---------------------------------------------------------------------------
select has_table('public', 'practice_runs', 'practice_runs exists');
select columns_are('public', 'practice_runs',
  array['id', 'workspace_id', 'user_id', 'source', 'mock_exam_id', 'mock_exam_generation_id',
        'range', 'random_order', 'seed', 'item_ids', 'created_at', 'finished_at']);
select has_column('public', 'practice_sessions', 'practice_run_id', 'sessions carry the run');
select has_column('public', 'practice_sessions', 'run_position', 'sessions carry the position');
select col_is_null('public', 'practice_sessions', 'practice_run_id', 'the run link is optional');
select index_is_unique('public', 'practice_sessions', 'practice_sessions_run_position_key');
select ok((select pg_get_indexdef(indexrelid) like '%WHERE (practice_run_id IS NOT NULL)%'
             from pg_index where indexrelid = 'public.practice_sessions_run_position_key'::regclass),
  'one session per run position is a partial unique index');
select ok((select relrowsecurity from pg_class where oid = 'public.practice_runs'::regclass),
  'RLS is enabled on practice_runs');
select table_privs_are('public', 'practice_runs', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api reads and inserts runs (no table-wide UPDATE, no DELETE)');
select ok(has_column_privilege('quiz_api', 'public.practice_runs', 'finished_at', 'update')
          and not has_column_privilege('quiz_api', 'public.practice_runs', 'item_ids', 'update')
          and not has_column_privilege('quiz_api', 'public.practice_runs', 'seed', 'update')
          and not has_column_privilege('quiz_api', 'public.practice_runs', 'user_id', 'update'),
  'quiz_api can only finish a run');
select table_privs_are('public', 'practice_runs', r, array[]::text[],
  format('%s has no privileges on practice_runs', r))
  from unnest(array['quiz_worker', 'anon', 'authenticated']) as r;
select ok(not has_function_privilege('quiz_api', 'public.practice_runs_guard()', 'execute')
          and not has_function_privilege('quiz_api', 'public.practice_sessions_check_run()',
                                         'execute'),
  'trigger functions are not callable');
select table_privs_are('public', 'question_attempts', 'quiz_api', array['SELECT', 'INSERT'],
  'attempts stay immutable for quiz_api (no UPDATE, no DELETE)');

-- Fixtures: user u (workspace w, questions a, b), user v (member of w); workspace w2. ---------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000e0001', 'runs-u@example.test'),
  ('00000000-0000-4000-8000-0000000e0002', 'runs-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000e0001', 'runs w', '00000000-0000-4000-8000-0000000e0001'),
  ('10000000-0000-4000-8000-0000000e0002', 'runs w2', '00000000-0000-4000-8000-0000000e0001');
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('20000000-0000-4000-8000-0000000e000a', '10000000-0000-4000-8000-0000000e0001', 'SHORT_ANSWER', 1),
  ('20000000-0000-4000-8000-0000000e000b', '10000000-0000-4000-8000-0000000e0001', 'SHORT_ANSWER', 2);
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('30000000-0000-4000-8000-0000000e000a', '10000000-0000-4000-8000-0000000e0001',
   '20000000-0000-4000-8000-0000000e000a', 1, 'A'),
  ('30000000-0000-4000-8000-0000000e000b', '10000000-0000-4000-8000-0000000e0001',
   '20000000-0000-4000-8000-0000000e000b', 1, 'B');

-- Run constraints ------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.practice_runs (id, workspace_id, user_id, source, range, random_order,
                                       seed, item_ids)
     values ('40000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
             '00000000-0000-4000-8000-0000000e0001', 'bank', '{"all": true}', false, 7,
             array['20000000-0000-4000-8000-0000000e000a',
                   '20000000-0000-4000-8000-0000000e000b']::uuid[]) $$,
  'a bank run of two positions');
select lives_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     select '10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
            'bank', '{}', true, 1, array_agg(gen_random_uuid()) from generate_series(1, 5000) $$,
  'a run of 5,000 positions');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     select '10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
            'bank', '{}', true, 1, array_agg(gen_random_uuid()) from generate_series(1, 5001) $$,
  '23514', null, 'no run of 5,001 positions');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     values ('10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
             'bank', '{}', false, 1, '{}') $$,
  '23514', null, 'no empty run');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     values ('10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
             'bank', '{}', false, 1, array[null]::uuid[]) $$,
  '23514', null, 'no null position');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     values ('10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
             'mock', '{}', false, 1, array[gen_random_uuid()]) $$,
  '23514', null, 'a mock run names its mock exam');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, mock_exam_id, range,
                                       random_order, seed, item_ids)
     values ('10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
             'bank', gen_random_uuid(), '{}', false, 1, array[gen_random_uuid()]) $$,
  '23514', null, 'a bank run names no mock exam');
select throws_ok(
  $$ insert into public.practice_runs (workspace_id, user_id, source, range, random_order, seed,
                                       item_ids)
     values ('10000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0001',
             'bank', '[]', false, 1, array[gen_random_uuid()]) $$,
  '23514', null, 'the range is an object');

-- Sessions of a run ----------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.practice_sessions (id, workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('50000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
             '20000000-0000-4000-8000-0000000e000a', '30000000-0000-4000-8000-0000000e000a',
             '00000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001', 1) $$,
  'a session of position 1');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000a',
             '30000000-0000-4000-8000-0000000e000a', '00000000-0000-4000-8000-0000000e0001',
             '40000000-0000-4000-8000-0000000e0001', 1) $$,
  '23505', null, 'one session per position');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000a',
             '30000000-0000-4000-8000-0000000e000a', '00000000-0000-4000-8000-0000000e0001',
             '40000000-0000-4000-8000-0000000e0001', 2) $$,
  '23514', null, 'a session practises the question of its position');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000b',
             '30000000-0000-4000-8000-0000000e000b', '00000000-0000-4000-8000-0000000e0001',
             '40000000-0000-4000-8000-0000000e0001', 3) $$,
  '23514', null, 'a position outside the run is refused');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000b',
             '30000000-0000-4000-8000-0000000e000b', '00000000-0000-4000-8000-0000000e0001',
             '40000000-0000-4000-8000-0000000e0001', null) $$,
  '23514', null, 'run and position are set together');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id, practice_run_id, run_position)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000b',
             '30000000-0000-4000-8000-0000000e000b', '00000000-0000-4000-8000-0000000e0002',
             '40000000-0000-4000-8000-0000000e0001', 2) $$,
  '23503', null, 'another user cannot practise the run');
select lives_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id,
                                           user_id)
     values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000a',
             '30000000-0000-4000-8000-0000000e000a', '00000000-0000-4000-8000-0000000e0001') $$,
  'sessions outside a run are unchanged');

-- As quiz_api: finish once, nothing else changes, nothing is deleted, the link never moves.
-- Test-only (rolled back), as in 02_security.
grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select throws_ok(
  $$ update public.practice_runs set item_ids = array['20000000-0000-4000-8000-0000000e000b']::uuid[]
      where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '42501', null, 'quiz_api cannot reorder a run');
select throws_ok(
  $$ delete from public.practice_runs where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '42501', null, 'quiz_api cannot delete a run');
select lives_ok(
  $$ update public.practice_runs set finished_at = now()
      where id = '40000000-0000-4000-8000-0000000e0001' $$,
  'quiz_api finishes a run');
select throws_ok(
  $$ update public.practice_runs set finished_at = now() + interval '1 hour'
      where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'a run is finished once');
select throws_ok(
  $$ update public.practice_sessions set run_position = 2
      where id = '50000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the run link of a session never changes');
select throws_ok(
  $$ update public.practice_sessions set practice_run_id = null, run_position = null
      where id = '50000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'a session is never unlinked from its run');
reset role;

-- The guard also holds for the owner role (backstop for any other writer).
select throws_ok(
  $$ update public.practice_runs set seed = 8 where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the seed never changes');
select throws_ok(
  $$ update public.practice_runs set workspace_id = '10000000-0000-4000-8000-0000000e0002'
      where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'a run never moves to another workspace');

-- A deleted workspace takes its runs and their sessions with it.
delete from public.workspaces where id = '10000000-0000-4000-8000-0000000e0001';
select is((select count(*)::int from public.practice_runs
            where user_id = '00000000-0000-4000-8000-0000000e0001'),
  0, 'runs cascade with their workspace');

select * from finish();
rollback;
