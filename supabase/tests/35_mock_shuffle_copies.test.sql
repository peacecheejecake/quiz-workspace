-- UX12-MOCKSHUFFLE-C01 (20261106190000): a generation of 보기 섞기 only finishes in the API's
-- transaction through one definer function. quiz_api still cannot write those rows itself.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

select ok(has_function_privilege('quiz_api',
            'public.mock_exam_store_shuffle_copies(uuid, jsonb)', 'execute')
          and not has_function_privilege('quiz_worker',
            'public.mock_exam_store_shuffle_copies(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon',
            'public.mock_exam_store_shuffle_copies(uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated',
            'public.mock_exam_store_shuffle_copies(uuid, jsonb)', 'execute'),
  'only quiz_api may store shuffle copies');
select ok(not has_table_privilege('quiz_api', 'public.mock_exam_questions', 'insert')
          and not has_column_privilege('quiz_api', 'public.mock_exams', 'current_generation_id',
                                       'update'),
  'quiz_api still cannot insert questions or choose the shown generation itself');

insert into auth.users (id, email)
 values ('00000000-0000-4000-8000-000000130001', 'shuffle@example.test');
insert into public.workspaces (id, name, owner_id)
 values ('10000000-0000-4000-8000-000000130001', 'w', '00000000-0000-4000-8000-000000130001');
insert into public.questions (id, workspace_id, question_type) values
  ('20000000-0000-4000-8000-000000130001', '10000000-0000-4000-8000-000000130001', 'MCQ');
insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                       correct_option_ids, explanation, stem_tables)
values ('30000000-0000-4000-8000-000000130001', '10000000-0000-4000-8000-000000130001',
        '20000000-0000-4000-8000-000000130001', 1, 'Source stem',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}, {"id": "opt-3", "text": "c"}]',
        array['opt-2'], 'Why', null);
update public.questions
   set active_revision_id = '30000000-0000-4000-8000-000000130001', publication_status = 'CONFIRMED'
 where id = '20000000-0000-4000-8000-000000130001';

insert into public.async_jobs (id, workspace_id, created_by, job_type, schema_version,
                               idempotency_key, payload)
values ('60000000-0000-4000-8000-000000130001', '10000000-0000-4000-8000-000000130001',
        '00000000-0000-4000-8000-000000130001', 'mock_exam.generate', 1, 'shuffle-test', '{}');

grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;

set local role quiz_api;
insert into public.mock_exams (id, workspace_id, title, config, range, created_by) values
  ('40000000-0000-4000-8000-000000130001', '10000000-0000-4000-8000-000000130001', '섞기',
   '{"variation_types": ["OPTION_SHUFFLE"], "question_count": 1}', '{"all": true}',
   '00000000-0000-4000-8000-000000130001'),
  ('40000000-0000-4000-8000-000000130002', '10000000-0000-4000-8000-000000130001', 'AI',
   '{"variation_types": ["PARAPHRASE"], "question_count": 1}', '{"all": true}',
   '00000000-0000-4000-8000-000000130001'),
  ('40000000-0000-4000-8000-000000130003', '10000000-0000-4000-8000-000000130001', 'job',
   '{"variation_types": ["OPTION_SHUFFLE"], "question_count": 1}', '{"all": true}',
   '00000000-0000-4000-8000-000000130001');
insert into public.mock_exam_generations (id, workspace_id, mock_exam_id, version, job_id, config,
                                          range, plan, seed, requested_count, created_by)
values
  ('50000000-0000-4000-8000-000000130001', '10000000-0000-4000-8000-000000130001',
   '40000000-0000-4000-8000-000000130001', 1, null, '{}', '{}',
   '[{"position": 0, "question_id": "20000000-0000-4000-8000-000000130001",
      "question_revision_id": "30000000-0000-4000-8000-000000130001",
      "variation_type": "OPTION_SHUFFLE", "chapter_rank": 0}]', 7, 1,
   '00000000-0000-4000-8000-000000130001'),
  ('50000000-0000-4000-8000-000000130002', '10000000-0000-4000-8000-000000130001',
   '40000000-0000-4000-8000-000000130002', 1, null, '{}', '{}',
   '[{"position": 0, "question_id": "20000000-0000-4000-8000-000000130001",
      "question_revision_id": "30000000-0000-4000-8000-000000130001",
      "variation_type": "PARAPHRASE", "chapter_rank": 0}]', 7, 1,
   '00000000-0000-4000-8000-000000130001'),
  ('50000000-0000-4000-8000-000000130003', '10000000-0000-4000-8000-000000130001',
   '40000000-0000-4000-8000-000000130003', 1, '60000000-0000-4000-8000-000000130001', '{}', '{}',
   '[{"position": 0, "question_id": "20000000-0000-4000-8000-000000130001",
      "question_revision_id": "30000000-0000-4000-8000-000000130001",
      "variation_type": "OPTION_SHUFFLE", "chapter_rank": 0}]', 7, 1,
   '00000000-0000-4000-8000-000000130001');

select throws_ok($$
  select public.mock_exam_store_shuffle_copies('50000000-0000-4000-8000-000000130002', '{}') $$,
  '22023', null, 'a plan with an AI item is refused');
select throws_ok($$
  select public.mock_exam_store_shuffle_copies('50000000-0000-4000-8000-000000130003', '{}') $$,
  '22023', null, 'a generation with a job is the worker''s');
select throws_ok($$
  select public.mock_exam_store_shuffle_copies('50000000-0000-4000-8000-0000001300ff', '{}') $$,
  '22023', null, 'an unknown generation is refused');
select is(
  public.mock_exam_store_shuffle_copies('50000000-0000-4000-8000-000000130001',
    '{"20000000-0000-4000-8000-000000130001": [{"document_id": "d"}]}'),
  1, 'the plan is copied');
select throws_ok($$
  select public.mock_exam_store_shuffle_copies('50000000-0000-4000-8000-000000130001', '{}') $$,
  '22023', null, 'a finished generation cannot be stored twice');
reset role;

select is((select status from public.mock_exam_generations
            where id = '50000000-0000-4000-8000-000000130001'), 'succeeded',
  'the generation succeeded');
select is((select created_count from public.mock_exam_generations
            where id = '50000000-0000-4000-8000-000000130001'), 1, 'its count is the plan''s');
select is((select current_generation_id from public.mock_exams
            where id = '40000000-0000-4000-8000-000000130001'),
          '50000000-0000-4000-8000-000000130001'::uuid, 'the mock exam shows it');
select is((select r.options->0->>'id'
             from public.mock_exam_questions q
             join public.mock_exam_question_revisions r on r.id = q.active_revision_id
            where q.generation_id = '50000000-0000-4000-8000-000000130001'),
          'opt-1', 'the copy keeps the source option order');
select is((select r.correct_option_ids
             from public.mock_exam_questions q
             join public.mock_exam_question_revisions r on r.id = q.active_revision_id
            where q.generation_id = '50000000-0000-4000-8000-000000130001'),
          array['opt-2'], 'the copy keeps the answer key by option id');
select is((select r.evidence
             from public.mock_exam_questions q
             join public.mock_exam_question_revisions r on r.id = q.active_revision_id
            where q.generation_id = '50000000-0000-4000-8000-000000130001'),
          '[{"document_id": "d"}]'::jsonb, 'the copy holds the evidence for its source');
select is((select q.source_question_revision_id from public.mock_exam_questions q
            where q.generation_id = '50000000-0000-4000-8000-000000130001'),
          '30000000-0000-4000-8000-000000130001'::uuid, 'the copy pins the source revision');
select is((select count(*)::int from public.activity_events
            where event_type = 'mock_exam.generated'
              and target_id = '40000000-0000-4000-8000-000000130001'), 1,
  'the generation is recorded like a worker''s');
select is((select count(*)::int from public.mock_exam_generation_items
            where generation_id = '50000000-0000-4000-8000-000000130001'), 0,
  'no job, no checkpoints');

select * from finish();
rollback;
