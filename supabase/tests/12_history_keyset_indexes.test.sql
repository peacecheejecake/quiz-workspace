-- M7.1 (20261018140000): keyset indexes of the HISTORY-01 lists. The plans that use them are
-- checked in tests/integration/history/test_history_api.py.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(3);

select has_index('public', 'activity_events', 'activity_events_workspace_created_idx',
  'activity feed keyset index (baseline)');
select has_index('public', 'async_jobs', 'async_jobs_workspace_created_id_idx',
  'workspace job list keyset index');
select has_index('public', 'question_attempts', 'question_attempts_workspace_user_submitted_idx',
  'per-user workspace attempts keyset index');

select * from finish();
rollback;
