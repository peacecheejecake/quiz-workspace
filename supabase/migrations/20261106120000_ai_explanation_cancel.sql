-- UX12 EXPL-3: cancelling an AI explanation (POST …/ai-explanation/cancel,
-- docs/screens/ux12-expl-cancel.md).
--
-- Additive only: quiz_api gains the one write it needs, the pattern of ask's `quiz_api_update`
-- (20261104100000_ask.sql). The API checks the caller first (the requester or an owner/editor of
-- an active workspace); the policy bounds the write itself: an unfinished row becomes a failed one
-- with `error_code = 'cancelled'`. Anything else stays the worker's, and a finished row is out of
-- reach. A cancelled row needs no other change: the status and error checks already allow it, and
-- failed rows block nothing, so a cancelled regeneration leaves the previous success current.
grant update (status, error_code, started_at, finished_at, updated_at)
  on public.question_ai_explanations to quiz_api;
grant update (status, error_code, started_at, finished_at, updated_at)
  on public.mock_exam_question_ai_explanations to quiz_api;

create policy quiz_api_update on public.question_ai_explanations
  for update to quiz_api
  using (status in ('queued', 'running'))
  with check (status = 'failed' and error_code = 'cancelled' and finished_at is not null);
create policy quiz_api_update on public.mock_exam_question_ai_explanations
  for update to quiz_api
  using (status in ('queued', 'running'))
  with check (status = 'failed' and error_code = 'cancelled' and finished_at is not null);
