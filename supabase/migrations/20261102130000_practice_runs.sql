-- QVIEW-B: range practice runs (docs/screens/question-viewer.md QVIEW-01-C01~C05/C07,
-- docs/questions.md §12, docs/architecture.md §5 `practice_runs`).
--
-- A practice run is one user's fixed, ordered list of questions resolved server-side from a
-- range (POST /workspaces/{id}/practice-runs). The run is practised one position at a time
-- through the existing practice sessions, which now carry the run link.
--
-- Additive only: one new table, two nullable columns on practice_sessions with their
-- constraints and a partial unique index, two trigger functions. Nothing existing is altered.
--
-- practice_runs (history from the start: rows are never deleted by the API and never rewritten)
--   source                 bank | mock (mock_exam_id is set exactly for mock runs; its FK to
--                          mock_exams arrives with MOCK-B)
--   range                  the validated range request as sent (all, chapter_ids, question_ids,
--                          excluded_question_ids, filters)
--   random_order, seed     `random.Random(seed).shuffle` of the Heatmap order when random_order
--   item_ids               the resolved, ordered question ids (1..5,000 positions); fixed
--   finished_at            set once by POST /practice-runs/{id}/finish
-- Only `finished_at` may change, once (trigger practice_runs_guard; quiz_api also has the column
-- grant only). Only the creating user reads a run: quiz_api keys every run read by
-- (id, user_id) and the verified JWT `sub`; browsers have no grants (AGENTS.md §5).
--
-- practice_sessions.practice_run_id / run_position: a session opened for a run position.
-- Both set or both null; one session per position (partial unique), so a position is submitted
-- at most once (a session is submitted once). The session belongs to the run's user and
-- workspace (composite FK) and practises the question at that position (trigger
-- practice_sessions_check_run); the link never changes once written.
--
-- quiz_api: select, insert, update(finished_at) on practice_runs; no delete.
-- quiz_worker, anon, authenticated: nothing.

create table public.practice_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  mock_exam_id uuid,
  mock_exam_generation_id uuid,
  range jsonb not null,
  random_order boolean not null,
  seed bigint not null,
  item_ids uuid[] not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint practice_runs_id_user_workspace_key unique (id, user_id, workspace_id),
  constraint practice_runs_source_valid check (source in ('bank', 'mock')),
  constraint practice_runs_mock_exam check ((source = 'mock') = (mock_exam_id is not null)),
  constraint practice_runs_mock_generation
    check (mock_exam_generation_id is null or source = 'mock'),
  constraint practice_runs_range_object check (jsonb_typeof(range) = 'object'),
  constraint practice_runs_range_size check (pg_column_size(range) <= 1048576),
  constraint practice_runs_seed_valid check (seed >= 0),
  constraint practice_runs_item_ids_size
    check (array_ndims(item_ids) = 1 and cardinality(item_ids) between 1 and 5000),
  constraint practice_runs_item_ids_not_null check (array_position(item_ids, null) is null),
  constraint practice_runs_finished_order check (finished_at is null or finished_at >= created_at)
);

create index practice_runs_user_created_idx on public.practice_runs (user_id, created_at desc);
create index practice_runs_workspace_idx on public.practice_runs (workspace_id);

create function public.practice_runs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.user_id is distinct from old.user_id
     or new.source is distinct from old.source
     or new.mock_exam_id is distinct from old.mock_exam_id
     or new.mock_exam_generation_id is distinct from old.mock_exam_generation_id
     or new.range is distinct from old.range
     or new.random_order is distinct from old.random_order
     or new.seed is distinct from old.seed
     or new.item_ids is distinct from old.item_ids
     or new.created_at is distinct from old.created_at then
    raise exception 'practice run % is immutable', old.id
      using errcode = '23514', constraint = 'practice_runs_immutable';
  end if;
  if old.finished_at is not null and new.finished_at is distinct from old.finished_at then
    raise exception 'practice run % is already finished', old.id
      using errcode = '23514', constraint = 'practice_runs_finished_once';
  end if;
  return new;
end
$$;

create trigger practice_runs_guard
  before update on public.practice_runs
  for each row execute function public.practice_runs_guard();

alter table public.practice_sessions
  add column practice_run_id uuid,
  add column run_position integer;

alter table public.practice_sessions
  add constraint practice_sessions_run_fk
    foreign key (practice_run_id, user_id, workspace_id)
    references public.practice_runs (id, user_id, workspace_id) on delete cascade not valid,
  add constraint practice_sessions_run_pair
    check ((practice_run_id is null) = (run_position is null)) not valid,
  add constraint practice_sessions_run_position_range
    check (run_position is null or run_position between 1 and 5000) not valid;
alter table public.practice_sessions validate constraint practice_sessions_run_fk;
alter table public.practice_sessions validate constraint practice_sessions_run_pair;
alter table public.practice_sessions validate constraint practice_sessions_run_position_range;

-- One session per run position; also the run's result/summary lookups.
create unique index practice_sessions_run_position_key
  on public.practice_sessions (practice_run_id, run_position) where practice_run_id is not null;

create function public.practice_sessions_check_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.practice_run_id is distinct from old.practice_run_id
       or new.run_position is distinct from old.run_position then
      raise exception 'the run link of practice session % never changes', old.id
        using errcode = '23514', constraint = 'practice_sessions_run_immutable';
    end if;
    return new;
  end if;
  if new.practice_run_id is not null and not exists (
    select 1 from public.practice_runs r
     where r.id = new.practice_run_id
       and r.item_ids[new.run_position] = new.question_id
  ) then
    raise exception 'practice session % does not practise its run position', new.id
      using errcode = '23514', constraint = 'practice_sessions_run_question';
  end if;
  return new;
end
$$;

create trigger practice_sessions_check_run
  before insert or update of practice_run_id, run_position on public.practice_sessions
  for each row execute function public.practice_sessions_check_run();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table public.practice_runs from anon, authenticated;
revoke all on function public.practice_runs_guard() from public, anon, authenticated;
revoke all on function public.practice_sessions_check_run() from public, anon, authenticated;

grant select, insert on public.practice_runs to quiz_api;
grant update (finished_at) on public.practice_runs to quiz_api;

alter table public.practice_runs enable row level security;
create policy quiz_api_select on public.practice_runs
  for select to quiz_api using (true);
create policy quiz_api_insert on public.practice_runs
  for insert to quiz_api with check (true);
create policy quiz_api_update on public.practice_runs
  for update to quiz_api using (true) with check (true);
