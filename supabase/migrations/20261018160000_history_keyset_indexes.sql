-- M7.1 HISTORY-01: keyset indexes for the workspace history lists (docs/architecture.md §6).
--
--   GET /workspaces/{id}/activities  activity_events_workspace_created_idx (baseline) already
--                                    matches (workspace_id, created_at desc, id desc).
--   GET /workspaces/{id}/jobs        (workspace_id, created_at desc, id desc): the baseline
--                                    async_jobs_workspace_created_idx lacks the `id` tie-breaker
--                                    of the keyset, so equal timestamps would need a sort.
--   GET /workspaces/{id}/attempts    the caller's attempts in one workspace, newest first. The
--                                    M4.1 index is per question (user_id, question_id, ...).
--
-- Additive only (docs/deployment.md §5). The superseded async_jobs_workspace_created_idx is kept
-- for now; dropping it is a later cleanup once nothing else relies on it.

create index async_jobs_workspace_created_id_idx
  on public.async_jobs (workspace_id, created_at desc, id desc);

create index question_attempts_workspace_user_submitted_idx
  on public.question_attempts (workspace_id, user_id, submitted_at desc, id desc);
