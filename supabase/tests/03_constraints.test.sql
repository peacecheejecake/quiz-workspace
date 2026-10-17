-- P0.9: check constraints, uniqueness and triggers behave as specified.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'p09-owner@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'p09-editor@example.test');

insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000000b1', 'ws one', '00000000-0000-4000-8000-0000000000a1'),
  ('10000000-0000-4000-8000-0000000000b2', 'ws two', '00000000-0000-4000-8000-0000000000a1');

-- profiles --------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.profiles (user_id, display_name)
     values ('00000000-0000-4000-8000-0000000000a1', 'Owner')
     on conflict (user_id) do update set display_name = excluded.display_name $$,
  'profile upsert works (A1.3 idempotent upsert shape)');
select lives_ok(
  $$ insert into public.profiles (user_id, display_name)
     values ('00000000-0000-4000-8000-0000000000a1', 'Owner 2')
     on conflict (user_id) do update set display_name = excluded.display_name $$,
  'repeated profile upsert is idempotent');
select throws_ok(
  $$ insert into public.profiles (user_id) values ('00000000-0000-4000-8000-00000000ffff') $$,
  '23503', null, 'profile requires an existing auth user');
select throws_ok(
  $$ update public.profiles set display_name = ''
     where user_id = '00000000-0000-4000-8000-0000000000a1' $$,
  '23514', null, 'empty display_name is rejected');

-- workspaces status -----------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.workspaces (name, owner_id, status)
     values ('bad', '00000000-0000-4000-8000-0000000000a1', 'published') $$,
  '23514', null, 'unknown workspace status is rejected');
select throws_ok(
  $$ insert into public.workspaces (name, owner_id) values ('   ', '00000000-0000-4000-8000-0000000000a1') $$,
  '23514', null, 'blank workspace name is rejected');
select throws_ok(
  $$ update public.workspaces set status = 'archived'
     where id = '10000000-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'archived without archived_at is rejected');
select throws_ok(
  $$ update public.workspaces set archived_at = now()
     where id = '10000000-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'active workspace cannot carry archived_at');
select lives_ok(
  $$ update public.workspaces set status = 'archived', archived_at = now()
     where id = '10000000-0000-4000-8000-0000000000b1' $$,
  'archive sets status and archived_at together');
select throws_ok(
  $$ update public.workspaces set deleted_at = now()
     where id = '10000000-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'archived workspace cannot carry deleted_at without status deleted');
select lives_ok(
  $$ update public.workspaces set status = 'active', archived_at = null
     where id = '10000000-0000-4000-8000-0000000000b1' $$,
  'restore clears archived_at');
select throws_ok(
  $$ update public.workspaces set status = 'deleted'
     where id = '10000000-0000-4000-8000-0000000000b2' $$,
  '23514', null, 'deleted without deleted_at is rejected');
select lives_ok(
  $$ update public.workspaces set status = 'deleted', deleted_at = now()
     where id = '10000000-0000-4000-8000-0000000000b2' $$,
  'soft delete sets status and deleted_at together');

-- updated_at trigger ----------------------------------------------------------------------------
update public.workspaces set updated_at = '2000-01-01T00:00:00Z'
 where id = '10000000-0000-4000-8000-0000000000b1';
select is(
  (select updated_at from public.workspaces where id = '10000000-0000-4000-8000-0000000000b1'),
  now(), 'updated_at is refreshed by the trigger on every update');

-- memberships -----------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.workspace_memberships (workspace_id, user_id, role) values
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'owner'),
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'editor') $$,
  'owner and editor memberships are accepted');
select throws_ok(
  $$ insert into public.workspace_memberships (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a2', 'admin') $$,
  '23514', null, 'membership role outside owner/editor/viewer is rejected');
select throws_ok(
  $$ insert into public.workspace_memberships (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'viewer') $$,
  '23505', null, 'a user has at most one membership per workspace');
select throws_ok(
  $$ update public.workspace_memberships set role = 'owner'
     where user_id = '00000000-0000-4000-8000-0000000000a2' $$,
  '23505', null, 'a workspace has at most one owner membership');

-- activity_events -------------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.activity_events (workspace_id, event_type, target_type, metadata)
     values ('10000000-0000-4000-8000-0000000000b1', 'workspace.shared', 'workspace',
             '{"token": "abc"}') $$,
  '23514', null, 'activity metadata rejects secret-looking top-level keys');
select throws_ok(
  $$ insert into public.activity_events (workspace_id, event_type, target_type, metadata)
     values ('10000000-0000-4000-8000-0000000000b1', 'workspace.renamed', 'workspace', '[]') $$,
  '23514', null, 'activity metadata must be a JSON object');
select throws_ok(
  $$ insert into public.activity_events (workspace_id, event_type, target_type)
     values ('10000000-0000-4000-8000-0000000000b1', 'Workspace Renamed', 'workspace') $$,
  '23514', null, 'activity event_type must be a dotted lowercase identifier');

-- async_jobs ------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.async_jobs (workspace_id, created_by, job_type, idempotency_key)
     values ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1',
             'document.parse', 'key-1') $$,
  'first job with an idempotency key is accepted');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, created_by, job_type, idempotency_key)
     values ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1',
             'document.parse', 'key-1') $$,
  '23505', null, 'same (workspace, creator, job_type, key) is rejected');
select lives_ok(
  $$ insert into public.async_jobs (workspace_id, created_by, job_type, idempotency_key) values
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2',
      'document.parse', 'key-1'),
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1',
      'document.index', 'key-1'),
     ('10000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1',
      'document.parse', 'key-1') $$,
  'the same key is independent across creators, job types and workspaces');
select lives_ok(
  $$ insert into public.async_jobs (workspace_id, created_by, job_type) values
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'document.parse'),
     ('10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'document.parse') $$,
  'jobs without an idempotency key are never deduplicated');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status)
     values ('10000000-0000-4000-8000-0000000000b1', 'document.parse', 'done') $$,
  '23514', null, 'unknown job status is rejected');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status)
     values ('10000000-0000-4000-8000-0000000000b1', 'document.parse', 'running') $$,
  '23514', null, 'running job requires started_at');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status, started_at)
     values ('10000000-0000-4000-8000-0000000000b1', 'document.parse', 'failed', now()) $$,
  '23514', null, 'terminal job requires finished_at');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, attempts)
     values ('10000000-0000-4000-8000-0000000000b1', 'document.parse', -1) $$,
  '23514', null, 'attempts cannot be negative');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, last_error)
     values ('10000000-0000-4000-8000-0000000000b1', 'document.parse', repeat('x', 2001)) $$,
  '23514', null, 'last_error is bounded');

select * from finish();
rollback;
