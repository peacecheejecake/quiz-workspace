-- M3.2b fix (20261017230000): worker_workspace_writable answers "may this job still write into
-- the workspace" for quiz_worker only, without giving it any table privilege. The lock/serialisation
-- with a concurrent archive is covered by the two-session infra test
-- apps/worker/tests/test_document_job_workspace.py (pgTAP has one session).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000003b2f01', 'm32b-owner@example.test'),
  ('00000000-0000-4000-8000-0000003b2f02', 'm32b-editor@example.test'),
  ('00000000-0000-4000-8000-0000003b2f03', 'm32b-viewer@example.test'),
  ('00000000-0000-4000-8000-0000003b2f04', 'm32b-stranger@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000003b2f01', 'active ws', '00000000-0000-4000-8000-0000003b2f01'),
  ('10000000-0000-4000-8000-0000003b2f02', 'archived ws', '00000000-0000-4000-8000-0000003b2f01'),
  ('10000000-0000-4000-8000-0000003b2f03', 'deleted ws', '00000000-0000-4000-8000-0000003b2f01');
update public.workspaces set status = 'archived', archived_at = now()
 where id = '10000000-0000-4000-8000-0000003b2f02';
update public.workspaces set status = 'deleted', deleted_at = now()
 where id = '10000000-0000-4000-8000-0000003b2f03';
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000003b2f01', '00000000-0000-4000-8000-0000003b2f01', 'owner'),
  ('10000000-0000-4000-8000-0000003b2f01', '00000000-0000-4000-8000-0000003b2f02', 'editor'),
  ('10000000-0000-4000-8000-0000003b2f01', '00000000-0000-4000-8000-0000003b2f03', 'viewer'),
  ('10000000-0000-4000-8000-0000003b2f02', '00000000-0000-4000-8000-0000003b2f01', 'owner'),
  ('10000000-0000-4000-8000-0000003b2f03', '00000000-0000-4000-8000-0000003b2f01', 'owner');

-- Privileges --------------------------------------------------------------------------------------
select ok(
  has_function_privilege('quiz_worker', 'public.worker_workspace_writable(uuid, uuid, boolean)',
                         'execute'),
  'quiz_worker can execute worker_workspace_writable');
select ok(
  not has_function_privilege('quiz_api', 'public.worker_workspace_writable(uuid, uuid, boolean)',
                             'execute'),
  'quiz_api cannot');
select ok(
  not has_function_privilege('authenticated',
                             'public.worker_workspace_writable(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('anon',
                                 'public.worker_workspace_writable(uuid, uuid, boolean)', 'execute'),
  'the Data API roles cannot');
select ok(
  not has_table_privilege('quiz_worker', 'public.workspaces', 'select')
  and not has_table_privilege('quiz_worker', 'public.workspace_memberships', 'select'),
  'quiz_worker still has no table privileges on workspaces / memberships');
select is(
  (select prosecdef from pg_proc where oid = 'public.worker_workspace_writable(uuid, uuid, boolean)'::regprocedure),
  true, 'the function is SECURITY DEFINER');
select is(
  (select proconfig from pg_proc where oid = 'public.worker_workspace_writable(uuid, uuid, boolean)'::regprocedure),
  array['search_path=""'], 'with a fixed empty search_path');

-- Answers (as the test owner; execute rights are asserted above) -------------------------------------
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f01',
  '00000000-0000-4000-8000-0000003b2f01'), true, 'owner of an active workspace: writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f01',
  '00000000-0000-4000-8000-0000003b2f02', true), true, 'editor (with lock): writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f01',
  '00000000-0000-4000-8000-0000003b2f03'), false, 'viewer: not writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f01',
  '00000000-0000-4000-8000-0000003b2f04'), false, 'non-member: not writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f02',
  '00000000-0000-4000-8000-0000003b2f01', true), false, 'archived workspace: not writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f03',
  '00000000-0000-4000-8000-0000003b2f01'), false, 'deleted workspace: not writable');
select is(public.worker_workspace_writable('10000000-0000-4000-8000-0000003b2f01', null), false,
  'no user (system job / deleted creator): not writable');
select is(public.worker_workspace_writable(gen_random_uuid(),
  '00000000-0000-4000-8000-0000003b2f01'), false, 'unknown workspace: not writable');

select * from finish();
rollback;
