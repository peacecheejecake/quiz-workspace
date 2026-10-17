-- M3.1a: idempotency_keys replay store (shape, checks, privileges, RLS).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

-- Shape -----------------------------------------------------------------------------------------
select columns_are('public', 'idempotency_keys',
  array['user_id', 'scope', 'key', 'request_hash', 'response_status', 'response_body',
        'created_at', 'expires_at']);
select col_is_pk('public', 'idempotency_keys', array['user_id', 'scope', 'key'],
  'a key is unique per user and operation scope');
select fk_ok('public', 'idempotency_keys', 'user_id', 'auth', 'users', 'id');
select has_index('public', 'idempotency_keys', 'idempotency_keys_expires_at_idx',
  array['expires_at'], 'retention sweep index');
select col_not_null('public', 'idempotency_keys', c, format('%s is not null', c))
from unnest(array['request_hash', 'response_status', 'response_body', 'expires_at']) as c;

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000031a01', 'm31a-idem-a@example.test'),
  ('00000000-0000-4000-8000-000000031a02', 'm31a-idem-b@example.test');

-- Checks ----------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'k-1',
             repeat('a', 64), 201, '{"id": "x"}') $$,
  'a well-formed key is stored');
select ok(
  (select expires_at > created_at from public.idempotency_keys where key = 'k-1'),
  'expires_at defaults to after created_at');
select lives_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a02', 'POST /workspaces', 'k-1',
             repeat('a', 64), 201, '{}') $$,
  'the same key is independent per user');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'k-1',
             repeat('b', 64), 201, '{}') $$,
  '23505', null, 'the same (user, scope, key) cannot be stored twice');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'has space',
             repeat('a', 64), 201, '{}') $$,
  '23514', null, 'keys are visible ASCII only');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', repeat('k', 201),
             repeat('a', 64), 201, '{}') $$,
  '23514', null, 'keys are at most 200 characters');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'k-2',
             'not-a-hash', 201, '{}') $$,
  '23514', null, 'request_hash is a hex SHA-256');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', '', 'k-3', repeat('a', 64), 201, '{}') $$,
  '23514', null, 'scope is not empty');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'k-4',
             repeat('a', 64), 99, '{}') $$,
  '23514', null, 'response_status is an HTTP status');
select throws_ok(
  $$ insert into public.idempotency_keys
       (user_id, scope, key, request_hash, response_status, response_body, created_at,
        expires_at)
     values ('00000000-0000-4000-8000-000000031a01', 'POST /workspaces', 'k-5',
             repeat('a', 64), 201, '{}', now(), now() - interval '1 second') $$,
  '23514', null, 'expires_at is after created_at');

-- Privileges / RLS ------------------------------------------------------------------------------
select table_privs_are('public', 'idempotency_keys', r, array[]::text[],
  format('%s has no privileges on idempotency_keys', r))
from unnest(array['anon', 'authenticated']) as r;
select table_privs_are('public', 'idempotency_keys', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.idempotency_keys'::regclass),
  'RLS is enabled on idempotency_keys');

grant quiz_api to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select is(
  (select count(*)::int from public.idempotency_keys
    where user_id = '00000000-0000-4000-8000-000000031a01'),
  1, 'quiz_api reads stored keys through its policy');
reset role;

select * from finish();
rollback;
