-- MOCK-B (20261102130000_mock_exams.sql): mock exam tables, their grants and RLS, one active
-- generation per mock exam, workspace integrity of every reference, the append-only history
-- (MOCK-01-C04), cascades past the append-only trigger, and the `mock_exam.generated` activity.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(57);

-- Shape, RLS, grants ---------------------------------------------------------------------------
select has_table('public', t, t || ' exists')
  from unnest(array['mock_exams', 'mock_exam_revisions', 'mock_exam_generations',
                    'mock_exam_generation_items', 'mock_exam_questions',
                    'mock_exam_question_revisions', 'mock_exam_practice_sessions',
                    'mock_exam_attempts']) as t;
select ok((select bool_and(relrowsecurity) from pg_class
            where oid in ('public.mock_exams'::regclass, 'public.mock_exam_revisions'::regclass,
                          'public.mock_exam_generations'::regclass,
                          'public.mock_exam_generation_items'::regclass,
                          'public.mock_exam_questions'::regclass,
                          'public.mock_exam_question_revisions'::regclass,
                          'public.mock_exam_practice_sessions'::regclass,
                          'public.mock_exam_attempts'::regclass)),
  'RLS is enabled on every mock exam table');
select table_privs_are('public', 'mock_exam_revisions', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api: mock exam revisions are append-only');
select table_privs_are('public', 'mock_exam_question_revisions', 'quiz_api',
  array['SELECT', 'INSERT'], 'quiz_api: question revisions are append-only');
select table_privs_are('public', 'mock_exam_attempts', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api: attempts are append-only');
select table_privs_are('public', 'mock_exam_generation_items', 'quiz_api', array['SELECT'],
  'quiz_api reads checkpoints only');
select ok(not has_table_privilege('quiz_api', 'public.mock_exams', 'delete')
          and not has_column_privilege('quiz_api', 'public.mock_exams', 'current_generation_id',
                                       'update')
          and not has_column_privilege('quiz_api', 'public.mock_exams', 'workspace_id', 'update'),
  'quiz_api never hard-deletes, re-points or moves a mock exam');
select ok(not has_table_privilege('quiz_worker', 'public.mock_exam_generations', 'insert')
          and not has_column_privilege('quiz_worker', 'public.mock_exam_generations', 'plan',
                                       'update')
          and not has_column_privilege('quiz_worker', 'public.mock_exam_generations', 'job_id',
                                       'update')
          and not has_column_privilege('quiz_worker', 'public.mock_exams', 'title', 'update')
          and not has_column_privilege('quiz_worker', 'public.mock_exams', 'deleted_at', 'update'),
  'quiz_worker cannot create generations, change their pinned plan or job, or edit a mock exam');
select ok(not has_table_privilege('quiz_worker', 'public.mock_exam_attempts', 'select')
          and not has_table_privilege('quiz_worker', 'public.mock_exam_practice_sessions',
                                      'select'),
  'quiz_worker never reads practice data');
select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
  from unnest(array['anon', 'authenticated']) as r,
       unnest(array['mock_exams', 'mock_exam_generations', 'mock_exam_questions',
                    'mock_exam_question_revisions', 'mock_exam_attempts']) as t;
select ok(not has_function_privilege('quiz_api', 'public.mock_exam_append_only()', 'execute')
          and not has_function_privilege('quiz_worker',
                                         'public.mock_exam_generations_record_finished()',
                                         'execute'),
  'trigger functions are not callable');
select has_index('public', 'mock_exam_generations', 'mock_exam_generations_active_key',
  'one queued/running generation per mock exam');

-- Fixtures ---------------------------------------------------------------------------------------
-- Test-only (rolled back): let the superuser switch to the service roles.
grant quiz_api, quiz_worker to postgres;
grant usage on schema extensions to quiz_api, quiz_worker;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000e0001', 'mock-u@example.test'),
  ('00000000-0000-4000-8000-0000000e0002', 'mock-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000e0001', 'mock w1', '00000000-0000-4000-8000-0000000e0001'),
  ('10000000-0000-4000-8000-0000000e0002', 'mock w2', '00000000-0000-4000-8000-0000000e0001');
insert into public.questions (id, workspace_id, question_type) values
  ('20000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001', 'MCQ');
insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                       correct_option_ids)
values ('30000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '20000000-0000-4000-8000-0000000e0001', 1, 'Source stem',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-1']);
update public.questions
   set active_revision_id = '30000000-0000-4000-8000-0000000e0001', publication_status = 'CONFIRMED'
 where id = '20000000-0000-4000-8000-0000000e0001';

set local role quiz_api;
insert into public.mock_exams (id, workspace_id, title, config, range, created_by) values
  ('40000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001', '중간 점검',
   '{"variation_types": ["OPTION_SHUFFLE"], "question_count": 1}', '{"all": true}',
   '00000000-0000-4000-8000-0000000e0001'),
  ('40000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-0000000e0002', '다른 곳',
   '{"variation_types": ["OPTION_SHUFFLE"], "question_count": 1}', '{"all": true}',
   '00000000-0000-4000-8000-0000000e0001');
insert into public.mock_exam_revisions (workspace_id, mock_exam_id, version, title, config, range,
                                        edited_by)
values ('10000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001', 1,
        '중간 점검', '{}', '{}', '00000000-0000-4000-8000-0000000e0001');
insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, version, config, range,
                                          plan, seed, requested_count, created_by)
values ('50000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '40000000-0000-4000-8000-0000000e0001', 1, '{}', '{}',
        '[{"position": 0, "question_id": "20000000-0000-4000-8000-0000000e0001"}]', 7, 1,
        '00000000-0000-4000-8000-0000000e0001'),
       ('50000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-0000000e0002',
        '40000000-0000-4000-8000-0000000e0002', 1, '{}', '{}', '[{"position": 0}]', 7, 1,
        '00000000-0000-4000-8000-0000000e0001');

select throws_ok($$
  insert into public.mock_exam_generations (workspace_id, mock_exam_id, version, config, range,
                                            plan, seed, requested_count)
  values ('10000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001', 2,
          '{}', '{}', '[{}]', 1, 1) $$,
  '23505', null, 'a second queued generation of the same mock exam is refused');
select throws_ok($$
  insert into public.mock_exam_generations (workspace_id, mock_exam_id, version, status, config,
                                            range, plan, seed, requested_count, finished_at)
  values ('10000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001', 3,
          'succeeded', '{}', '{}', '[{}]', 1, 1, now()) $$,
  '42501', null, 'quiz_api cannot insert a finished generation');
select throws_ok($$
  update public.mock_exams set current_generation_id = '50000000-0000-4000-8000-0000000e0001'
   where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '42501', null, 'quiz_api cannot choose the shown generation');
select throws_ok($$ delete from public.mock_exams $$, '42501', null,
  'quiz_api cannot hard-delete mock exams');
select lives_ok($$
  update public.mock_exams set title = '기말 대비', version = 2
   where id = '40000000-0000-4000-8000-0000000e0001' $$,
  'quiz_api renames a live mock exam');
reset role;

-- The worker: checkpoint, made question, first revision, shown generation. ---------------------
set local role quiz_worker;
insert into public.mock_exam_generation_items (generation_id, position, workspace_id,
                                               source_question_id, source_question_revision_id,
                                               variation_type)
values ('50000000-0000-4000-8000-0000000e0001', 0, '10000000-0000-4000-8000-0000000e0001',
        '20000000-0000-4000-8000-0000000e0001', '30000000-0000-4000-8000-0000000e0001',
        'OPTION_SHUFFLE');
insert into public.mock_exam_questions (id, workspace_id, mock_exam_id, generation_id, position,
                                        question_type, variation_type, source_question_id,
                                        source_question_revision_id)
values ('60000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '40000000-0000-4000-8000-0000000e0001', '50000000-0000-4000-8000-0000000e0001', 0, 'MCQ',
        'OPTION_SHUFFLE', '20000000-0000-4000-8000-0000000e0001',
        '30000000-0000-4000-8000-0000000e0001');
insert into public.mock_exam_question_revisions (id, workspace_id, mock_exam_question_id, version,
                                                 stem, options, correct_option_ids, origin)
values ('70000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '60000000-0000-4000-8000-0000000e0001', 1, 'Source stem',
        '[{"id": "opt-2", "text": "b"}, {"id": "opt-1", "text": "a"}]', array['opt-1'],
        'generated');
update public.mock_exam_questions set active_revision_id = '70000000-0000-4000-8000-0000000e0001'
 where id = '60000000-0000-4000-8000-0000000e0001';
update public.mock_exam_generation_items
   set status = 'done', mock_exam_question_id = '60000000-0000-4000-8000-0000000e0001'
 where generation_id = '50000000-0000-4000-8000-0000000e0001' and position = 0;
select throws_ok($$
  insert into public.mock_exam_questions (workspace_id, mock_exam_id, generation_id, position,
                                          question_type, variation_type)
  values ('10000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001',
          '50000000-0000-4000-8000-0000000e0002', 1, 'MCQ', 'PARAPHRASE') $$,
  '23503', null, 'a question cannot belong to another mock exam''s generation');
select throws_ok($$
  insert into public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, version,
                                                   stem, origin)
  values ('10000000-0000-4000-8000-0000000e0001', '60000000-0000-4000-8000-0000000e0001', 2,
          'x', 'edited') $$,
  '42501', null, 'the worker writes first (generated) revisions only, never edits');
select lives_ok($$
  update public.mock_exam_generations
     set status = 'succeeded', created_count = 1, progress_done = 1, llm_calls = 0,
         finished_at = now()
   where id = '50000000-0000-4000-8000-0000000e0001' $$,
  'the worker finishes its generation');
select lives_ok($$
  update public.mock_exams set current_generation_id = '50000000-0000-4000-8000-0000000e0001'
   where id = '40000000-0000-4000-8000-0000000e0001' $$,
  'the worker shows the finished generation');
select throws_ok($$
  update public.mock_exams set current_generation_id = '50000000-0000-4000-8000-0000000e0002'
   where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23503', null, 'the shown generation is one of the mock exam''s own');
select throws_ok($$ update public.mock_exams set title = 'x' $$, '42501', null,
  'the worker cannot rename');
reset role;

select is((select count(*)::int from public.activity_events
            where workspace_id = '10000000-0000-4000-8000-0000000e0001'
              and event_type = 'mock_exam.generated'
              and metadata ->> 'generation_id' = '50000000-0000-4000-8000-0000000e0001'
              and metadata ->> 'created_count' = '1'),
  1, 'a finished generation records mock_exam.generated (ids and counts)');
select ok((select not (metadata ?| array['stem', 'title', 'prompt', 'explanation'])
             from public.activity_events where event_type = 'mock_exam.generated'
              and workspace_id = '10000000-0000-4000-8000-0000000e0001'),
  'the activity carries no text');

-- Practice rows (MOCK-P) and the append-only history (C04) -----------------------------------
set local role quiz_api;
select throws_ok($$
  insert into public.mock_exam_generations (workspace_id, mock_exam_id, version, config, range,
                                            plan, seed, requested_count)
  values ('10000000-0000-4000-8000-0000000e0002', '40000000-0000-4000-8000-0000000e0001', 9,
          '{}', '{}', '[{}]', 1, 1) $$,
  '23503', null, 'a generation cannot claim another workspace');
select throws_ok($$
  insert into public.mock_exam_generations (workspace_id, mock_exam_id, version, config, range,
                                            plan, seed, requested_count)
  values ('10000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0001', 9,
          '{}', '{}', '[{}, {}]', 1, 1) $$,
  '23514', null, 'requested_count matches the plan');
insert into public.mock_exam_practice_sessions (id, workspace_id, mock_exam_question_id,
                                                mock_exam_question_revision_id, user_id,
                                                displayed_option_ids, state, submitted_at,
                                                graded_at)
values ('80000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '60000000-0000-4000-8000-0000000e0001', '70000000-0000-4000-8000-0000000e0001',
        '00000000-0000-4000-8000-0000000e0002', array['opt-2', 'opt-1'], 'graded', now(), now());
insert into public.mock_exam_attempts (id, workspace_id, mock_exam_question_id,
                                       mock_exam_question_revision_id, practice_session_id,
                                       user_id, displayed_option_ids, submitted_answer, result,
                                       grading_method, graded_at)
values ('90000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '60000000-0000-4000-8000-0000000e0001', '70000000-0000-4000-8000-0000000e0001',
        '80000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0002',
        array['opt-2', 'opt-1'], '{"selected_option_ids": ["opt-1"]}', 'correct', 'auto', now());
select throws_ok($$
  insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id,
                                                  mock_exam_question_revision_id, user_id)
  values ('10000000-0000-4000-8000-0000000e0002', '60000000-0000-4000-8000-0000000e0001',
          '70000000-0000-4000-8000-0000000e0001', '00000000-0000-4000-8000-0000000e0002') $$,
  '23503', null, 'a session cannot claim another workspace');
select lives_ok($$
  insert into public.mock_exam_question_revisions (id, workspace_id, mock_exam_question_id,
                                                   version, stem, options, correct_option_ids,
                                                   origin, edited_by)
  values ('70000000-0000-4000-8000-0000000e0002', '10000000-0000-4000-8000-0000000e0001',
          '60000000-0000-4000-8000-0000000e0001', 2, 'Edited stem',
          '[{"id": "opt-2", "text": "b"}, {"id": "opt-1", "text": "a"}]', array['opt-1'],
          'edited', '00000000-0000-4000-8000-0000000e0001') $$,
  'an edit is a new revision');
select throws_ok($$
  insert into public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, version,
                                                   stem, origin)
  values ('10000000-0000-4000-8000-0000000e0001', '60000000-0000-4000-8000-0000000e0001', 3,
          'x', 'generated') $$,
  '42501', null, 'quiz_api writes edited revisions only');
select lives_ok($$
  update public.mock_exam_questions
     set active_revision_id = '70000000-0000-4000-8000-0000000e0002', removed_at = now(),
         removed_by = '00000000-0000-4000-8000-0000000e0001'
   where id = '60000000-0000-4000-8000-0000000e0001' $$,
  'quiz_api moves the active revision and removes a question (soft)');
select throws_ok($$ update public.mock_exam_attempts set result = 'incorrect' $$, '42501', null,
  'quiz_api cannot update an attempt');
reset role;

-- Even the superuser cannot rewrite history (the trigger, not only the grants).
select throws_ok($$ update public.mock_exam_attempts set submitted_at = submitted_at $$,
  '55000', null, 'attempts refuse UPDATE');
select throws_ok($$ delete from public.mock_exam_attempts $$, '55000', null,
  'attempts refuse DELETE');
select throws_ok($$ update public.mock_exam_question_revisions set created_at = created_at $$,
  '55000', null, 'question revisions refuse UPDATE');
select throws_ok($$ delete from public.mock_exam_question_revisions $$, '55000', null,
  'question revisions refuse DELETE');
select throws_ok($$ update public.mock_exam_revisions set title = 'x' $$, '55000', null,
  'mock exam revisions refuse UPDATE');

-- A hard-deleted source keeps the copy (FK set null), a deleted user's attempts and a deleted
-- workspace's rows cascade past the trigger.
delete from public.questions where id = '20000000-0000-4000-8000-0000000e0001';
select is((select row(source_question_id, source_question_revision_id)::text
             from public.mock_exam_questions where id = '60000000-0000-4000-8000-0000000e0001'),
  '(,)', 'a hard-deleted source leaves the copy, unlinked');
delete from auth.users where id = '00000000-0000-4000-8000-0000000e0002';
select is((select count(*)::int from public.mock_exam_attempts
            where id = '90000000-0000-4000-8000-0000000e0001'),
  0, 'a deleted user''s attempts cascade');
delete from public.workspaces where id = '10000000-0000-4000-8000-0000000e0001';
select is((select count(*)::int from public.mock_exam_question_revisions
            where workspace_id = '10000000-0000-4000-8000-0000000e0001'),
  0, 'a deleted workspace''s mock exams cascade past the append-only trigger');
select is((select count(*)::int from public.mock_exams
            where workspace_id = '10000000-0000-4000-8000-0000000e0001'),
  0, 'the mock exam is gone with its workspace');

select * from finish();
rollback;
