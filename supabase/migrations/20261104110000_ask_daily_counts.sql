-- ASK-B follow-up (user decision 2026-11-02): the per-user daily AI question limit is not freed by
-- deleting conversations.
--
-- ask_daily_counts  answers accepted per user and Asia/Seoul day (new questions, retries and
--                   regenerations; with or without an LLM call). Counts only. Written by a
--                   trigger on every inserted assistant message, so neither the API nor the
--                   worker can skip it, and kept when the conversation (and its messages) is
--                   deleted. The worker's `ask.purge` removes days older than its usage
--                   retention.
--
-- Additive only: one table, one trigger function, its trigger on ask_messages, grants and RLS.

create table public.ask_daily_counts (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  answers integer not null default 0,
  primary key (user_id, day),
  constraint ask_daily_counts_answers_non_negative check (answers >= 0)
);

create index ask_daily_counts_day_idx on public.ask_daily_counts (day);

create function public.ask_messages_count_daily()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.ask_daily_counts as c (user_id, day, answers)
  values (new.user_id, (new.created_at at time zone 'Asia/Seoul')::date, 1)
  on conflict (user_id, day) do update set answers = c.answers + 1;
  return null;
end;
$$;

comment on function public.ask_messages_count_daily() is
  'ASK trigger: count an accepted answer in ask_daily_counts (user, Asia/Seoul day).';

create trigger ask_messages_count_daily
  after insert on public.ask_messages
  for each row
  when (new.role = 'assistant')
  execute function public.ask_messages_count_daily();

revoke all on table public.ask_daily_counts from public, anon, authenticated;
revoke all on function public.ask_messages_count_daily()
  from public, anon, authenticated, quiz_api, quiz_worker;
grant select on public.ask_daily_counts to quiz_api;
grant select, delete on public.ask_daily_counts to quiz_worker;

alter table public.ask_daily_counts enable row level security;
create policy quiz_api_select on public.ask_daily_counts
  for select to quiz_api using (true);
create policy quiz_worker_select on public.ask_daily_counts
  for select to quiz_worker using (true);
create policy quiz_worker_delete on public.ask_daily_counts
  for delete to quiz_worker using (true);
