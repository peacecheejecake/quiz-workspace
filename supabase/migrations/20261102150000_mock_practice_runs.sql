-- MOCK-P: mock exam practice linked to QVIEW practice runs (docs/screens/mock-exams.md
-- MOCK-01-C01/C04/C08, docs/screens/question-viewer.md QVIEW-01-C03/C04, docs/questions.md
-- §11-§12).
--
-- MOCK-B (20261102140000) created mock_exam_practice_sessions with `practice_run_id` /
-- `run_position` but deferred their foreign key until practice runs existed (QVIEW-B,
-- 20261102130000). This migration links them, and links a `source = mock` practice run to the
-- mock exam and the generation (회차) it was started on:
--
-- practice_runs
--   (workspace_id, mock_exam_id) -> mock_exams                 same workspace
--   (mock_exam_id, mock_exam_generation_id) -> mock_exam_generations   of that mock exam
--   a mock run names its generation (the one shown when it started). A later 다시 만들기 or
--   삭제 (soft) never changes the run: it keeps the questions it started with (decision n).
-- mock_exam_practice_sessions
--   (practice_run_id, user_id, workspace_id) -> practice_runs  the run's user and workspace
--   run_position is 1-based like practice_runs / practice_sessions (1..5,000; MOCK-B's
--   placeholder check said 0..4,999 and no row has a run link yet)
--   trigger mock_exam_practice_sessions_check_run: a run-linked session belongs to a mock run
--   and practises the mock exam question at its position; the link never changes.
--
-- Mostly additive: two foreign keys and one check on practice_runs, one foreign key, one trigger
-- (function) on mock_exam_practice_sessions, and the replacement of MOCK-B's run-link check on
-- mock_exam_practice_sessions (written by nothing yet). Constraints are added NOT VALID and then
-- validated. Grants are unchanged (quiz_api already reads practice_runs and writes mock
-- practice sessions); the trigger function is callable by nobody.

alter table public.practice_runs
  add constraint practice_runs_mock_exam_fk
    foreign key (workspace_id, mock_exam_id)
    references public.mock_exams (workspace_id, id) on delete cascade not valid,
  add constraint practice_runs_mock_generation_fk
    foreign key (mock_exam_id, mock_exam_generation_id)
    references public.mock_exam_generations (mock_exam_id, id) on delete cascade not valid,
  add constraint practice_runs_mock_generation_required
    check (source <> 'mock' or mock_exam_generation_id is not null) not valid;
alter table public.practice_runs validate constraint practice_runs_mock_exam_fk;
alter table public.practice_runs validate constraint practice_runs_mock_generation_fk;
alter table public.practice_runs validate constraint practice_runs_mock_generation_required;

create index practice_runs_mock_generation_idx
  on public.practice_runs (mock_exam_id, mock_exam_generation_id) where mock_exam_id is not null;

alter table public.mock_exam_practice_sessions
  drop constraint mock_exam_practice_sessions_run_consistent;
alter table public.mock_exam_practice_sessions
  add constraint mock_exam_practice_sessions_run_pair
    check ((practice_run_id is null) = (run_position is null)) not valid,
  add constraint mock_exam_practice_sessions_run_position_range
    check (run_position is null or run_position between 1 and 5000) not valid,
  add constraint mock_exam_practice_sessions_run_fk
    foreign key (practice_run_id, user_id, workspace_id)
    references public.practice_runs (id, user_id, workspace_id) on delete cascade not valid;
alter table public.mock_exam_practice_sessions
  validate constraint mock_exam_practice_sessions_run_pair;
alter table public.mock_exam_practice_sessions
  validate constraint mock_exam_practice_sessions_run_position_range;
alter table public.mock_exam_practice_sessions
  validate constraint mock_exam_practice_sessions_run_fk;

create function public.mock_exam_practice_sessions_check_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.practice_run_id is distinct from old.practice_run_id
       or new.run_position is distinct from old.run_position then
      raise exception 'the run link of mock practice session % never changes', old.id
        using errcode = '23514', constraint = 'mock_exam_practice_sessions_run_immutable';
    end if;
    return new;
  end if;
  if new.practice_run_id is not null and not exists (
    select 1 from public.practice_runs r
     where r.id = new.practice_run_id
       and r.source = 'mock'
       and r.item_ids[new.run_position] = new.mock_exam_question_id
  ) then
    raise exception 'mock practice session % does not practise its run position', new.id
      using errcode = '23514', constraint = 'mock_exam_practice_sessions_run_question';
  end if;
  return new;
end
$$;

comment on function public.mock_exam_practice_sessions_check_run() is
  'MOCK-P trigger: a run-linked mock practice session practises its mock run position; the link '
  'never changes.';

create trigger mock_exam_practice_sessions_check_run
  before insert or update of practice_run_id, run_position
  on public.mock_exam_practice_sessions
  for each row execute function public.mock_exam_practice_sessions_check_run();

revoke all on function public.mock_exam_practice_sessions_check_run()
  from public, anon, authenticated, quiz_api, quiz_worker;
