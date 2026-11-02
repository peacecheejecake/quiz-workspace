-- MOCK-P (20261102150000_mock_practice_runs.sql): a `source = mock` practice run names its mock
-- exam and generation in the same workspace; a run-linked mock practice session belongs to the
-- run's user and workspace, practises the mock exam question at its 1-based position, once per
-- position, and never changes its link; deleting the workspace cascades past the append-only
-- attempts.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

select fk_ok('public', 'practice_runs', array['workspace_id', 'mock_exam_id'],
             'public', 'mock_exams', array['workspace_id', 'id'],
  'a mock run names a mock exam of its workspace');
select fk_ok('public', 'practice_runs', array['mock_exam_id', 'mock_exam_generation_id'],
             'public', 'mock_exam_generations', array['mock_exam_id', 'id'],
  'a mock run names a generation of its mock exam');
select fk_ok('public', 'mock_exam_practice_sessions',
             array['practice_run_id', 'user_id', 'workspace_id'],
             'public', 'practice_runs', array['id', 'user_id', 'workspace_id'],
  'a run-linked mock session belongs to the run''s user and workspace');
select has_trigger('public', 'mock_exam_practice_sessions',
                   'mock_exam_practice_sessions_check_run', 'the run link is checked');
select ok(not has_function_privilege('quiz_api',
                                     'public.mock_exam_practice_sessions_check_run()', 'execute'),
  'the trigger function is not callable');

-- Fixtures (superuser; rolled back) ------------------------------------------------------------
grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0001', 'mockp-u@example.test'),
  ('00000000-0000-4000-8000-0000000f0002', 'mockp-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0001', 'mockp w1', '00000000-0000-4000-8000-0000000f0001'),
  ('10000000-0000-4000-8000-0000000f0002', 'mockp w2', '00000000-0000-4000-8000-0000000f0001');
insert into public.mock_exams (id, workspace_id, title, config, range, created_by) values
  ('40000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001', 'A', '{}',
   '{}', '00000000-0000-4000-8000-0000000f0001'),
  ('40000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001', 'B', '{}',
   '{}', '00000000-0000-4000-8000-0000000f0001'),
  ('40000000-0000-4000-8000-0000000f0003', '10000000-0000-4000-8000-0000000f0002', 'C', '{}',
   '{}', '00000000-0000-4000-8000-0000000f0001');
insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, version, status, config,
                                          range, plan, seed, requested_count, created_count,
                                          finished_at)
values ('50000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '40000000-0000-4000-8000-0000000f0001', 1, 'succeeded', '{}', '{}', '[{}, {}]', 7, 2, 2,
        now()),
       ('50000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
        '40000000-0000-4000-8000-0000000f0002', 1, 'succeeded', '{}', '{}', '[{}]', 7, 1, 1,
        now());
insert into public.mock_exam_questions (id, workspace_id, mock_exam_id, generation_id, position,
                                        question_type, variation_type)
values ('60000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '40000000-0000-4000-8000-0000000f0001', '50000000-0000-4000-8000-0000000f0001', 0, 'MCQ',
        'OPTION_SHUFFLE'),
       ('60000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
        '40000000-0000-4000-8000-0000000f0001', '50000000-0000-4000-8000-0000000f0001', 1, 'MCQ',
        'OPTION_SHUFFLE');
insert into public.mock_exam_question_revisions (id, workspace_id, mock_exam_question_id, version,
                                                 stem, options, correct_option_ids, origin)
values ('70000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '60000000-0000-4000-8000-0000000f0001', 1, 'Q1',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-1'],
        'generated'),
       ('70000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
        '60000000-0000-4000-8000-0000000f0002', 1, 'Q2',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-2'],
        'generated');
update public.mock_exam_questions
   set active_revision_id = ('70000000-0000-4000-8000-0000000f000' || right(id::text, 1))::uuid
 where workspace_id = '10000000-0000-4000-8000-0000000f0001';

set local role quiz_api;
-- Runs ------------------------------------------------------------------------------------------
select lives_ok($$
  insert into public.practice_runs (id, workspace_id, user_id, source, mock_exam_id,
                                    mock_exam_generation_id, range, random_order, seed, item_ids)
  values ('a0000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          '00000000-0000-4000-8000-0000000f0002', 'mock', '40000000-0000-4000-8000-0000000f0001',
          '50000000-0000-4000-8000-0000000f0001', '{"all": true}', false, 1,
          array['60000000-0000-4000-8000-0000000f0001',
                '60000000-0000-4000-8000-0000000f0002']::uuid[]) $$,
  'a mock run of the shown generation');
select throws_ok($$
  insert into public.practice_runs (workspace_id, user_id, source, mock_exam_id, range,
                                    random_order, seed, item_ids)
  values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'mock',
          '40000000-0000-4000-8000-0000000f0001', '{}', false, 1,
          array['60000000-0000-4000-8000-0000000f0001']::uuid[]) $$,
  '23514', null, 'a mock run names its generation');
select throws_ok($$
  insert into public.practice_runs (workspace_id, user_id, source, mock_exam_id,
                                    mock_exam_generation_id, range, random_order, seed, item_ids)
  values ('10000000-0000-4000-8000-0000000f0002', '00000000-0000-4000-8000-0000000f0002', 'mock',
          '40000000-0000-4000-8000-0000000f0001', '50000000-0000-4000-8000-0000000f0001', '{}',
          false, 1, array['60000000-0000-4000-8000-0000000f0001']::uuid[]) $$,
  '23503', null, 'a run cannot claim another workspace''s mock exam');
select throws_ok($$
  insert into public.practice_runs (workspace_id, user_id, source, mock_exam_id,
                                    mock_exam_generation_id, range, random_order, seed, item_ids)
  values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'mock',
          '40000000-0000-4000-8000-0000000f0001', '50000000-0000-4000-8000-0000000f0002', '{}',
          false, 1, array['60000000-0000-4000-8000-0000000f0001']::uuid[]) $$,
  '23503', null, 'a run cannot name another mock exam''s generation');
-- A bank run listing a mock question id (no FK on item_ids) must not link a mock session.
insert into public.practice_runs (id, workspace_id, user_id, source, range, random_order, seed,
                                  item_ids)
values ('a0000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
        '00000000-0000-4000-8000-0000000f0002', 'bank', '{}', false, 1,
        array['60000000-0000-4000-8000-0000000f0001']::uuid[]);

-- Run-linked mock practice sessions -------------------------------------------------------------
select lives_ok($$
  insert into public.mock_exam_practice_sessions (id, workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('80000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          '60000000-0000-4000-8000-0000000f0002', '70000000-0000-4000-8000-0000000f0002',
          '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0001', 2) $$,
  'a session of the question at its (1-based) position');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
          '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002',
          'a0000000-0000-4000-8000-0000000f0001', 2) $$,
  '23514', null, 'a session practises the question at its position');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0002',
          '70000000-0000-4000-8000-0000000f0002', '00000000-0000-4000-8000-0000000f0002',
          'a0000000-0000-4000-8000-0000000f0001', 2) $$,
  '23505', null, 'one session per run position');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
          '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002',
          'a0000000-0000-4000-8000-0000000f0001', 0) $$,
  '23514', null, 'positions start at 1');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
          '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002',
          'a0000000-0000-4000-8000-0000000f0002', 1) $$,
  '23514', null, 'a bank run never links a mock session');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id, run_position)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
          '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
          'a0000000-0000-4000-8000-0000000f0001', 1) $$,
  '23503', null, 'a session cannot use another user''s run');
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id,
                                                  practice_run_id)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
          '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002',
          'a0000000-0000-4000-8000-0000000f0001') $$,
  '23514', null, 'run id and position go together');
select throws_ok($$
  update public.mock_exam_practice_sessions set run_position = 1
   where id = '80000000-0000-4000-8000-0000000f0001' $$,
  '23514', null, 'the run link never changes');
select lives_ok($$
  update public.mock_exam_practice_sessions
     set state = 'graded', submitted_at = now(), graded_at = now()
   where id = '80000000-0000-4000-8000-0000000f0001' $$,
  'the session state still moves on');
select lives_ok($$
  insert into public.mock_exam_attempts (workspace_id, mock_exam_question_id,
                                         mock_exam_question_revision_id, practice_session_id,
                                         user_id, submitted_answer, result, grading_method,
                                         graded_at)
  values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0002',
          '70000000-0000-4000-8000-0000000f0002', '80000000-0000-4000-8000-0000000f0001',
          '00000000-0000-4000-8000-0000000f0002', '{"selected_option_ids": ["opt-2"]}',
          'correct', 'auto', now()) $$,
  'the run position''s attempt');
reset role;

-- A deleted workspace's runs, sessions and attempts cascade past the append-only trigger.
delete from public.workspaces where id = '10000000-0000-4000-8000-0000000f0001';
select is((select count(*)::int from public.mock_exam_attempts
            where workspace_id = '10000000-0000-4000-8000-0000000f0001')
          + (select count(*)::int from public.practice_runs
              where workspace_id = '10000000-0000-4000-8000-0000000f0001'),
  0, 'a deleted workspace''s mock runs and attempts cascade');

select * from finish();
rollback;
