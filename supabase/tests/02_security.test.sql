-- P0.9: RLS everywhere, no Data API access for anon/authenticated, least-privilege quiz_api.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

-- RLS -------------------------------------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'RLS is enabled on every table in public'
);

select is_empty(
  $$ select tablename, policyname, roles from pg_policies
      where schemaname = 'public'
        and roles && array['anon', 'authenticated', 'public']::name[] $$,
  'no RLS policy targets anon, authenticated or public'
);

select is_empty(
  $$ select tablename, policyname, roles from pg_policies
      where schemaname = 'public' and roles <> array['quiz_api']::name[]
        and not (tablename in ('async_jobs', 'documents', 'document_revisions', 'chapters',
                               'content_blocks', 'document_uploads', 'question_import_runs',
                               'question_drafts')
                 and roles = array['quiz_worker']::name[]) $$,
  'every policy in public targets quiz_api only (plus quiz_worker on async_jobs, P0.7b, and the '
    || 'document tables, M3.2a, and the import runs/drafts, M4.4a)'
);

-- Table privileges ------------------------------------------------------------------------------
select table_privs_are('public', t, r, array[]::text[],
  format('%s has no privileges on %s', r, t))
from unnest(array['profiles', 'workspaces', 'workspace_memberships', 'activity_events',
                  'async_jobs']) as t,
     unnest(array['anon', 'authenticated']) as r;

select table_privs_are('public', 'profiles', 'quiz_api', array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'workspaces', 'quiz_api', array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'workspace_memberships', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
select table_privs_are('public', 'activity_events', 'quiz_api', array['SELECT', 'INSERT']);
select table_privs_are('public', 'async_jobs', 'quiz_api', array['SELECT', 'INSERT', 'UPDATE']);

select function_privs_are('public', 'set_updated_at', array[]::text[], 'anon', array[]::text[]);
select function_privs_are('public', 'set_updated_at', array[]::text[], 'authenticated',
  array[]::text[]);

-- quiz_api role attributes ----------------------------------------------------------------------
-- rolcanlogin is deliberately not asserted: the migration creates the role NOLOGIN, but local
-- setup grants LOGIN out of band and roles are cluster-wide (they survive `db reset`).
select is(
  (select row(rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit)::text
     from pg_roles where rolname = 'quiz_api'),
  row(false, false, false, false, false, false)::text,
  'quiz_api is not superuser/replication, cannot bypass RLS, create roles/databases, or inherit'
);

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000001', 'p09-sec-owner@example.test');
insert into public.workspaces (id, name, owner_id)
values ('10000000-0000-4000-8000-000000000001', 'sec ws', '00000000-0000-4000-8000-000000000001');

-- anon / authenticated are denied by privileges -------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.workspaces $$, '42501', null,
  'anon cannot select workspaces');
select throws_ok(
  $$ insert into public.workspaces (name, owner_id)
     values ('x', '00000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'anon cannot insert workspaces');
select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot select profiles');
select throws_ok($$ select * from public.async_jobs $$, '42501', null,
  'anon cannot select async_jobs');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok($$ select * from public.workspaces $$, '42501', null,
  'authenticated cannot select workspaces');
select throws_ok(
  $$ insert into public.workspaces (name, owner_id)
     values ('x', '00000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'authenticated cannot insert workspaces');
select throws_ok($$ select * from public.workspace_memberships $$, '42501', null,
  'authenticated cannot select workspace_memberships');
select throws_ok($$ select * from public.activity_events $$, '42501', null,
  'authenticated cannot select activity_events');
reset role;

-- Defence in depth: even an accidental GRANT exposes nothing because no policy matches. ----------
grant select, insert on public.workspaces to authenticated;
set local role authenticated;
select is_empty($$ select * from public.workspaces $$,
  'RLS hides rows from authenticated even with a stray SELECT grant');
select throws_ok(
  $$ insert into public.workspaces (name, owner_id)
     values ('x', '00000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'RLS rejects inserts from authenticated even with a stray INSERT grant');
reset role;

-- Future tables in public do not inherit anon/authenticated grants ------------------------------
create table public.p09_future_probe (id int);
select table_privs_are('public', 'p09_future_probe', 'anon', array[]::text[],
  'new public tables grant nothing to anon by default');
select table_privs_are('public', 'p09_future_probe', 'authenticated', array[]::text[],
  'new public tables grant nothing to authenticated by default');
drop table public.p09_future_probe;

-- quiz_api can work within its grants ---------------------------------------------------------
grant quiz_api to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api;
set local role quiz_api;
-- Scoped to the fixture row: the shared local DB may hold committed rows of concurrent
-- integration tests.
select results_eq(
  $$ select name from public.workspaces where id = '10000000-0000-4000-8000-000000000001' $$::text,
  $$ values ('sec ws'::text) $$::text,
  'quiz_api can read workspaces through its RLS policy');
select lives_ok(
  $$ insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
             'workspace.created', 'workspace', '10000000-0000-4000-8000-000000000001') $$,
  'quiz_api can append activity events');
select throws_ok($$ update public.activity_events set event_type = 'workspace.renamed' $$,
  '42501', null, 'quiz_api cannot rewrite activity events');
select throws_ok($$ delete from public.activity_events $$, '42501', null,
  'quiz_api cannot delete activity events');
select throws_ok($$ delete from public.workspaces $$, '42501', null,
  'quiz_api cannot hard-delete workspaces');
select throws_ok($$ select * from auth.users $$, '42501', null, 'quiz_api cannot read auth.users');
reset role;

select * from finish();
rollback;
