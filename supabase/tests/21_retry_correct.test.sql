-- RETRY-CORRECT (20261104220000_retry_correct_only.sql, RETRY-01-C02/C03): a new incorrect graded
-- result turns `needs_retry` off on the question's row and on its actively merged duplicates'
-- rows of the same user; a correct result, or a write that does not change the graded result,
-- leaves it; other users' and other questions' rows are untouched.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

select has_trigger('public', 'question_user_states', 'question_user_states_retry_clear',
  'the insert trigger exists');
select has_trigger('public', 'question_user_states', 'question_user_states_retry_clear_update',
  'the update trigger exists');
select ok(not has_function_privilege('quiz_api', 'public.question_user_states_retry_clear()',
                                     'execute'),
  'the trigger function is not callable');

-- Fixtures: user u (and v) in workspace w; questions a (kept), b (duplicate merged into a),
-- c (unrelated). -------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000e0001', 'retry-u@example.test'),
  ('00000000-0000-4000-8000-0000000e0002', 'retry-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000e0001', 'retry w', '00000000-0000-4000-8000-0000000e0001');
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('20000000-0000-4000-8000-0000000e000a', '10000000-0000-4000-8000-0000000e0001', 'SHORT_ANSWER', 1),
  ('20000000-0000-4000-8000-0000000e000b', '10000000-0000-4000-8000-0000000e0001', 'SHORT_ANSWER', 2),
  ('20000000-0000-4000-8000-0000000e000c', '10000000-0000-4000-8000-0000000e0001', 'SHORT_ANSWER', 3);
insert into public.question_revisions (id, workspace_id, question_id, version, stem)
select ('30000000-0000-4000-8000-0000000e000' || x)::uuid,
       '10000000-0000-4000-8000-0000000e0001',
       ('20000000-0000-4000-8000-0000000e000' || x)::uuid, 1, 'Same stem'
  from unnest(array['a', 'b', 'c']) as x;
update public.questions
   set active_revision_id = ('30000000-0000-4000-8000-0000000e000' || right(id::text, 1))::uuid,
       publication_status = 'CONFIRMED'
 where id::text like '20000000-0000-4000-8000-0000000e000_';
update public.questions set publication_status = 'ARCHIVED'
 where id = '20000000-0000-4000-8000-0000000e000b';

-- Attempts 1..5 in time order: (1) a correct, (2) b correct, (3) a incorrect, (4) c correct, (5) c incorrect.
create temp table retry_attempts (n int, q text, result text) on commit drop;
insert into retry_attempts values
  (1, 'a', 'correct'), (2, 'b', 'correct'), (3, 'a', 'incorrect'), (4, 'c', 'correct'),
  (5, 'c', 'incorrect');
insert into public.practice_sessions
  (id, workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at)
select ('40000000-0000-4000-8000-0000000e000' || n)::uuid,
       '10000000-0000-4000-8000-0000000e0001',
       ('20000000-0000-4000-8000-0000000e000' || q)::uuid,
       ('30000000-0000-4000-8000-0000000e000' || q)::uuid,
       '00000000-0000-4000-8000-0000000e0001', 'graded', now() + n * interval '1 minute',
       now() + n * interval '1 minute'
  from retry_attempts;
insert into public.question_attempts
  (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
   submitted_answer, result, grading_method, submitted_at, graded_at)
select ('50000000-0000-4000-8000-0000000e000' || n)::uuid,
       '10000000-0000-4000-8000-0000000e0001',
       ('20000000-0000-4000-8000-0000000e000' || q)::uuid,
       ('30000000-0000-4000-8000-0000000e000' || q)::uuid,
       ('40000000-0000-4000-8000-0000000e000' || n)::uuid,
       '00000000-0000-4000-8000-0000000e0001', '{}', result, 'auto',
       now() + n * interval '1 minute', now() + n * interval '1 minute'
  from retry_attempts;

-- Attempt 6: v answered c incorrectly.
insert into public.practice_sessions
  (id, workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at)
values ('40000000-0000-4000-8000-0000000e0006', '10000000-0000-4000-8000-0000000e0001',
        '20000000-0000-4000-8000-0000000e000c', '30000000-0000-4000-8000-0000000e000c',
        '00000000-0000-4000-8000-0000000e0002', 'graded', now(), now());
insert into public.question_attempts
  (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
   submitted_answer, result, grading_method, submitted_at, graded_at)
values ('50000000-0000-4000-8000-0000000e0006', '10000000-0000-4000-8000-0000000e0001',
        '20000000-0000-4000-8000-0000000e000c', '30000000-0000-4000-8000-0000000e000c',
        '40000000-0000-4000-8000-0000000e0006', '00000000-0000-4000-8000-0000000e0002', '{}',
        'incorrect', 'auto', now(), now());

-- u: a and b correct with the flag on, b merged into a; c correct with the flag on. v: a, flag on.
insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
values ('10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000b',
        '20000000-0000-4000-8000-0000000e000a');
insert into public.question_user_states
  (user_id, question_id, workspace_id, last_graded_result, last_graded_attempt_id, needs_retry)
values
  ('00000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000a',
   '10000000-0000-4000-8000-0000000e0001', 'correct', '50000000-0000-4000-8000-0000000e0001', true),
  ('00000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000b',
   '10000000-0000-4000-8000-0000000e0001', 'correct', '50000000-0000-4000-8000-0000000e0002', true),
  ('00000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000c',
   '10000000-0000-4000-8000-0000000e0001', 'correct', '50000000-0000-4000-8000-0000000e0004', true),
  ('00000000-0000-4000-8000-0000000e0002', '20000000-0000-4000-8000-0000000e000a',
   '10000000-0000-4000-8000-0000000e0001', null, null, true);

select is((select count(*)::int from public.question_user_states where needs_retry),
  4, 'inserting correct (or not graded) rows keeps their flags');

-- Re-writing the same correct result does not clear.
update public.question_user_states
   set last_graded_result = 'correct', last_graded_attempt_id = '50000000-0000-4000-8000-0000000e0001'
 where user_id = '00000000-0000-4000-8000-0000000e0001'
   and question_id = '20000000-0000-4000-8000-0000000e000a';
select ok((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000a'),
  'a correct grading keeps the flag');

-- Turning the flag on or off by hand is not a grading.
update public.question_user_states set needs_retry = true
 where user_id = '00000000-0000-4000-8000-0000000e0001'
   and question_id = '20000000-0000-4000-8000-0000000e000c';
select ok((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000c'),
  'a flag write is left alone');

-- An incorrect grading of the unrelated question c clears c only.
update public.question_user_states
   set last_graded_result = 'incorrect', last_graded_attempt_id = '50000000-0000-4000-8000-0000000e0005'
 where user_id = '00000000-0000-4000-8000-0000000e0001'
   and question_id = '20000000-0000-4000-8000-0000000e000c';
select is((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000c'),
  false, 'an incorrect grading turns the flag off');
select is((select count(*)::int from public.question_user_states
            where needs_retry and question_id <> '20000000-0000-4000-8000-0000000e000c'),
  3, 'the other questions and users are untouched');

-- An incorrect grading of the kept question a clears a and its merged duplicate b for u only.
update public.question_user_states
   set last_graded_result = 'incorrect', last_graded_attempt_id = '50000000-0000-4000-8000-0000000e0003'
 where user_id = '00000000-0000-4000-8000-0000000e0001'
   and question_id = '20000000-0000-4000-8000-0000000e000a';
select is((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000a'),
  false, 'the graded row is cleared');
select is((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000b'),
  false, 'the merged duplicate''s row is cleared too');
select ok((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0002'
              and question_id = '20000000-0000-4000-8000-0000000e000a'),
  'another user''s row of the same question is untouched');

-- Inserting a row that is already graded incorrect cannot carry the flag.
insert into public.question_user_states
  (user_id, question_id, workspace_id, last_graded_result, last_graded_attempt_id, needs_retry)
values
  ('00000000-0000-4000-8000-0000000e0002', '20000000-0000-4000-8000-0000000e000c',
   '10000000-0000-4000-8000-0000000e0001', 'incorrect', '50000000-0000-4000-8000-0000000e0006',
   true);
select is((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0002'
              and question_id = '20000000-0000-4000-8000-0000000e000c'),
  false, 'an insert graded incorrect is stored without the flag');

-- The practice API grades with INSERT ... ON CONFLICT DO UPDATE (repositories/practice.py): the
-- same rule holds on that path. c is flagged by hand, then re-graded correct and incorrect.
update public.question_user_states set needs_retry = true
 where user_id = '00000000-0000-4000-8000-0000000e0001'
   and question_id = '20000000-0000-4000-8000-0000000e000c';
insert into public.question_user_states
  (user_id, question_id, workspace_id, last_graded_result, last_graded_attempt_id)
values ('00000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000c',
        '10000000-0000-4000-8000-0000000e0001', 'correct', '50000000-0000-4000-8000-0000000e0004')
on conflict (user_id, question_id) do update
  set last_graded_result = excluded.last_graded_result,
      last_graded_attempt_id = excluded.last_graded_attempt_id;
select ok((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000c'),
  'upsert path: a correct grading keeps the flag');
insert into public.question_user_states
  (user_id, question_id, workspace_id, last_graded_result, last_graded_attempt_id)
values ('00000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e000c',
        '10000000-0000-4000-8000-0000000e0001', 'incorrect', '50000000-0000-4000-8000-0000000e0005')
on conflict (user_id, question_id) do update
  set last_graded_result = excluded.last_graded_result,
      last_graded_attempt_id = excluded.last_graded_attempt_id;
select is((select needs_retry from public.question_user_states
            where user_id = '00000000-0000-4000-8000-0000000e0001'
              and question_id = '20000000-0000-4000-8000-0000000e000c'),
  false, 'upsert path: an incorrect grading turns the flag off');

-- The merged view agrees: u's a is incorrect without the flag.
select results_eq(
  $$ select last_graded_result, needs_retry from public.question_merged_user_states
      where user_id = '00000000-0000-4000-8000-0000000e0001'
        and question_id = '20000000-0000-4000-8000-0000000e000a' $$,
  $$ values ('incorrect'::text, false) $$,
  'the merged state is incorrect and not marked for retry');

select * from finish();
rollback;
