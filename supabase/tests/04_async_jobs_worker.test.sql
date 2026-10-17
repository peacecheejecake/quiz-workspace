-- P0.7b: async_jobs lease/cleanup columns, checks, scan indexes, updated_at trigger and the
-- least-privilege quiz_worker role.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(58);

-- Columns and defaults --------------------------------------------------------------------------
select col_not_null('public', 'async_jobs', 'max_attempts', 'max_attempts is not null');
select col_default_is('public', 'async_jobs', 'max_attempts', 3, 'max_attempts defaults to 3');
select col_not_null('public', 'async_jobs', 'cleanup_pending', 'cleanup_pending is not null');
select col_default_is('public', 'async_jobs', 'cleanup_pending', false,
  'cleanup_pending defaults to false');
select col_not_null('public', 'async_jobs', 'cleanup_attempts', 'cleanup_attempts is not null');
select col_default_is('public', 'async_jobs', 'cleanup_attempts', 0,
  'cleanup_attempts defaults to 0');
select col_type_is('public', 'async_jobs', c, 'timestamp with time zone',
  format('%s is timestamptz', c))
from unnest(array['cancel_requested_at', 'lease_expires_at', 'published_at',
                  'cleanup_next_at']) as c;
select col_is_null('public', 'async_jobs', c, format('%s is nullable', c))
from unnest(array['cancel_requested_at', 'locked_by', 'lease_expires_at', 'published_at',
                  'cleanup_last_error', 'cleanup_next_at']) as c;

-- Indexes ---------------------------------------------------------------------------------------
select has_index('public', 'async_jobs', 'async_jobs_status_lease_idx',
  array['status', 'lease_expires_at'], 'expired-lease scan index');
select has_index('public', 'async_jobs', 'async_jobs_status_published_idx',
  array['status', 'published_at'], 'republish scan index');
select has_index('public', 'async_jobs', 'async_jobs_cleanup_due_idx', array['cleanup_next_at'],
  'pending-cleanup scan index');
select is(
  (select pg_get_expr(i.indpred, i.indrelid) from pg_index i
    where i.indexrelid = 'public.async_jobs_cleanup_due_idx'::regclass),
  'cleanup_pending',
  'pending-cleanup index is partial on cleanup_pending');
select index_is_unique('public', 'async_jobs', 'async_jobs_idempotency_idx');

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000007b1', 'p07b-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000007b1', 'p07b ws', '00000000-0000-4000-8000-0000000007b1');

-- Checks ----------------------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, max_attempts)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 0) $$,
  '23514', null, 'max_attempts must be positive');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, cleanup_attempts)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', -1) $$,
  '23514', null, 'cleanup_attempts cannot be negative');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status, started_at)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'running', now()) $$,
  '23514', null, 'running job requires a lease');
select throws_ok(
  $$ insert into public.async_jobs
       (workspace_id, job_type, status, started_at, lease_expires_at)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'running', now(),
             now() + interval '1 hour') $$,
  '23514', null, 'running job requires locked_by');
select lives_ok(
  $$ insert into public.async_jobs
       (id, workspace_id, job_type, status, attempts, started_at, locked_by, lease_expires_at)
     values ('20000000-0000-4000-8000-0000000007b1', '10000000-0000-4000-8000-0000000007b1',
             'document.parse', 'running', 1, now(), 'worker@host', now() + interval '1 hour') $$,
  'a leased running job is accepted');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, locked_by)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', repeat('w', 201)) $$,
  '23514', null, 'locked_by is bounded');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, cleanup_pending)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', true) $$,
  '23514', null, 'a queued job cannot owe cleanup');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status, finished_at, cleanup_pending)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'succeeded', now(), true) $$,
  '23514', null, 'a succeeded job cannot owe cleanup');
select lives_ok(
  $$ insert into public.async_jobs
       (workspace_id, job_type, status, finished_at, cleanup_pending, cleanup_next_at)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'failed', now(), true,
             now()), ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'cancelled',
             now(), true, null) $$,
  'failed and cancelled jobs can owe cleanup');
select throws_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, status, finished_at, cleanup_next_at)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'failed', now(), now()) $$,
  '23514', null, 'cleanup_next_at requires a pending cleanup');
select throws_ok(
  $$ insert into public.async_jobs
       (workspace_id, job_type, status, finished_at, cleanup_pending, cleanup_last_error)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.parse', 'failed', now(), true,
             repeat('x', 501)) $$,
  '23514', null, 'cleanup_last_error is bounded');

-- updated_at trigger (20261017170000): now() unless the writer signals its own clock -----------
-- Without the signal an explicitly written value is replaced, and so is an untouched one.
update public.async_jobs set updated_at = '2001-02-03 04:05:06+00', locked_by = 'w2'
 where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  now(),
  'without the signal an explicit updated_at is replaced by now()');
update public.async_jobs set locked_by = 'w3' where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  now(),
  'an update without updated_at stamps now()');
set local quiz.explicit_updated_at = 'off';
update public.async_jobs set updated_at = '2001-02-03 04:05:06+00'
 where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  now(),
  'a signal value other than on is ignored');

-- With the signal the written value is kept, also when it equals the old value (two
-- transitions computed from one clock reading: the case the 20261017150000 trigger got wrong).
set local quiz.explicit_updated_at = 'on';
update public.async_jobs set updated_at = '2001-02-03 04:05:06+00', locked_by = 'w4'
 where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  '2001-02-03 04:05:06+00'::timestamptz,
  'with the signal an explicit updated_at is kept');
update public.async_jobs set updated_at = '2001-02-03 04:05:06+00', locked_by = 'w5'
 where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  '2001-02-03 04:05:06+00'::timestamptz,
  'with the signal an explicit updated_at equal to the old value is kept');
set local quiz.explicit_updated_at = '';

-- Privileges ------------------------------------------------------------------------------------
select table_privs_are('public', 'async_jobs', 'quiz_worker', array['SELECT', 'INSERT'],
  'quiz_worker has table-level SELECT and INSERT on async_jobs only');
select table_privs_are('public', t, 'quiz_worker', array[]::text[],
  format('quiz_worker has no privileges on %s', t))
from unnest(array['profiles', 'workspaces', 'workspace_memberships', 'activity_events']) as t;
select is(
  (select array_agg(column_name::text order by column_name::text)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'async_jobs' and grantee = 'quiz_worker'
      and privilege_type = 'UPDATE'),
  array['attempts', 'cancel_requested_at', 'cleanup_attempts', 'cleanup_last_error',
        'cleanup_next_at', 'cleanup_pending', 'finished_at', 'last_error', 'lease_expires_at',
        'locked_by', 'published_at', 'result', 'started_at', 'status', 'updated_at'],
  'quiz_worker may update only the job state columns');
select is(
  (select row(rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit)::text
     from pg_roles where rolname = 'quiz_worker'),
  row(false, false, false, false, false, false)::text,
  'quiz_worker is not superuser/replication, cannot bypass RLS, create roles/databases, or inherit'
);
select function_privs_are('public', 'async_jobs_set_updated_at', array[]::text[], r,
  array[]::text[], format('%s cannot execute async_jobs_set_updated_at', r))
from unnest(array['anon', 'authenticated']) as r;
select is(
  (select string_agg(format('%s.%s:%s', tablename, policyname, cmd), ',' order by policyname)
     from pg_policies
    where schemaname = 'public' and 'quiz_worker' = any(roles)),
  'async_jobs.quiz_worker_insert:INSERT,async_jobs.quiz_worker_select:SELECT,'
    || 'async_jobs.quiz_worker_update:UPDATE',
  'quiz_worker policies exist on async_jobs only');

-- quiz_worker works within its grants -----------------------------------------------------------
grant quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select results_eq(
  $$ select count(*)::int from public.async_jobs
      where workspace_id = '10000000-0000-4000-8000-0000000007b1' $$,
  $$ values (3) $$, 'quiz_worker can read jobs through its RLS policy');
select lives_ok(
  $$ select id from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'
     for update $$,
  'quiz_worker can lock a job row (SELECT ... FOR UPDATE)');
select lives_ok(
  $$ update public.async_jobs
        set status = 'succeeded', finished_at = now(), locked_by = null,
            lease_expires_at = null, result = '{"ok": true}'
      where id = '20000000-0000-4000-8000-0000000007b1' $$,
  'quiz_worker can update job state');
select lives_ok(
  $$ insert into public.async_jobs (workspace_id, job_type, idempotency_key, max_attempts)
     values ('10000000-0000-4000-8000-0000000007b1', 'document.index', 'follow-up-1', 5) $$,
  'quiz_worker can create a follow-up job');
select lives_ok(
  $$ select pg_catalog.set_config('quiz.explicit_updated_at', 'on', true) $$,
  'quiz_worker can set the explicit clock signal');
update public.async_jobs set updated_at = '2002-03-04 05:06:07+00'
 where id = '20000000-0000-4000-8000-0000000007b1';
select is(
  (select updated_at from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1'),
  '2002-03-04 05:06:07+00'::timestamptz,
  'quiz_worker transitions keep their own updated_at under the signal');
select throws_ok(
  $$ update public.async_jobs set payload = '{"x": 1}'
      where id = '20000000-0000-4000-8000-0000000007b1' $$,
  '42501', null, 'quiz_worker cannot rewrite a job payload');
select throws_ok(
  $$ update public.async_jobs set workspace_id = workspace_id
      where id = '20000000-0000-4000-8000-0000000007b1' $$,
  '42501', null, 'quiz_worker cannot move a job to another workspace');
select throws_ok(
  $$ delete from public.async_jobs where id = '20000000-0000-4000-8000-0000000007b1' $$,
  '42501', null, 'quiz_worker cannot delete jobs');
select throws_ok($$ select * from public.workspaces $$, '42501', null,
  'quiz_worker cannot read workspaces');
select throws_ok($$ select * from auth.users $$, '42501', null,
  'quiz_worker cannot read auth.users');
reset role;

select * from finish();
rollback;
