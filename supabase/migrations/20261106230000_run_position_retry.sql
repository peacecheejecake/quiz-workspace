-- UX12 MOCKUX-15 (docs/screens/ux12-retry-in-place.md): `다시 풀기` in a run reopens the position.
--
-- A session's run link never changes (`*_run_immutable`), so the graded session stays linked and
-- gets `superseded_at`; the position's live session is the one without it. Attempts are untouched.
-- Additive: one nullable column per table. The unique indexes narrow to the live sessions, and
-- every row so far is live, so the new indexes hold whatever the old ones held.

alter table public.practice_sessions
  add column superseded_at timestamptz,
  add constraint practice_sessions_superseded_in_run
    check (superseded_at is null or practice_run_id is not null) not valid;
alter table public.practice_sessions validate constraint practice_sessions_superseded_in_run;

alter table public.mock_exam_practice_sessions
  add column superseded_at timestamptz,
  add constraint mock_exam_practice_sessions_superseded_in_run
    check (superseded_at is null or practice_run_id is not null) not valid;
alter table public.mock_exam_practice_sessions
  validate constraint mock_exam_practice_sessions_superseded_in_run;

create unique index practice_sessions_run_position_live_key
  on public.practice_sessions (practice_run_id, run_position)
  where practice_run_id is not null and superseded_at is null;
drop index public.practice_sessions_run_position_key;

create unique index mock_exam_practice_sessions_run_position_live_key
  on public.mock_exam_practice_sessions (practice_run_id, run_position)
  where practice_run_id is not null and superseded_at is null;
drop index public.mock_exam_practice_sessions_run_position_key;

-- Only a graded session is superseded, once.
create function public.run_session_check_superseded()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.superseded_at is not null then
    raise exception 'session % was superseded already', old.id
      using errcode = '23514', constraint = 'run_session_superseded_once';
  end if;
  if new.superseded_at is not null and old.state <> 'graded' then
    raise exception 'session % is not graded', old.id
      using errcode = '23514', constraint = 'run_session_superseded_graded';
  end if;
  return new;
end
$$;

comment on function public.run_session_check_superseded() is
  'UX12-RETRYINPLACE trigger: superseded_at is set once, on a graded run session.';

create trigger practice_sessions_check_superseded
  before update of superseded_at on public.practice_sessions
  for each row when (new.superseded_at is distinct from old.superseded_at)
  execute function public.run_session_check_superseded();

create trigger mock_exam_practice_sessions_check_superseded
  before update of superseded_at on public.mock_exam_practice_sessions
  for each row when (new.superseded_at is distinct from old.superseded_at)
  execute function public.run_session_check_superseded();

revoke all on function public.run_session_check_superseded()
  from public, anon, authenticated, quiz_api, quiz_worker;
