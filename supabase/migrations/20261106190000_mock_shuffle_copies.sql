-- UX12-MOCKSHUFFLE (docs/screens/ux12-mock-shuffle.md C01): a mock exam of 보기 섞기 only is saved
-- in the API's request, without a job. Additive: one function.
--
-- `quiz_api` still cannot insert questions, finish a generation as a success or choose the shown
-- generation (20261102140000_mock_exams.sql, policies "never a success"). This one function does
-- those three things, and only for what it can check itself: a queued generation without a job
-- whose whole plan is OPTION_SHUFFLE. It copies the pinned revisions in their source option order
-- (the order is drawn per run, C03) and takes nothing from the caller but the evidence, which the
-- API builds from `question_sources` with `book_core.generation.stored_source_evidence`.

create function public.mock_exam_store_shuffle_copies(
  p_generation_id uuid,
  p_evidence jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  generation public.mock_exam_generations%rowtype;
  copied integer;
begin
  select * into generation from public.mock_exam_generations
   where id = p_generation_id for update;
  if not found or generation.status <> 'queued' or generation.job_id is not null then
    raise exception 'mock exam generation % is not a queued generation without a job',
      p_generation_id using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(generation.plan) item
              where item ->> 'variation_type' is distinct from 'OPTION_SHUFFLE') then
    raise exception 'mock exam generation % has AI items', p_generation_id
      using errcode = '22023';
  end if;

  insert into public.mock_exam_questions (workspace_id, mock_exam_id, generation_id, position,
                                          question_type, variation_type, source_question_id,
                                          source_question_revision_id)
  select generation.workspace_id, generation.mock_exam_id, generation.id, plan.position,
         source.question_type, 'OPTION_SHUFFLE', source.id, revision.id
    from pg_catalog.jsonb_to_recordset(generation.plan)
           as plan(position integer, question_id uuid, question_revision_id uuid)
    join public.question_revisions revision
      on revision.workspace_id = generation.workspace_id
     and revision.question_id = plan.question_id
     and revision.id = plan.question_revision_id
    join public.questions source
      on source.workspace_id = revision.workspace_id and source.id = revision.question_id;
  get diagnostics copied = row_count;
  if copied <> generation.requested_count then
    raise exception 'mock exam generation % lost a pinned revision', p_generation_id
      using errcode = '22023';
  end if;

  insert into public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, version,
                                                   stem, options, correct_option_ids,
                                                   accepted_answers, is_multi_answer, explanation,
                                                   rubric, evidence, validation_issues, origin,
                                                   stem_tables)
  select copy.workspace_id, copy.id, 1, revision.stem, revision.options,
         revision.correct_option_ids, revision.accepted_answers, revision.is_multi_answer,
         revision.explanation, revision.rubric,
         coalesce(p_evidence -> copy.source_question_id::text, '[]'::jsonb), '[]'::jsonb,
         'generated', revision.stem_tables
    from public.mock_exam_questions copy
    join public.question_revisions revision
      on revision.workspace_id = copy.workspace_id
     and revision.id = copy.source_question_revision_id
   where copy.generation_id = generation.id;

  update public.mock_exam_questions copy
     set active_revision_id = revision.id
    from public.mock_exam_question_revisions revision
   where copy.generation_id = generation.id
     and revision.mock_exam_question_id = copy.id;

  update public.mock_exam_generations
     set status = 'succeeded', created_count = copied, progress_done = copied,
         started_at = now(), finished_at = now()
   where id = generation.id;

  update public.mock_exams
     set current_generation_id = generation.id
   where id = generation.mock_exam_id and deleted_at is null;
  if not found then
    raise exception 'mock exam of generation % is gone', p_generation_id using errcode = '22023';
  end if;
  return copied;
end;
$$;

comment on function public.mock_exam_store_shuffle_copies(uuid, jsonb) is
  'UX12-MOCKSHUFFLE-C01: finishes a job-less OPTION_SHUFFLE generation in the API''s transaction.';

revoke all on function public.mock_exam_store_shuffle_copies(uuid, jsonb)
  from public, anon, authenticated, quiz_worker;
grant execute on function public.mock_exam_store_shuffle_copies(uuid, jsonb) to quiz_api;
