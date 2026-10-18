-- P0.7b: align `async_jobs` with the worker's JobStore (apps/worker/src/quiz_worker/store.py)
-- and add the least-privilege `quiz_worker` role. Additive only (docs/deployment.md §5): new
-- nullable/defaulted columns, new checks, new indexes, a new role. Nothing is dropped, and code
-- written against the P0.9 table keeps working.
--
-- Columns (see the store's module docstring for the state machine):
--   max_attempts          attempts the worker may claim before the job fails (lost workers too)
--   cancel_requested_at   cancel flag set by the API; observed by the running attempt / next claim
--   locked_by             worker id of the running attempt
--   lease_expires_at      lease of the running attempt; an expired lease is recovered
--   published_at          last broker hand-off of the current queued state (reconciler input)
--   cleanup_pending       a failed/cancelled job still owes cleanup of attempt artifacts
--   cleanup_attempts      cleanup tries so far; also the fencing token of a cleanup try
--   cleanup_last_error    sanitized error of the last failed cleanup try
--   cleanup_next_at       earliest next cleanup try; doubles as the lease of a try in progress
--
-- Idempotency scope is unchanged from P0.9: (workspace_id, created_by, job_type,
-- idempotency_key), only for rows with both a creator and a key. The worker matches it exactly
-- (the envelope carries `created_by`). Jobs without a creator are not deduplicated by key;
-- they are deduplicated by their (caller-chosen) job id. A unique index that also covered
-- created_by IS NULL would make `on delete set null` of auth.users fail whenever a deleted
-- user's job and a system job (or another deleted user's job) share a key.

-- ---------------------------------------------------------------------------------------------
-- Worker role
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'quiz_worker') then
    create role quiz_worker nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

comment on role quiz_worker is
  'Least-privilege role for the Celery worker. NOLOGIN in migrations; environments grant login out of band.';

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------
alter table public.async_jobs
  add column max_attempts integer not null default 3,
  add column cancel_requested_at timestamptz,
  add column locked_by text,
  add column lease_expires_at timestamptz,
  add column published_at timestamptz,
  add column cleanup_pending boolean not null default false,
  add column cleanup_attempts integer not null default 0,
  add column cleanup_last_error text,
  add column cleanup_next_at timestamptz;

-- A `running` row from before this migration has no lease: treat it as expired right away so
-- the reconciler recovers it, and record a worker id so the new running check holds.
update public.async_jobs
   set lease_expires_at = pg_catalog.now(),
       locked_by = coalesce(locked_by, 'unknown')
 where status = 'running' and (lease_expires_at is null or locked_by is null);

alter table public.async_jobs
  add constraint async_jobs_max_attempts_positive check (max_attempts > 0),
  add constraint async_jobs_cleanup_attempts_non_negative check (cleanup_attempts >= 0),
  add constraint async_jobs_locked_by_length
    check (locked_by is null or char_length(locked_by) between 1 and 200),
  add constraint async_jobs_cleanup_last_error_length
    check (cleanup_last_error is null or char_length(cleanup_last_error) <= 500),
  -- A running attempt always holds a lease (otherwise nothing could ever recover it).
  add constraint async_jobs_running_leased
    check (status <> 'running' or (lease_expires_at is not null and locked_by is not null)),
  -- Cleanup is only ever owed by a failed or cancelled job.
  add constraint async_jobs_cleanup_terminal
    check (not cleanup_pending or status in ('failed', 'cancelled')),
  add constraint async_jobs_cleanup_next_pending
    check (cleanup_pending or cleanup_next_at is null);

-- ---------------------------------------------------------------------------------------------
-- Reconciler / cleanup scans (all bounded with LIMIT by the worker)
-- ---------------------------------------------------------------------------------------------
-- find_expired_leases: status = 'running' and lease_expires_at <= now.
create index async_jobs_status_lease_idx on public.async_jobs (status, lease_expires_at);
-- find_republish_candidates: status = 'queued' and published_at is null / older than a cutoff.
create index async_jobs_status_published_idx on public.async_jobs (status, published_at);
-- find_pending_cleanups: cleanup_pending and cleanup_next_at <= now.
create index async_jobs_cleanup_due_idx
  on public.async_jobs (cleanup_next_at)
  where cleanup_pending;

-- ---------------------------------------------------------------------------------------------
-- updated_at: the worker computes every transition (including updated_at) from one clock, and
-- the reconciler compares updated_at with that clock. Keep an explicitly written value; any
-- other update still gets now(). Same trigger name, so callers see no difference.
-- ---------------------------------------------------------------------------------------------
create function public.async_jobs_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

revoke all on function public.async_jobs_set_updated_at() from public, anon, authenticated;

drop trigger async_jobs_set_updated_at on public.async_jobs;
create trigger async_jobs_set_updated_at
  before update on public.async_jobs
  for each row execute function public.async_jobs_set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges. quiz_api keeps its table-level grants (they cover the new columns).
-- quiz_worker: read jobs, insert jobs (follow-up jobs; the JobStore `create`), and update only
-- the state columns. It can never rewrite a job's identity (workspace, creator, type, key,
-- schema version, payload), delete rows, or touch any other table. Later Tasks (M3.2b) grant
-- what their jobs need in their own migrations.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.async_jobs from quiz_worker;

grant usage on schema public to quiz_worker;
grant select, insert on public.async_jobs to quiz_worker;
grant update (
  status, attempts, result, last_error, started_at, finished_at, updated_at,
  cancel_requested_at, locked_by, lease_expires_at, published_at,
  cleanup_pending, cleanup_attempts, cleanup_last_error, cleanup_next_at
) on public.async_jobs to quiz_worker;

create policy quiz_worker_select on public.async_jobs
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.async_jobs
  for insert to quiz_worker with check (true);
create policy quiz_worker_update on public.async_jobs
  for update to quiz_worker using (true) with check (true);

-- ---------------------------------------------------------------------------------------------
-- Worker connection (development only, never committed with a password):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -c "alter role quiz_worker with login password '<local-only password>'"
--   WORKER_DATABASE_URL=postgresql://quiz_worker:<local-only password>@127.0.0.1:54322/postgres
-- ---------------------------------------------------------------------------------------------
