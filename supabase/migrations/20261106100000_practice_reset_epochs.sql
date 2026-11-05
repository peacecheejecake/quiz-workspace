-- Preserve attempts for audit and foreign keys while hiding pre-reset history from the user.
create table public.practice_reset_epochs (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  epoch bigint not null default 0 check (epoch >= 0),
  reset_at timestamptz,
  primary key (user_id, question_id)
);

alter table public.practice_sessions add column reset_epoch bigint not null default 0;
comment on table public.practice_reset_epochs is
  'Personal reset boundary; immutable attempts remain stored for audit and referential integrity.';
comment on column public.practice_sessions.reset_epoch is
  'Epoch pinned on opening; older sessions are no longer available to their user after reset.';

alter table public.practice_reset_epochs enable row level security;
create policy quiz_api_all on public.practice_reset_epochs to quiz_api using (true) with check (true);
grant select, insert, update on public.practice_reset_epochs to quiz_api;
