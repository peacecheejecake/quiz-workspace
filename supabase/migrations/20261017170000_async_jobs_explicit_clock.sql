-- P0.7b fix: explicit signal for caller-written async_jobs.updated_at.
--
-- 20261017150000 kept an explicitly written updated_at only when it differed from the old
-- value. Two consecutive transitions computed from the same clock reading (e.g. create, then
-- request_cancel at the same frozen instant) write an unchanged updated_at, which the trigger
-- then replaced with now(): the persisted row no longer matched the record the store returned,
-- and the reconciler's updated_at comparison saw a different time than the worker.
--
-- Instead of inferring intent from the value, a writer that owns the clock says so: inside its
-- transaction it runs
--     select pg_catalog.set_config('quiz.explicit_updated_at', 'on', true)   -- transaction-local
-- and the trigger then keeps whatever updated_at the UPDATE wrote. Every other update (the API,
-- ad-hoc SQL) gets now() as before. The worker's PostgresJobStore sets it in every transaction.
-- Setting a custom `quiz.*` parameter needs no privilege, and it only lets a writer choose the
-- updated_at of rows it is already allowed to update.

create or replace function public.async_jobs_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.current_setting('quiz.explicit_updated_at', true), '') <> 'on'
  then
    new.updated_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

revoke all on function public.async_jobs_set_updated_at() from public, anon, authenticated;
