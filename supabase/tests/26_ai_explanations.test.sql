-- EXPL-B (20261103150000_ai_explanations.sql): one live and one current AI explanation per
-- (revision, prompt version, model), API inserts only queued rows, the worker finishes and
-- supersedes, activity on success (ids only), usage rows that reference an explanation, and the
-- mock exam table with the same rules.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(35);

select has_table('public', 'question_ai_explanations', 'question_ai_explanations exists');
select has_table('public', 'mock_exam_question_ai_explanations',
  'mock_exam_question_ai_explanations exists');
select index_is_unique('public', t, t || '_one_live', t || ': one live row per key')
from unnest(array['question_ai_explanations', 'mock_exam_question_ai_explanations']) as t;
select index_is_unique('public', t, t || '_one_current', t || ': one current success per key')
from unnest(array['question_ai_explanations', 'mock_exam_question_ai_explanations']) as t;
select fk_ok('public', 'mock_exam_question_ai_explanations',
             array['workspace_id', 'mock_exam_question_id', 'mock_exam_question_revision_id'],
             'public', 'mock_exam_question_revisions',
             array['workspace_id', 'mock_exam_question_id', 'id'],
  'a mock explanation belongs to a revision of its own mock exam question');
select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
from unnest(array['question_ai_explanations', 'mock_exam_question_ai_explanations']) as t,
     unnest(array['anon', 'authenticated']) as r;
select has_trigger('public', 'workspace_forks', 'workspace_forks_copy_question_ai_explanations',
  'a completed fork copies the newest explanations');
select ok(not has_function_privilege('quiz_api', 'public.ai_explanations_record_generated()',
                                     'execute')
          and not has_function_privilege('quiz_worker',
                                         'public.fork_copy_question_ai_explanations()', 'execute'),
  'trigger functions are not callable');
select has_column('public', 'llm_feature_usage', 'ref_id', 'usage rows reference an explanation');

-- Fixtures (superuser; rolled back) ------------------------------------------------------------
grant quiz_api, quiz_worker to postgres;
grant usage on schema extensions to quiz_api, quiz_worker;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0001', 'expl-u@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0001', 'expl w1', '00000000-0000-4000-8000-0000000f0001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001', 'owner');
insert into public.questions (id, workspace_id, question_type) values
  ('20000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001', 'MCQ');
insert into public.question_revisions (id, workspace_id, question_id, version, stem, options,
                                       correct_option_ids)
values ('30000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '20000000-0000-4000-8000-0000000f0001', 1, 'Stem',
        '[{"id": "opt-1", "text": "a"}, {"id": "opt-2", "text": "b"}]', array['opt-1']);
update public.questions
   set active_revision_id = '30000000-0000-4000-8000-0000000f0001', publication_status = 'CONFIRMED'
 where id = '20000000-0000-4000-8000-0000000f0001';

-- quiz_api ---------------------------------------------------------------------------------------
set local role quiz_api;
select lives_ok($$
  insert into public.question_ai_explanations (id, workspace_id, question_id, question_revision_id,
                                               prompt_version, model, sources, created_by)
  values ('40000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          '20000000-0000-4000-8000-0000000f0001', '30000000-0000-4000-8000-0000000f0001', 'p/v1',
          'm', '[{"tag": 1, "document_id": "x", "block_ids": [], "page_from": 2, "page_to": 2}]',
          '00000000-0000-4000-8000-0000000f0001') $$,
  'quiz_api inserts a queued explanation');
select throws_ok($$
  insert into public.question_ai_explanations (workspace_id, question_id, question_revision_id,
                                               prompt_version, model)
  values ('10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001',
          '30000000-0000-4000-8000-0000000f0001', 'p/v1', 'm') $$,
  '23505', null, 'a second live explanation of the same key is refused');
select lives_ok($$
  insert into public.question_ai_explanations (workspace_id, question_id, question_revision_id,
                                               prompt_version, model)
  values ('10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001',
          '30000000-0000-4000-8000-0000000f0001', 'p/v1', 'other-model')
  on conflict do nothing $$,
  'another model is another key');
select is((select count(*)::int from public.question_ai_explanations
            where question_revision_id = '30000000-0000-4000-8000-0000000f0001'
              and prompt_version = 'p/v1' and model = 'm'), 1,
  'insert … on conflict do nothing keeps one live row');
select throws_ok($$
  insert into public.question_ai_explanations (workspace_id, question_id, question_revision_id,
                                               prompt_version, model, status, body, finished_at)
  values ('10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001',
          '30000000-0000-4000-8000-0000000f0001', 'p/v2', 'm', 'succeeded', '{}', now()) $$,
  '42501', null, 'quiz_api cannot insert a finished explanation');
select throws_ok($$
  insert into public.question_ai_explanations (workspace_id, question_id, question_revision_id,
                                               prompt_version, model)
  values ('10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0002',
          '30000000-0000-4000-8000-0000000f0001', 'p/v3', 'm') $$,
  '23503', null, 'the revision must belong to the explained question');
select throws_ok($$
  update public.question_ai_explanations set status = 'failed', error_code = 'x', finished_at = now()
   where id = '40000000-0000-4000-8000-0000000f0001' $$,
  '42501', null, 'quiz_api cannot finish an explanation');
reset role;

-- quiz_worker ------------------------------------------------------------------------------------
set local role quiz_worker;
select lives_ok($$
  update public.question_ai_explanations set status = 'running', started_at = now()
   where id = '40000000-0000-4000-8000-0000000f0001' $$,
  'quiz_worker starts an explanation');
select throws_ok($$
  update public.question_ai_explanations set status = 'succeeded', finished_at = now()
   where id = '40000000-0000-4000-8000-0000000f0001' $$,
  '23514', null, 'a succeeded explanation needs its body');
select lives_ok($$
  update public.question_ai_explanations
     set status = 'succeeded', body = '{"summary_md": "s"}', finished_at = now()
   where id = '40000000-0000-4000-8000-0000000f0001' $$,
  'quiz_worker stores the validated body');
select throws_ok($$
  update public.question_ai_explanations set prompt_version = 'p/v9'
   where id = '40000000-0000-4000-8000-0000000f0001' $$,
  '42501', null, 'the key is not the worker''s to change');
select lives_ok($$
  insert into public.llm_feature_usage (feature, user_id, workspace_id, ref_id, model, status)
  values ('ai_explanation', '00000000-0000-4000-8000-0000000f0001',
          '10000000-0000-4000-8000-0000000f0001', '40000000-0000-4000-8000-0000000f0001', 'm',
          'succeeded') $$,
  'quiz_worker records usage for an explanation');
select throws_ok($$
  insert into public.llm_feature_usage (feature, ref_id, model, status)
  values ('ask', '40000000-0000-4000-8000-0000000f0001', 'm', 'succeeded') $$,
  '23514', null, 'only ai_explanation usage references an explanation');
reset role;

select is(
  (select metadata from public.activity_events
    where event_type = 'question.ai_explanation_generated'
      and target_id = '20000000-0000-4000-8000-0000000f0001'),
  jsonb_build_object('explanation_id', '40000000-0000-4000-8000-0000000f0001',
                     'revision_id', '30000000-0000-4000-8000-0000000f0001', 'version', 1),
  'success is recorded with ids and the version only');

-- A regeneration: a second live row next to the current success, then supersede and succeed.
set local role quiz_api;
select lives_ok($$
  insert into public.question_ai_explanations (id, workspace_id, question_id, question_revision_id,
                                               prompt_version, model, version, regenerated)
  values ('40000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
          '20000000-0000-4000-8000-0000000f0001', '30000000-0000-4000-8000-0000000f0001', 'p/v1',
          'm', 2, true) $$,
  'a regeneration is queued while the previous success stays current');
reset role;
set local role quiz_worker;
select throws_ok($$
  update public.question_ai_explanations
     set status = 'succeeded', body = '{"summary_md": "t"}', finished_at = now()
   where id = '40000000-0000-4000-8000-0000000f0002' $$,
  '23505', null, 'two current successes of one key are refused');
select lives_ok($$
  update public.question_ai_explanations set superseded_at = now()
   where id = '40000000-0000-4000-8000-0000000f0001';
  update public.question_ai_explanations
     set status = 'succeeded', body = '{"summary_md": "t"}', finished_at = now()
   where id = '40000000-0000-4000-8000-0000000f0002' $$,
  'the worker supersedes the previous success, then stores the new one');
select is_empty($$ update public.question_ai_explanations set superseded_at = null
                    where id = '40000000-0000-4000-8000-0000000f0001' returning id $$,
  'a superseded explanation stays superseded');
reset role;
select results_eq(
  $$ select version, superseded_at is not null from public.question_ai_explanations
      where question_revision_id = '30000000-0000-4000-8000-0000000f0001' and model = 'm'
      order by version $$,
  $$ values (1, true), (2, false) $$,
  'both versions are kept, the older one superseded');
select is((select count(*)::int from public.activity_events
            where event_type = 'question.ai_explanation_generated'), 2,
  'each success is one activity');

-- Deleting the question removes its explanations.
delete from public.questions where id = '20000000-0000-4000-8000-0000000f0001';
select is_empty($$ select 1 from public.question_ai_explanations
                    where question_id = '20000000-0000-4000-8000-0000000f0001' $$,
  'explanations go with their question');

select * from finish();
rollback;
