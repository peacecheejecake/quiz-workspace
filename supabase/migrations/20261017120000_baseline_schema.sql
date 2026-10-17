-- P0.9 baseline schema: profiles, workspaces, workspace_memberships, activity_events, async_jobs.
--
-- Security model (docs/auth.md §4):
--   * FastAPI is the authorization boundary. The browser never talks to the Data API, so `anon`
--     and `authenticated` get no table privileges and no RLS policies on anything in `public`.
--   * RLS is enabled on every table as defence in depth. The only policies target `quiz_api`, the
--     low-privilege role the API connects as; it gets exactly the grants listed at the bottom.
--   * `quiz_api` is created NOLOGIN. Login + password are environment configuration and are never
--     committed (local: see the "Local API connection" note at the end of this file).
--   * Nothing here touches the `auth` schema beyond foreign keys to `auth.users(id)`.

-- ---------------------------------------------------------------------------------------------
-- Default privileges: tables/sequences/functions that later migrations create in `public` must not
-- be reachable by the Data API roles unless a migration grants that on purpose.
-- ---------------------------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; that default can only be
-- revoked globally (not per schema).
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------
-- API role
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'quiz_api') then
    create role quiz_api nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

comment on role quiz_api is
  'Least-privilege role for the FastAPI service. NOLOGIN in migrations; environments grant login out of band.';

-- ---------------------------------------------------------------------------------------------
-- Shared trigger function
-- ---------------------------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- profiles: 1:1 with auth.users. Created/updated by the API with an idempotent upsert (A1.3);
-- there is intentionally no trigger on auth.users.
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 100)
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- workspaces
--   status    | archived_at | deleted_at
--   active    | null        | null
--   archived  | not null    | null
--   deleted   | any         | not null   (soft delete; archived_at kept if it was archived first)
-- Archived = read-only, deleted = no access; both enforced by the API (A1.3).
-- ---------------------------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users (id) on delete restrict,
  status text not null default 'active',
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_length
    check (btrim(name) <> '' and char_length(name) <= 200),
  constraint workspaces_status_valid
    check (status in ('active', 'archived', 'deleted')),
  constraint workspaces_status_timestamps check (
    (status = 'active' and archived_at is null and deleted_at is null)
    or (status = 'archived' and archived_at is not null and deleted_at is null)
    or (status = 'deleted' and deleted_at is not null)
  )
);

create index workspaces_owner_id_idx on public.workspaces (owner_id);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- workspace_memberships: the authorization source of truth (owner/editor/viewer).
-- ---------------------------------------------------------------------------------------------
create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_memberships_role_valid
    check (role in ('owner', 'editor', 'viewer'))
);

-- "My workspaces" lookups.
create index workspace_memberships_user_id_idx on public.workspace_memberships (user_id);
-- A workspace has a single owner (mirrors workspaces.owner_id).
create unique index workspace_memberships_one_owner_idx
  on public.workspace_memberships (workspace_id)
  where role = 'owner';

create trigger workspace_memberships_set_updated_at
  before update on public.workspace_memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- activity_events: append-only, workspace-scoped audit log. `metadata` must never carry secrets
-- (tokens, passwords, signed URLs, raw book text); the check below is a coarse guard on
-- top-level keys, the API is responsible for what it writes.
-- ---------------------------------------------------------------------------------------------
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint activity_events_event_type_format
    check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(event_type) <= 100),
  constraint activity_events_target_type_format
    check (target_type ~ '^[a-z][a-z0-9_]*$' and char_length(target_type) <= 50),
  constraint activity_events_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint activity_events_metadata_size
    check (pg_column_size(metadata) <= 8192),
  constraint activity_events_metadata_no_secret_keys check (
    not (metadata ?| array[
      'password', 'token', 'access_token', 'refresh_token', 'id_token', 'jwt', 'secret',
      'share_token', 'share_secret', 'signed_url', 'authorization', 'cookie'
    ])
  )
);

-- Activity feed: GET /workspaces/{id}/activities, newest first, keyset pagination.
create index activity_events_workspace_created_idx
  on public.activity_events (workspace_id, created_at desc, id desc);
create index activity_events_actor_id_idx on public.activity_events (actor_id);

-- ---------------------------------------------------------------------------------------------
-- async_jobs: durable state for Celery jobs (apps/worker JobStore, P0.7).
--   status: queued -> running -> succeeded | failed | cancelled (a retry goes back to queued).
--   Terminal states require finished_at; non-terminal states require it to be null.
-- Idempotency: a client key is scoped to (workspace_id, created_by, job_type), so two users can
-- never collide on (or probe) each other's keys and one key can be reused for different job
-- types or workspaces. Jobs without a creator (system jobs) are not deduplicated by the DB.
-- ---------------------------------------------------------------------------------------------
create table public.async_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  job_type text not null,
  schema_version integer not null default 1,
  status text not null default 'queued',
  attempts integer not null default 0,
  idempotency_key text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint async_jobs_job_type_format
    check (job_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(job_type) <= 100),
  constraint async_jobs_schema_version_positive check (schema_version >= 1),
  constraint async_jobs_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint async_jobs_attempts_non_negative check (attempts >= 0),
  constraint async_jobs_idempotency_key_length
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 200),
  constraint async_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint async_jobs_last_error_length
    check (last_error is null or char_length(last_error) <= 2000),
  constraint async_jobs_running_started check (status <> 'running' or started_at is not null),
  constraint async_jobs_finished_iff_terminal check (
    (status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)
  )
);

create unique index async_jobs_idempotency_idx
  on public.async_jobs (workspace_id, created_by, job_type, idempotency_key)
  where idempotency_key is not null;
create index async_jobs_workspace_created_idx
  on public.async_jobs (workspace_id, created_at desc);
create index async_jobs_created_by_idx on public.async_jobs (created_by);
-- Worker sweeps (stuck/queued jobs).
create index async_jobs_active_idx
  on public.async_jobs (status, updated_at)
  where status in ('queued', 'running');

create trigger async_jobs_set_updated_at
  before update on public.async_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges. Supabase's default privileges granted these tables to anon/authenticated at
-- creation time; take that back explicitly.
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.profiles,
  public.workspaces,
  public.workspace_memberships,
  public.activity_events,
  public.async_jobs
from anon, authenticated;

grant usage on schema public to quiz_api;

grant select, insert, update on public.profiles to quiz_api;
-- Soft delete is an UPDATE; hard deletes are not part of the API surface.
grant select, insert, update on public.workspaces to quiz_api;
grant select, insert, update, delete on public.workspace_memberships to quiz_api;
-- Append-only.
grant select, insert on public.activity_events to quiz_api;
grant select, insert, update on public.async_jobs to quiz_api;

-- ---------------------------------------------------------------------------------------------
-- Row level security: enabled everywhere; policies exist only for quiz_api. No policy targets
-- anon/authenticated, so even an accidental GRANT exposes zero rows through the Data API.
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.activity_events enable row level security;
alter table public.async_jobs enable row level security;

create policy quiz_api_all on public.profiles
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.workspaces
  for all to quiz_api using (true) with check (true);
create policy quiz_api_all on public.workspace_memberships
  for all to quiz_api using (true) with check (true);
create policy quiz_api_select on public.activity_events
  for select to quiz_api using (true);
create policy quiz_api_insert on public.activity_events
  for insert to quiz_api with check (true);
create policy quiz_api_all on public.async_jobs
  for all to quiz_api using (true) with check (true);

-- ---------------------------------------------------------------------------------------------
-- Local API connection (development only, never committed with a password):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -c "alter role quiz_api with login password '<local-only password>'"
--   DATABASE_URL=postgresql://quiz_api:<local-only password>@127.0.0.1:54322/postgres
-- `supabase db reset` re-runs migrations; roles are cluster-wide, so re-run the ALTER if a reset
-- recreated the database container.
-- ---------------------------------------------------------------------------------------------
