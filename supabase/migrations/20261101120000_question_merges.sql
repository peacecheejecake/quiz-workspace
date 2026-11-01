-- UX7-DEDUP: merging duplicate questions (docs/questions.md §10, docs/architecture.md §5,
-- docs/screens/questions-overview.md QOV-01-AC16/AC17).
--
-- The 중복 문제 정리 dialog keeps one question of a group of duplicates and ARCHIVES the others
-- (POST /workspaces/{id}/question-duplicates/merge). Each archived duplicate gets a link to the
-- kept question, and the kept question's per-user study state is read as the union of its own
-- state and its linked duplicates' states. Attempts, practice sessions and study-state rows are
-- never rewritten: the merge is additive, and unarchiving a duplicate ends its link so its own
-- records are its own again.
--
-- Additive only: one table, one view, two trigger functions and their triggers. Nothing existing
-- is altered.
--
-- question_merges: the history of duplicate -> kept links (never deleted).
--   duplicate_question_id  the archived duplicate
--   kept_question_id       the question its history is merged into
--   created_by/created_at  who merged, when
--   ended_at/ended_by      when the link ended (null = active); `ended_by` is null when the
--                          trigger ended it (the actor is in the question.status_changed activity)
--   end_reason             unarchived (the duplicate went back to CONFIRMED)
--                          | repointed (the kept question was itself merged into another one: the
--                            link was ended and a new one to the new kept question inserted)
-- Invariants (trigger question_merges_check_link): an active link never chains — the kept
-- question is not an active duplicate and the duplicate is not an active kept question — and a
-- duplicate has at most one active link (partial unique index). Both ends are questions of the
-- same workspace (composite FKs).
--
-- question_merged_user_states (view, security_invoker): one row per (user, canonical question)
-- that has any state: the question's own `question_user_states` row and those of its actively
-- linked duplicates, folded:
--   first_viewed_at  min          last_viewed_at   max
--   last_graded_*    the graded result whose attempt was graded last (graded_at, then
--                    submitted_at, then id)
--   is_favorite      bool_or      needs_retry      bool_or
-- `question_id` is the canonical (kept) question; a linked duplicate has no row of its own here.
-- Readers filter by (user_id, workspace_id) — the planner pushes both into the
-- question_user_states_user_workspace_idx scan.
--
-- quiz_api: reads both; inserts links; may only end a link (column UPDATE of ended_*); no DELETE.
-- quiz_worker, anon, authenticated: nothing.

create table public.question_merges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  duplicate_question_id uuid not null,
  kept_question_id uuid not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references auth.users (id) on delete set null,
  end_reason text,
  constraint question_merges_duplicate_fk foreign key (workspace_id, duplicate_question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_merges_kept_fk foreign key (workspace_id, kept_question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_merges_not_self check (duplicate_question_id <> kept_question_id),
  constraint question_merges_end_reason_valid
    check (end_reason is null or end_reason in ('unarchived', 'repointed')),
  constraint question_merges_ended_pair check ((ended_at is null) = (end_reason is null)),
  constraint question_merges_ended_order check (ended_at is null or ended_at >= created_at)
);

-- One active link per duplicate; the state view joins on it.
create unique index question_merges_active_duplicate_key
  on public.question_merges (duplicate_question_id) where ended_at is null;
-- A kept question's active duplicates (overview pending flag, attempts, my-state).
create index question_merges_active_kept_idx
  on public.question_merges (workspace_id, kept_question_id) where ended_at is null;
create index question_merges_kept_idx on public.question_merges (kept_question_id);
create index question_merges_created_by_idx on public.question_merges (created_by);
create index question_merges_ended_by_idx on public.question_merges (ended_by);

-- No chains: a new or re-activated link may not start at an active kept question or end at an
-- active duplicate. Serialised by the merge route's FOR UPDATE locks on both questions; this is
-- the backstop for any other writer.
create function public.question_merges_check_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ended_at is not null then
    return new;
  end if;
  if exists (select 1 from public.question_merges m
              where m.duplicate_question_id = new.kept_question_id and m.ended_at is null) then
    raise exception 'question % is itself merged into another question', new.kept_question_id
      using errcode = '23514', constraint = 'question_merges_no_chain';
  end if;
  if exists (select 1 from public.question_merges m
              where m.kept_question_id = new.duplicate_question_id and m.ended_at is null
                and m.id <> new.id) then
    raise exception 'question % still has merged duplicates', new.duplicate_question_id
      using errcode = '23514', constraint = 'question_merges_no_chain';
  end if;
  return new;
end
$$;

create trigger question_merges_check_link
  before insert or update on public.question_merges
  for each row execute function public.question_merges_check_link();

-- Unarchiving a merged duplicate (ARCHIVED -> CONFIRMED, PATCH /questions/{id}) unmerges it,
-- whichever path changed the status.
create function public.question_merges_end_on_restore()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.question_merges
     set ended_at = pg_catalog.now(), end_reason = 'unarchived'
   where duplicate_question_id = new.id and ended_at is null;
  return null;
end
$$;

create trigger questions_end_merge_on_restore
  after update of publication_status on public.questions
  for each row
  when (old.publication_status = 'ARCHIVED' and new.publication_status <> 'ARCHIVED')
  execute function public.question_merges_end_on_restore();

create view public.question_merged_user_states
with (security_invoker = true) as
select
  s.user_id,
  s.workspace_id,
  coalesce(m.kept_question_id, s.question_id) as question_id,
  min(s.first_viewed_at) as first_viewed_at,
  max(s.last_viewed_at) as last_viewed_at,
  (array_agg(s.last_graded_result
             order by a.graded_at desc nulls last, a.submitted_at desc, a.id desc)
     filter (where s.last_graded_result is not null))[1] as last_graded_result,
  (array_agg(s.last_graded_attempt_id
             order by a.graded_at desc nulls last, a.submitted_at desc, a.id desc)
     filter (where s.last_graded_result is not null))[1] as last_graded_attempt_id,
  bool_or(s.is_favorite) as is_favorite,
  bool_or(s.needs_retry) as needs_retry,
  count(*) filter (where m.id is not null) as merged_states
from public.question_user_states s
left join public.question_merges m
  on m.duplicate_question_id = s.question_id
 and m.workspace_id = s.workspace_id
 and m.ended_at is null
left join public.question_attempts a on a.id = s.last_graded_attempt_id
group by s.user_id, s.workspace_id, coalesce(m.kept_question_id, s.question_id);

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table public.question_merges from anon, authenticated;
revoke all on table public.question_merged_user_states from anon, authenticated;
revoke all on function public.question_merges_check_link() from public, anon, authenticated;
revoke all on function public.question_merges_end_on_restore() from public, anon, authenticated;

grant select, insert on public.question_merges to quiz_api;
grant update (ended_at, ended_by, end_reason) on public.question_merges to quiz_api;
grant select on public.question_merged_user_states to quiz_api;

alter table public.question_merges enable row level security;
create policy quiz_api_select on public.question_merges
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_merges
  for insert to quiz_api with check (true);
create policy quiz_api_update on public.question_merges
  for update to quiz_api using (true) with check (true);
