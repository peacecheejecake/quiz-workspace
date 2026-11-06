-- UX12 EXPL-3 (20261106120000_ai_explanation_cancel.sql): quiz_api can move an unfinished AI
-- explanation to failed + `cancelled` and nothing else, in both tables.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

select is((select array_agg(policyname::text order by policyname) from pg_policies
            where schemaname = 'public' and tablename = t and 'quiz_api' = any(roles)),
          array['quiz_api_insert', 'quiz_api_select', 'quiz_api_update'],
          t || ': quiz_api has select, insert and update policies')
from unnest(array['question_ai_explanations', 'mock_exam_question_ai_explanations']) as t;

-- Fixtures (superuser; rolled back) ------------------------------------------------------------
grant quiz_api, quiz_worker to postgres;
grant usage on schema extensions to quiz_api, quiz_worker;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0301', 'expl-cancel@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0301', 'expl cancel', '00000000-0000-4000-8000-0000000f0301');
insert into public.questions (id, workspace_id, question_type) values
  ('20000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301', 'MCQ');
insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                       correct_option_ids)
values ('30000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '20000000-0000-4000-8000-0000000f0301', 1, 'Stem',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-1']);
insert into public.mock_exams (id, workspace_id, title, config, range, created_by) values
  ('40000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301', 'A', '{}',
   '{}', '00000000-0000-4000-8000-0000000f0301');
insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, version, status, config,
                                          range, plan, seed, requested_count, created_count,
                                          finished_at)
values ('50000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '40000000-0000-4000-8000-0000000f0301', 1, 'succeeded', '{}', '{}', '[{}]', 7, 1, 1,
        now());
insert into public.mock_exam_questions (id, workspace_id, mock_exam_id, generation_id, position,
                                        question_type, variation_type)
values ('60000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '40000000-0000-4000-8000-0000000f0301', '50000000-0000-4000-8000-0000000f0301', 0, 'MCQ',
        'OPTION_SHUFFLE');
insert into public.mock_exam_question_revisions (id, workspace_id, mock_exam_question_id, version,
                                                 stem, options, correct_option_ids, origin)
values ('70000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '60000000-0000-4000-8000-0000000f0301', 1, 'Q1',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-1'],
        'generated');

-- Bank: queued (…301), running (…302), succeeded (…303), failed (…304), each on its own key.
insert into public.question_ai_explanations (id, workspace_id, question_id, question_revision_id,
                                             prompt_version, model, status, started_at)
values ('80000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '20000000-0000-4000-8000-0000000f0301', '30000000-0000-4000-8000-0000000f0301', 'p/a', 'm',
        'queued', null),
       ('80000000-0000-4000-8000-0000000f0302', '10000000-0000-4000-8000-0000000f0301',
        '20000000-0000-4000-8000-0000000f0301', '30000000-0000-4000-8000-0000000f0301', 'p/b', 'm',
        'running', now());
insert into public.question_ai_explanations (id, workspace_id, question_id, question_revision_id,
                                             prompt_version, model, status, body, finished_at)
values ('80000000-0000-4000-8000-0000000f0303', '10000000-0000-4000-8000-0000000f0301',
        '20000000-0000-4000-8000-0000000f0301', '30000000-0000-4000-8000-0000000f0301', 'p/c', 'm',
        'succeeded', '{}', now());
insert into public.question_ai_explanations (id, workspace_id, question_id, question_revision_id,
                                             prompt_version, model, status, error_code,
                                             finished_at)
values ('80000000-0000-4000-8000-0000000f0304', '10000000-0000-4000-8000-0000000f0301',
        '20000000-0000-4000-8000-0000000f0301', '30000000-0000-4000-8000-0000000f0301', 'p/d', 'm',
        'failed', 'llm_unavailable', now());
insert into public.mock_exam_question_ai_explanations (id, workspace_id, mock_exam_question_id,
                                                       mock_exam_question_revision_id,
                                                       prompt_version, model, status, started_at)
values ('90000000-0000-4000-8000-0000000f0301', '10000000-0000-4000-8000-0000000f0301',
        '60000000-0000-4000-8000-0000000f0301', '70000000-0000-4000-8000-0000000f0301', 'p/a', 'm',
        'running', now());

-- quiz_api: anything but the cancel is refused ---------------------------------------------------
set local role quiz_api;
select throws_ok($$
  update public.question_ai_explanations set status = 'failed', error_code = 'llm_unavailable',
         finished_at = now() where id = '80000000-0000-4000-8000-0000000f0301' $$,
  '42501', null, 'another failure code is refused');
select throws_ok($$
  update public.question_ai_explanations set status = 'running'
   where id = '80000000-0000-4000-8000-0000000f0301' $$,
  '42501', null, 'moving a row on is refused');
select throws_ok($$
  update public.question_ai_explanations set status = 'succeeded', finished_at = now()
   where id = '80000000-0000-4000-8000-0000000f0301' $$,
  '42501', null, 'finishing a row is refused');
select throws_ok($$
  update public.question_ai_explanations set body = '{}'
   where id = '80000000-0000-4000-8000-0000000f0301' $$,
  '42501', null, 'the body is out of the grant');
select throws_ok($$
  update public.question_ai_explanations set superseded_at = now()
   where id = '80000000-0000-4000-8000-0000000f0303' $$,
  '42501', null, 'superseding is out of the grant');

-- The cancel -------------------------------------------------------------------------------------
select lives_ok($$
  update public.question_ai_explanations set status = 'failed', error_code = 'cancelled',
         started_at = coalesce(started_at, now()), finished_at = now()
   where id = '80000000-0000-4000-8000-0000000f0301' $$,
  'a queued explanation is cancelled');
select lives_ok($$
  update public.question_ai_explanations set status = 'failed', error_code = 'cancelled',
         started_at = coalesce(started_at, now()), finished_at = now()
   where id = '80000000-0000-4000-8000-0000000f0302' $$,
  'a running explanation is cancelled');
select lives_ok($$
  update public.mock_exam_question_ai_explanations set status = 'failed',
         error_code = 'cancelled', started_at = coalesce(started_at, now()), finished_at = now()
   where id = '90000000-0000-4000-8000-0000000f0301' $$,
  'a running mock explanation is cancelled');

-- A finished row is out of reach: the update matches nothing and changes nothing.
with again as (
  update public.question_ai_explanations set status = 'failed', error_code = 'cancelled',
         finished_at = now()
   where id in ('80000000-0000-4000-8000-0000000f0301', '80000000-0000-4000-8000-0000000f0303',
                '80000000-0000-4000-8000-0000000f0304')
  returning 1
)
select is((select count(*)::integer from again), 0,
  'a second cancel, a success and a failure all match no row');
reset role;

select is((select array_agg(status || ':' || coalesce(error_code, '-')
                            order by id)
             from public.question_ai_explanations
            where workspace_id = '10000000-0000-4000-8000-0000000f0301'),
          array['failed:cancelled', 'failed:cancelled', 'succeeded:-', 'failed:llm_unavailable'],
  'only the live rows changed');
select ok((select bool_and(finished_at is not null and started_at is not null)
             from public.question_ai_explanations
            where id in ('80000000-0000-4000-8000-0000000f0301',
                         '80000000-0000-4000-8000-0000000f0302')),
  'a cancelled row is finished and started');
select is((select error_code from public.mock_exam_question_ai_explanations
            where id = '90000000-0000-4000-8000-0000000f0301'),
          'cancelled', 'the mock row is cancelled');

-- The worker cannot revive a cancelled row -------------------------------------------------------
set local role quiz_worker;
with revived as (
  update public.question_ai_explanations set status = 'running', error_code = null,
         finished_at = null
   where id = '80000000-0000-4000-8000-0000000f0301'
  returning 1
)
select is((select count(*)::integer from revived), 0, 'quiz_worker cannot revive a cancelled row');
reset role;

select lives_ok($$
  insert into public.question_ai_explanations (workspace_id, question_id, question_revision_id,
                                               prompt_version, model)
  values ('10000000-0000-4000-8000-0000000f0301', '20000000-0000-4000-8000-0000000f0301',
          '30000000-0000-4000-8000-0000000f0301', 'p/a', 'm') $$,
  'a cancelled row blocks no new explanation of its key');

select * from finish();
rollback;
