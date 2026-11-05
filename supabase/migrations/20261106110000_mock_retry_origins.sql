-- A separate retry keeps provenance without participating in the original run's score.
alter table public.mock_exam_practice_sessions
  add column retry_origin_run_id uuid,
  add column retry_origin_position integer,
  add constraint mock_retry_origin_pair check (
    (retry_origin_run_id is null) = (retry_origin_position is null)
    and (retry_origin_position is null or retry_origin_position between 1 and 5000)
    and (retry_origin_run_id is null or practice_run_id is null)
  ),
  add constraint mock_retry_origin_run_fk
    foreign key (retry_origin_run_id, user_id, workspace_id)
    references public.practice_runs (id, user_id, workspace_id) on delete cascade;

create function public.mock_retry_origin_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.retry_origin_run_id is distinct from old.retry_origin_run_id
       or new.retry_origin_position is distinct from old.retry_origin_position
       or (old.retry_origin_run_id is not null and (
         new.user_id is distinct from old.user_id
         or new.workspace_id is distinct from old.workspace_id
         or new.mock_exam_question_id is distinct from old.mock_exam_question_id
       )) then
      raise exception 'mock retry origin is immutable' using errcode = '23514',
        constraint = 'mock_retry_origin_immutable';
    end if;
    return new;
  end if;
  if new.retry_origin_run_id is not null and not exists (
    select 1 from public.practice_runs r
    join public.mock_exam_questions q on q.id = new.mock_exam_question_id
      and q.workspace_id = new.workspace_id
    join public.mock_exams e on e.id = q.mock_exam_id and e.workspace_id = q.workspace_id
    where r.id = new.retry_origin_run_id and r.user_id = new.user_id
      and r.workspace_id = new.workspace_id and r.source = 'mock'
      and r.item_ids[new.retry_origin_position] = q.id
      and r.mock_exam_id = q.mock_exam_id
      and r.mock_exam_generation_id = q.generation_id
      and q.removed_at is null and e.deleted_at is null
  ) then
    raise exception 'invalid mock retry origin' using errcode = '23514',
      constraint = 'mock_retry_origin_question';
  end if;
  return new;
end $$;
create trigger mock_retry_origin_check before insert or update of retry_origin_run_id, retry_origin_position, user_id, workspace_id, mock_exam_question_id
  on public.mock_exam_practice_sessions for each row execute function public.mock_retry_origin_check();
revoke all on function public.mock_retry_origin_check() from public, anon, authenticated, quiz_api, quiz_worker;
