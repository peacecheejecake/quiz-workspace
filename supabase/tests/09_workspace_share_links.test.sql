-- S1a: workspace_share_links (shape, digest-only storage, rotation chain, privileges, RLS).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(38);

-- Shape -----------------------------------------------------------------------------------------
select columns_are('public', 'workspace_share_links',
  array['id', 'workspace_id', 'created_by', 'token_digest', 'allow_fork', 'expires_at',
        'revoked_at', 'rotated_from_id', 'created_at', 'updated_at']);
select col_is_pk('public', 'workspace_share_links', array['id'], 'id is the primary key');
select col_type_is('public', 'workspace_share_links', 'token_digest', 'bytea',
  'token_digest is bytea');
select col_not_null('public', 'workspace_share_links', c, format('%s is not null', c))
from unnest(array['workspace_id', 'created_by', 'token_digest', 'allow_fork', 'created_at',
                  'updated_at']) as c;
select col_default_is('public', 'workspace_share_links', 'allow_fork', 'false',
  'fork is off by default');
select fk_ok('public', 'workspace_share_links', 'workspace_id', 'public', 'workspaces', 'id');
select fk_ok('public', 'workspace_share_links', 'created_by', 'auth', 'users', 'id');
select fk_ok('public', 'workspace_share_links', array['workspace_id', 'rotated_from_id'],
  'public', 'workspace_share_links', array['workspace_id', 'id']);
select has_index('public', 'workspace_share_links', 'workspace_share_links_workspace_created_idx',
  'owner listing index');
select has_index('public', 'workspace_share_links', 'workspace_share_links_rotated_from_idx',
  'rotation index');
select has_trigger('public', 'workspace_share_links', 'workspace_share_links_set_updated_at',
  'updated_at trigger');
select hasnt_column('public', 'workspace_share_links', c, format('no %s column', c))
from unnest(array['token', 'secret', 'share_url']) as c;

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000051a1', 's1a-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000051a1', 's1a ws', '00000000-0000-4000-8000-0000000051a1'),
  ('10000000-0000-4000-8000-0000000051a2', 's1a other', '00000000-0000-4000-8000-0000000051a1');

create function pg_temp.link(id text, ws text, digest bytea, rotated text default null)
returns text language sql as $$
  select format(
    'insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, '
    'rotated_from_id) values (%L, %L, %L, %L::bytea, %L)',
    id, ws, '00000000-0000-4000-8000-0000000051a1', digest, rotated)
$$;

-- Checks ----------------------------------------------------------------------------------------
select lives_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a1', '10000000-0000-4000-8000-0000000051a1',
               sha256('\x01'::bytea)),
  'a link with a 32-byte digest is stored');
select is(
  (select (allow_fork, expires_at, revoked_at)::text from public.workspace_share_links
    where id = '20000000-0000-4000-8000-0000000051a1'),
  '(f,,)', 'new links: fork off, no expiry, not revoked');
select throws_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a9', '10000000-0000-4000-8000-0000000051a1',
               '\x01'::bytea),
  '23514', null, 'the digest must be 32 bytes');
select throws_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a9', '10000000-0000-4000-8000-0000000051a1',
               sha256('\x01'::bytea)),
  '23505', null, 'a digest is never reused');
select lives_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a2', '10000000-0000-4000-8000-0000000051a1',
               sha256('\x02'::bytea), '20000000-0000-4000-8000-0000000051a1'),
  'a rotated link names the link it replaced');
select throws_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a3', '10000000-0000-4000-8000-0000000051a1',
               sha256('\x03'::bytea), '20000000-0000-4000-8000-0000000051a1'),
  '23505', null, 'a link is replaced at most once');
select throws_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a4', '10000000-0000-4000-8000-0000000051a2',
               sha256('\x04'::bytea), '20000000-0000-4000-8000-0000000051a2'),
  '23503', null, 'rotation stays inside one workspace');
select throws_ok(
  pg_temp.link('20000000-0000-4000-8000-0000000051a5', '10000000-0000-4000-8000-0000000051a1',
               sha256('\x05'::bytea), '20000000-0000-4000-8000-0000000051a5'),
  '23514', null, 'a link cannot replace itself');
select throws_ok(
  $$ update public.workspace_share_links set revoked_at = created_at - interval '1 second'
      where id = '20000000-0000-4000-8000-0000000051a1' $$,
  '23514', null, 'revoked_at is not before created_at');
select lives_ok(
  $$ update public.workspace_share_links set revoked_at = now()
      where id = '20000000-0000-4000-8000-0000000051a1' $$,
  'a link can be revoked');
select lives_ok(
  $$ update public.workspace_share_links set expires_at = now() - interval '1 minute'
      where id = '20000000-0000-4000-8000-0000000051a2' $$,
  'expiry may lie in the past (an expired link)');

-- Privileges / RLS ------------------------------------------------------------------------------
select table_privs_are('public', 'workspace_share_links', r, array[]::text[],
  format('%s has no privileges on workspace_share_links', r))
from unnest(array['anon', 'authenticated']) as r;
select table_privs_are('public', 'workspace_share_links', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'workspace_share_links', 'quiz_worker', array[]::text[],
  'quiz_worker has no privileges on workspace_share_links (S3a adds them)');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.workspace_share_links'::regclass),
  'RLS is enabled on workspace_share_links');

grant quiz_api to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select is(
  (select count(*)::int from public.workspace_share_links
    where workspace_id = '10000000-0000-4000-8000-0000000051a1'),
  2, 'quiz_api reads links through its policy');
select throws_ok(
  $$ delete from public.workspace_share_links $$, '42501', null, 'quiz_api cannot delete links');
reset role;

-- Cascades --------------------------------------------------------------------------------------
delete from public.workspaces where id = '10000000-0000-4000-8000-0000000051a1';
select is(
  (select count(*)::int from public.workspace_share_links
    where workspace_id = '10000000-0000-4000-8000-0000000051a1'),
  0, 'a hard-deleted workspace takes its links (and their rotation chain) with it');

select * from finish();
rollback;
