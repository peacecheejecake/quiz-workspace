-- M3.2b review fix: the worker re-checks workspace access before it starts a document job and
-- again inside the transaction that publishes the result.
--
-- A job is enqueued by a user who was allowed to write at that moment; by the time the worker
-- runs (or finishes) the workspace may be archived (read-only), soft-deleted, or the user's
-- membership revoked / downgraded. The job must then not publish anything into the workspace.
--
-- `quiz_worker` gets no privileges on workspaces / workspace_memberships. Locking the rows
-- (FOR SHARE, to serialise with archive/delete/membership changes, which take FOR NO KEY UPDATE
-- in the API's authorization query) would require UPDATE privilege and an UPDATE policy on both
-- tables. Instead this SECURITY DEFINER function answers exactly one question and takes the lock
-- on the caller's behalf; it is executable by quiz_worker only.
--
--   worker_workspace_writable(workspace_id, user_id, lock)
--     true  <=> the workspace is active (not archived, not deleted) and `user_id` is an owner or
--               editor member of it (docs/auth.md §4: document.edit = owner, editor).
--     lock  => FOR SHARE on the workspace and membership rows until the caller's transaction
--              ends, so an archive/delete/membership change either committed before (and is seen
--              here) or waits until the caller committed.
--   A NULL user (system job, or the creator was deleted) is never writable.

create function public.worker_workspace_writable(
  p_workspace_id uuid,
  p_user_id uuid,
  p_lock boolean default false
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  found_status text;
  found_role text;
begin
  if p_workspace_id is null or p_user_id is null then
    return false;
  end if;
  if p_lock then
    select w.status, m.role
      into found_status, found_role
      from public.workspaces w
      join public.workspace_memberships m on m.workspace_id = w.id
     where w.id = p_workspace_id
       and m.user_id = p_user_id
       and w.deleted_at is null
       for share of w, m;
  else
    select w.status, m.role
      into found_status, found_role
      from public.workspaces w
      join public.workspace_memberships m on m.workspace_id = w.id
     where w.id = p_workspace_id
       and m.user_id = p_user_id
       and w.deleted_at is null;
  end if;
  return coalesce(found_status = 'active' and found_role in ('owner', 'editor'), false);
end;
$$;

-- Volatile: it takes row locks (FOR SHARE is not allowed in a stable function).
comment on function public.worker_workspace_writable(uuid, uuid, boolean) is
  'quiz_worker: may a document job of p_user_id still write into p_workspace_id? Optionally locks the rows FOR SHARE.';

revoke all on function public.worker_workspace_writable(uuid, uuid, boolean)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_workspace_writable(uuid, uuid, boolean) to quiz_worker;
