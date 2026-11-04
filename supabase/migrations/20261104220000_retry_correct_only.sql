-- RETRY-CORRECT (docs/questions.md §16, docs/screens/retry-correct.md RETRY-01-C02/C03): `다시 풀기`
-- (question_user_states.needs_retry) is only meaningful on a question whose last graded result is
-- correct (the Heatmap `정답` state, merged duplicates folded in as in
-- public.question_merged_user_states, questions.md §10.2).
--
-- 1. Rule: a row written with last_graded_result = 'incorrect' (a new graded result: every
--    grading path — auto, self-grade, anything after them — passes through this column) has
--    needs_retry turned off, and so do the same user's rows of the question's actively merged
--    duplicates (and of the kept question, when the graded row is a duplicate's), because the
--    merged flag is the OR of those rows. A correct result and a write that leaves the graded
--    result alone (a my-state flag change, a view) never touch the flag. The API refuses to turn
--    the flag *on* when the last result is not correct (409 `retry-requires-correct`); this
--    trigger is what keeps it off afterwards, wherever the grading came from.
-- 2. Existing data is NOT changed (user decision 2026-11-04): flags already on for questions whose
--    last graded result is not correct stay on (Heatmap `retry` and the 다시 풀기 filter keep
--    showing them); only the toggle is hidden there until the question is answered correctly.
--
-- Additive only: one function and two triggers (insert / update); no data, column, constraint or view changes;
-- attempts and last_graded_result are never touched.

create function public.question_user_states_retry_clear()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  canonical uuid;
begin
  new.needs_retry := false;

  -- The merged group of the graded question: its canonical (kept) question and the duplicates
  -- actively merged into it.
  select coalesce(
           (select m.kept_question_id
              from public.question_merges m
             where m.duplicate_question_id = new.question_id
               and m.workspace_id = new.workspace_id
               and m.ended_at is null),
           new.question_id)
    into canonical;

  update public.question_user_states s
     set needs_retry = false
   where s.user_id = new.user_id
     and s.workspace_id = new.workspace_id
     and s.needs_retry
     and s.question_id <> new.question_id
     and (s.question_id = canonical
          or s.question_id in (select m.duplicate_question_id
                                 from public.question_merges m
                                where m.kept_question_id = canonical
                                  and m.workspace_id = new.workspace_id
                                  and m.ended_at is null));
  return new;
end;
$$;

revoke all on function public.question_user_states_retry_clear() from public, anon, authenticated;

create trigger question_user_states_retry_clear
  before insert on public.question_user_states
  for each row
  when (new.last_graded_result = 'incorrect')
  execute function public.question_user_states_retry_clear();

create trigger question_user_states_retry_clear_update
  before update of last_graded_result, last_graded_attempt_id on public.question_user_states
  for each row
  when (new.last_graded_result = 'incorrect'
        and (new.last_graded_result is distinct from old.last_graded_result
             or new.last_graded_attempt_id is distinct from old.last_graded_attempt_id))
  execute function public.question_user_states_retry_clear();
