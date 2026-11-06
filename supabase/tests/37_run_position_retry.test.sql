-- UX12 MOCKUX-15 (20261106230000): a run position has one live session; `다시 풀기` supersedes the
-- graded one, which stays linked. Behaviour: tests/integration/questions/practice_runs.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

select col_is_null('public', 'practice_sessions', 'superseded_at', 'bank sessions start live');
select col_is_null('public', 'mock_exam_practice_sessions', 'superseded_at',
  'mock sessions start live');
select ok((select indisunique and pg_get_indexdef(indexrelid)
             like '%WHERE ((practice_run_id IS NOT NULL) AND (superseded_at IS NULL))%'
             from pg_index
            where indexrelid = 'public.practice_sessions_run_position_live_key'::regclass),
  'one live bank session per position');
select ok((select indisunique and pg_get_indexdef(indexrelid)
             like '%WHERE ((practice_run_id IS NOT NULL) AND (superseded_at IS NULL))%'
             from pg_index
            where indexrelid = 'public.mock_exam_practice_sessions_run_position_live_key'::regclass),
  'one live mock session per position');
select has_trigger('public', 'practice_sessions', 'practice_sessions_check_superseded',
  'bank supersession is checked');
select has_trigger('public', 'mock_exam_practice_sessions',
  'mock_exam_practice_sessions_check_superseded', 'mock supersession is checked');
select col_has_check('public', 'practice_sessions', array['superseded_at', 'practice_run_id'],
  'only a run session is superseded');
select ok(not has_function_privilege('quiz_api', 'public.run_session_check_superseded()', 'execute'),
  'the trigger function is not callable by the API role');

select * from finish();
rollback;
