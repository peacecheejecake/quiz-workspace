-- UX12 MOCKUX-7 (docs/screens/ux12-run-resume.md): `지우기` takes a run out of the `이어 풀기` list
-- without touching the run. Additive: a nullable timestamp, the column grant it needs and a partial
-- index for the list. practice_runs_guard keeps every other column immutable; finishing a run
-- stays a separate thing because it would freeze the positions not yet answered as skipped.
alter table public.practice_runs add column resume_dismissed_at timestamptz;

comment on column public.practice_runs.resume_dismissed_at is
  'When its owner removed the run from the 이어 풀기 list; the run, sessions and attempts stay.';

create index practice_runs_resume_idx
  on public.practice_runs (user_id, workspace_id)
  where source = 'bank' and finished_at is null and resume_dismissed_at is null;

grant update (resume_dismissed_at) on public.practice_runs to quiz_api;
