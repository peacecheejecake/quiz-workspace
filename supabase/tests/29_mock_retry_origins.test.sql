begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);
select columns_are('public', 'mock_exam_practice_sessions', array['id', 'workspace_id', 'mock_exam_question_id', 'mock_exam_question_revision_id', 'user_id', 'practice_run_id', 'run_position', 'displayed_option_ids', 'shuffle_seed', 'state', 'opened_at', 'submitted_at', 'graded_at', 'created_at', 'updated_at', 'retry_origin_run_id', 'retry_origin_position'], 'mock practice session schema includes durable detached origin');
select fk_ok('public', 'mock_exam_practice_sessions', array['retry_origin_run_id', 'user_id', 'workspace_id'], 'public', 'practice_runs', array['id', 'user_id', 'workspace_id'], 'origin belongs to user and workspace');
select has_trigger('public', 'mock_exam_practice_sessions', 'mock_retry_origin_check', 'origin is checked');
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

  insert into public.practice_runs (id, workspace_id, user_id, source, mock_exam_id,
                                    mock_exam_generation_id, range, random_order, seed, item_ids)
  values ('a0000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          '00000000-0000-4000-8000-0000000f0002', 'mock', '40000000-0000-4000-8000-0000000f0001',
          '50000000-0000-4000-8000-0000000f0001', '{"all": true}', false, 1,
          array['60000000-0000-4000-8000-0000000f0001',
                '60000000-0000-4000-8000-0000000f0002']::uuid[]);

select lives_ok($$ insert into public.mock_exam_practice_sessions (id, workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('80000000-0000-4000-8000-0000000f0008', '10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0001', 1) $$, 'valid origin and detached scoring link');
select throws_ok($$ update public.mock_exam_practice_sessions set user_id = '00000000-0000-4000-8000-0000000f0001' where id = '80000000-0000-4000-8000-0000000f0008' $$, '23514', null, 'origin owner is immutable');
select throws_ok($$ update public.mock_exam_practice_sessions set retry_origin_position = 2 where id = '80000000-0000-4000-8000-0000000f0008' $$, '23514', null, 'origin is immutable');
select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0001', 2) $$, '23514', null, 'wrong position refused');

select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001', 'a0000000-0000-4000-8000-0000000f0001', 1) $$, '23514', null, 'wrong owner refused');
select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0002', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0001', 1) $$, '23514', null, 'wrong workspace refused');
insert into public.practice_runs (id, workspace_id, user_id, source, range, random_order, seed, item_ids)
 values ('a0000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'bank', '{}', false, 1, array['60000000-0000-4000-8000-0000000f0001']::uuid[]);
select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0002', 1) $$, '23514', null, 'bank run refused');

reset role;
insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, version, status, config, range, plan, seed, requested_count, created_count, finished_at)
 values ('50000000-0000-4000-8000-0000000f0003', '10000000-0000-4000-8000-0000000f0001', '40000000-0000-4000-8000-0000000f0001', 2, 'succeeded', '{}', '{}', '[{}]', 7, 1, 1, now());
set local role quiz_api;
insert into public.practice_runs (id, workspace_id, user_id, source, mock_exam_id, mock_exam_generation_id, range, random_order, seed, item_ids)
 values ('a0000000-0000-4000-8000-0000000f0003', '10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'mock', '40000000-0000-4000-8000-0000000f0001', '50000000-0000-4000-8000-0000000f0003', '{}', false, 1, array['60000000-0000-4000-8000-0000000f0001']::uuid[]);
select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0003', 1) $$, '23514', null, 'different generation refused');
reset role;
update public.mock_exams set deleted_at = now() where id = '40000000-0000-4000-8000-0000000f0001';
set local role quiz_api;
select throws_ok($$ insert into public.mock_exam_practice_sessions (workspace_id, mock_exam_question_id, mock_exam_question_revision_id, user_id, retry_origin_run_id, retry_origin_position)
 values ('10000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001', '70000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'a0000000-0000-4000-8000-0000000f0001', 1) $$, '23514', null, 'deleted exam refused');
select * from finish();
rollback;
