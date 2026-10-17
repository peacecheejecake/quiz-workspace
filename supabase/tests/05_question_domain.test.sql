-- M4.1: question domain structure, integrity constraints, immutability, draft isolation, grants.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(164);

-- Structure -------------------------------------------------------------------------------------
select columns_are('public', 'questions',
  array['id', 'workspace_id', 'chapter_id', 'question_type', 'origin', 'question_number',
        'sort_order', 'active_revision_id', 'publication_status', 'created_by', 'created_at',
        'updated_at', 'deleted_at']);
select columns_are('public', 'question_revisions',
  array['id', 'workspace_id', 'question_id', 'version', 'stem', 'options', 'correct_option_ids',
        'accepted_answers', 'is_multi_answer', 'explanation', 'rubric', 'created_by',
        'created_at']);
select columns_are('public', 'question_sources',
  array['id', 'workspace_id', 'question_id', 'document_id', 'document_revision_id', 'page_start',
        'page_end', 'block_ids', 'locations', 'import_run_id', 'created_at']);
select columns_are('public', 'question_user_states',
  array['user_id', 'question_id', 'workspace_id', 'first_viewed_at', 'last_viewed_at',
        'last_graded_result', 'last_graded_attempt_id', 'is_favorite', 'needs_retry',
        'created_at', 'updated_at']);
select columns_are('public', 'practice_sessions',
  array['id', 'workspace_id', 'question_id', 'question_revision_id', 'user_id',
        'displayed_option_ids', 'shuffle_seed', 'state', 'opened_at', 'submitted_at',
        'graded_at', 'created_at', 'updated_at']);
select columns_are('public', 'question_attempts',
  array['id', 'workspace_id', 'question_id', 'question_revision_id', 'practice_session_id',
        'user_id', 'displayed_option_ids', 'submitted_answer', 'result', 'grading_method',
        'grades_attempt_id', 'graded_by', 'submitted_at', 'graded_at']);
select columns_are('public', 'question_lineage',
  array['id', 'workspace_id', 'parent_question_id', 'child_question_id',
        'source_question_revision_id', 'variation_type', 'generation_run_id', 'draft_id',
        'llm_model', 'prompt_version', 'source_block_ids', 'created_at']);
select columns_are('public', 'question_generation_runs',
  array['id', 'workspace_id', 'created_by', 'source_question_id', 'source_question_revision_id',
        'variation_types', 'candidate_count', 'async_job_id', 'status', 'llm_model',
        'prompt_version', 'params', 'finished_at', 'created_at', 'updated_at']);
select columns_are('public', 'question_import_runs',
  array['id', 'workspace_id', 'created_by', 'source_document_id', 'source_document_revision_id',
        'target_chapter_id', 'async_job_id', 'status', 'llm_model', 'prompt_version', 'params',
        'finished_at', 'created_at', 'updated_at']);
select columns_are('public', 'question_drafts',
  array['id', 'workspace_id', 'source_type', 'generation_run_id', 'import_run_id', 'position',
        'question_type', 'payload', 'validations', 'review_status', 'reviewed_by', 'reviewed_at',
        'published_question_id', 'created_at', 'updated_at',
        -- M4.4a (20261018100000)
        'question_number', 'is_multi_answer']);

select col_is_pk('public', 'question_user_states', array['user_id', 'question_id'],
  'question_user_states PK is (user_id, question_id)');
select col_is_pk('public', t, 'id', format('%s PK is id', t))
from unnest(array['questions', 'question_revisions', 'question_sources', 'practice_sessions',
                  'question_attempts', 'question_lineage', 'question_generation_runs',
                  'question_import_runs', 'question_drafts']) as t;

-- Composite (workspace-scoped) foreign keys
select fk_ok('public', 'question_revisions', array['workspace_id', 'question_id'],
             'public', 'questions', array['workspace_id', 'id']);
select fk_ok('public', 'questions', array['workspace_id', 'id', 'active_revision_id'],
             'public', 'question_revisions', array['workspace_id', 'question_id', 'id']);
select fk_ok('public', 'question_sources', array['workspace_id', 'question_id'],
             'public', 'questions', array['workspace_id', 'id']);
select fk_ok('public', 'question_attempts',
             array['workspace_id', 'question_id', 'question_revision_id'],
             'public', 'question_revisions', array['workspace_id', 'question_id', 'id']);
select fk_ok('public', 'question_attempts',
             array['practice_session_id', 'user_id', 'question_revision_id'],
             'public', 'practice_sessions', array['id', 'user_id', 'question_revision_id']);
select fk_ok('public', 'question_user_states',
             array['user_id', 'question_id', 'last_graded_attempt_id'],
             'public', 'question_attempts', array['user_id', 'question_id', 'id']);
select fk_ok('public', 'question_lineage', array['workspace_id', 'child_question_id'],
             'public', 'questions', array['workspace_id', 'id']);
select fk_ok('public', 'question_drafts', array['workspace_id', 'generation_run_id'],
             'public', 'question_generation_runs', array['workspace_id', 'id']);

select col_default_is('public', 'questions', 'publication_status', 'DRAFT'::text,
  'questions start as DRAFT');
select col_default_is('public', 'question_drafts', 'review_status', 'pending'::text,
  'drafts start pending review');

select has_index('public', 'questions', 'questions_overview_idx',
  array['workspace_id', 'publication_status', 'chapter_id', 'sort_order', 'created_at', 'id'],
  'overview index covers workspace, status and chapter order');
select has_index('public', 'question_user_states', 'question_user_states_user_workspace_idx',
  array['user_id', 'workspace_id'], 'user states are indexed by user and workspace');
select has_index('public', 'question_attempts', 'question_attempts_user_question_idx',
  'attempt history index exists');
select index_is_unique('public', 'question_revisions', 'question_revisions_question_version_key');

-- Security: RLS, grants -------------------------------------------------------------------------
select ok((select c.relrowsecurity from pg_class c where c.oid = format('public.%I', t)::regclass),
          format('RLS is enabled on %s', t))
from unnest(array['questions', 'question_revisions', 'question_sources', 'question_user_states',
                  'practice_sessions', 'question_attempts', 'question_lineage',
                  'question_generation_runs', 'question_import_runs', 'question_drafts']) as t;

select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
from unnest(array['questions', 'question_revisions', 'question_sources', 'question_user_states',
                  'practice_sessions', 'question_attempts', 'question_lineage',
                  'question_generation_runs', 'question_import_runs', 'question_drafts']) as t,
     unnest(array['anon', 'authenticated']) as r;

select table_privs_are('public', 'questions', 'quiz_api', array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'question_revisions', 'quiz_api', array['SELECT', 'INSERT']);
select table_privs_are('public', 'question_sources', 'quiz_api',
  array['SELECT', 'INSERT', 'DELETE']);
select table_privs_are('public', 'question_user_states', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'practice_sessions', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'question_attempts', 'quiz_api', array['SELECT', 'INSERT']);
select table_privs_are('public', 'question_lineage', 'quiz_api', array['SELECT', 'INSERT']);
select table_privs_are('public', 'question_generation_runs', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'question_import_runs', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'question_drafts', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);

select function_privs_are('public', 'question_options_valid', array['jsonb'], r, array[]::text[],
  format('%s cannot execute question_options_valid', r))
from unnest(array['anon', 'authenticated']) as r;

-- Fixtures (rolled back) ------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000041a1', 'm41-owner@example.test'),
  ('00000000-0000-4000-8000-0000000041a2', 'm41-other@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000041b1', 'm41 ws one', '00000000-0000-4000-8000-0000000041a1'),
  ('10000000-0000-4000-8000-0000000041b2', 'm41 ws two', '00000000-0000-4000-8000-0000000041a1');
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('20000000-0000-4000-8000-0000000041c1', '10000000-0000-4000-8000-0000000041b1', 'MCQ', 1),
  ('20000000-0000-4000-8000-0000000041c2', '10000000-0000-4000-8000-0000000041b1', 'MCQ', 2),
  ('20000000-0000-4000-8000-0000000041c3', '10000000-0000-4000-8000-0000000041b2', 'ESSAY', 1);
insert into public.question_revisions
  (id, workspace_id, question_id, version, stem, options, correct_option_ids) values
  ('30000000-0000-4000-8000-0000000041d1', '10000000-0000-4000-8000-0000000041b1',
   '20000000-0000-4000-8000-0000000041c1', 1, 'Which one?',
   '[{"id": "opt-a", "text": "A"}, {"id": "opt-b", "text": "B"}, {"id": "opt-c", "text": "C"}]',
   array['opt-b']),
  ('30000000-0000-4000-8000-0000000041d2', '10000000-0000-4000-8000-0000000041b1',
   '20000000-0000-4000-8000-0000000041c2', 1, 'Second?',
   '[{"id": "x", "text": "X"}, {"id": "y", "text": "Y"}]', array['x']),
  ('30000000-0000-4000-8000-0000000041d3', '10000000-0000-4000-8000-0000000041b2',
   '20000000-0000-4000-8000-0000000041c3', 1, 'Explain.', '[]', null);

-- Revisions: stable, unique option ids ----------------------------------------------------------
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem, options)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'dup', '[{"id": "a", "text": "A"}, {"id": "a", "text": "B"}]') $$,
  '23514', null, 'option ids must be unique within a revision');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem, options)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'no text', '[{"id": "a"}]') $$,
  '23514', null, 'every option needs text');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem, options)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'bad id', '[{"id": "has space", "text": "A"}]') $$,
  '23514', null, 'option ids are opaque tokens without whitespace');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem, options)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'object', '{"id": "a", "text": "A"}') $$,
  '23514', null, 'options must be a JSON array');
select throws_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'unknown answer', '[{"id": "a", "text": "A"}]', array['z']) $$,
  '23514', null, 'correct option ids must exist among the options');
select throws_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'two answers', '[{"id": "a", "text": "A"}, {"id": "b", "text": "B"}]',
             array['a', 'b']) $$,
  '23514', null, 'single-answer MCQ cannot have two correct options');
select throws_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids, is_multi_answer)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'dup answer', '[{"id": "a", "text": "A"}]', array['a', 'a'], true) $$,
  '23514', null, 'correct option ids are distinct');
select throws_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids, is_multi_answer)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'empty answer', '[{"id": "a", "text": "A"}]', array[]::text[], true) $$,
  '23514', null, 'a known answer is a non-empty set');
select lives_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids, is_multi_answer)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'multi', '[{"id": "a", "text": "A"}, {"id": "b", "text": "B"}]',
             array['a', 'b'], true) $$,
  'multi-answer MCQ accepts several correct options');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 2,
             'same version') $$,
  '23505', null, 'revision versions are unique per question');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem, accepted_answers)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 3,
             'blank accepted', array['ok', '  ']) $$,
  '23514', null, 'accepted answers cannot be blank');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 3,
             '   ') $$,
  '23514', null, 'blank stem is rejected');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c1', 3,
             'wrong workspace') $$,
  '23503', null, 'a revision cannot claim another workspace than its question');

-- Questions: status and active revision ---------------------------------------------------------
select throws_ok(
  $$ insert into public.questions (workspace_id, question_type)
     values ('10000000-0000-4000-8000-0000000041b1', 'TRUE_FALSE') $$,
  '23514', null, 'unknown question type is rejected');
select throws_ok(
  $$ update public.questions set publication_status = 'PUBLISHED'
     where id = '20000000-0000-4000-8000-0000000041c1' $$,
  '23514', null, 'unknown publication status is rejected');
select throws_ok(
  $$ update public.questions set publication_status = 'CONFIRMED'
     where id = '20000000-0000-4000-8000-0000000041c1' $$,
  '23514', null, 'CONFIRMED requires an active revision');
select throws_ok(
  $$ update public.questions set active_revision_id = '30000000-0000-4000-8000-0000000041d2'
     where id = '20000000-0000-4000-8000-0000000041c1' $$,
  '23503', null, 'active revision must belong to the same question');
select throws_ok(
  $$ update public.questions set active_revision_id = '30000000-0000-4000-8000-0000000041d3'
     where id = '20000000-0000-4000-8000-0000000041c1' $$,
  '23503', null, 'active revision cannot come from another workspace');
select lives_ok(
  $$ update public.questions
        set active_revision_id = '30000000-0000-4000-8000-0000000041d1',
            publication_status = 'CONFIRMED'
      where id = '20000000-0000-4000-8000-0000000041c1';
     update public.questions
        set active_revision_id = '30000000-0000-4000-8000-0000000041d2',
            publication_status = 'CONFIRMED'
      where id = '20000000-0000-4000-8000-0000000041c2' $$,
  'questions are confirmed with their own revision');
update public.questions set updated_at = '2000-01-01T00:00:00Z'
 where id = '20000000-0000-4000-8000-0000000041c1';
select is(
  (select updated_at from public.questions where id = '20000000-0000-4000-8000-0000000041c1'),
  now(), 'questions.updated_at is refreshed by the trigger');

-- Sources ---------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.question_sources
       (workspace_id, question_id, page_start, page_end, block_ids, locations)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             3, 4, array['blk-1', 'blk-2'], '[{"page": 3}]') $$,
  'a question source with page range and block ids is accepted');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c1') $$,
  '23503', null, 'a source cannot cross workspaces');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, page_start, page_end)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1', 5, 4) $$,
  '23514', null, 'page range must be ordered');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, page_start, page_end)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             null, -1) $$,
  '23514', null, 'page range rejects a missing start with a negative end');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, page_start, page_end)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             3, null) $$,
  '23514', null, 'page range rejects a start without an end');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, page_start, page_end)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             null, 5) $$,
  '23514', null, 'page range rejects an end without a start');
select throws_ok(
  $$ insert into public.question_sources (workspace_id, question_id, page_start, page_end)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             0, 1) $$,
  '23514', null, 'pages start at 1');

-- Practice sessions -----------------------------------------------------------------------------
insert into public.practice_sessions
  (id, workspace_id, question_id, question_revision_id, user_id, displayed_option_ids, shuffle_seed)
values
  ('40000000-0000-4000-8000-0000000041e1', '10000000-0000-4000-8000-0000000041b1',
   '20000000-0000-4000-8000-0000000041c1', '30000000-0000-4000-8000-0000000041d1',
   '00000000-0000-4000-8000-0000000041a1', array['opt-c', 'opt-a', 'opt-b'], 42),
  ('40000000-0000-4000-8000-0000000041e2', '10000000-0000-4000-8000-0000000041b2',
   '20000000-0000-4000-8000-0000000041c3', '30000000-0000-4000-8000-0000000041d3',
   '00000000-0000-4000-8000-0000000041a1', '{}', null),
  ('40000000-0000-4000-8000-0000000041e3', '10000000-0000-4000-8000-0000000041b1',
   '20000000-0000-4000-8000-0000000041c1', '30000000-0000-4000-8000-0000000041d1',
   '00000000-0000-4000-8000-0000000041a2', array['opt-a', 'opt-b', 'opt-c'], 7);

select throws_ok(
  $$ insert into public.practice_sessions
       (workspace_id, question_id, question_revision_id, user_id, displayed_option_ids)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '00000000-0000-4000-8000-0000000041a1',
             array['opt-a', 'opt-a']) $$,
  '23514', null, 'displayed option ids are distinct');
select throws_ok(
  $$ insert into public.practice_sessions (workspace_id, question_id, question_revision_id, user_id)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d2', '00000000-0000-4000-8000-0000000041a1') $$,
  '23503', null, 'a session pins a revision of its own question');
select throws_ok(
  $$ update public.practice_sessions set state = 'graded'
     where id = '40000000-0000-4000-8000-0000000041e1' $$,
  '23514', null, 'a graded session needs submitted_at and graded_at');

-- Attempts --------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.question_attempts
       (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        displayed_option_ids, submitted_answer, result, grading_method, graded_at)
     values ('50000000-0000-4000-8000-0000000041f1', '10000000-0000-4000-8000-0000000041b1',
             '20000000-0000-4000-8000-0000000041c1', '30000000-0000-4000-8000-0000000041d1',
             '40000000-0000-4000-8000-0000000041e1', '00000000-0000-4000-8000-0000000041a1',
             array['opt-c', 'opt-a', 'opt-b'], '{"option_ids": ["opt-b"]}', 'correct', 'auto',
             now()) $$,
  'an auto-graded attempt is recorded');
select lives_ok(
  $$ insert into public.question_attempts
       (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result)
     values ('50000000-0000-4000-8000-0000000041f2', '10000000-0000-4000-8000-0000000041b2',
             '20000000-0000-4000-8000-0000000041c3', '30000000-0000-4000-8000-0000000041d3',
             '40000000-0000-4000-8000-0000000041e2', '00000000-0000-4000-8000-0000000041a1',
             '{"text": "my essay"}', 'pending') $$,
  'an essay submission is recorded as pending');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c3',
             '30000000-0000-4000-8000-0000000041d3', '40000000-0000-4000-8000-0000000041e2',
             '00000000-0000-4000-8000-0000000041a1', '{"text": "x"}', 'pending', 'auto') $$,
  '23514', null, 'a pending attempt has no grading method');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e1',
             '00000000-0000-4000-8000-0000000041a1', '{}', 'correct', 'auto') $$,
  '23514', null, 'a graded attempt needs graded_at');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, graded_at)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e1',
             '00000000-0000-4000-8000-0000000041a1', '{}', 'correct', now()) $$,
  '23514', null, 'a graded attempt needs a grading method (null-safe CHECK)');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, graded_at, grades_attempt_id,
        graded_by)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c3',
             '30000000-0000-4000-8000-0000000041d3', '40000000-0000-4000-8000-0000000041e2',
             '00000000-0000-4000-8000-0000000041a1', '{}', 'incorrect', now(),
             '50000000-0000-4000-8000-0000000041f2', '00000000-0000-4000-8000-0000000041a1') $$,
  '23514', null, 'a grade of a pending attempt still needs a grading method');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e1',
             '00000000-0000-4000-8000-0000000041a1', '{}', 'skipped') $$,
  '23514', null, 'attempt result is correct, incorrect or pending');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e1',
             '00000000-0000-4000-8000-0000000041a2', '{}', 'pending') $$,
  '23503', null, 'an attempt must belong to the user who opened the session');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e1',
             '00000000-0000-4000-8000-0000000041a1', '{}', 'pending') $$,
  '23503', null, 'an attempt cannot cross workspaces');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method, graded_at)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c3',
             '30000000-0000-4000-8000-0000000041d3', '40000000-0000-4000-8000-0000000041e2',
             '00000000-0000-4000-8000-0000000041a1', '{"text": "my essay"}', 'correct', 'self',
             now()) $$,
  '23514', null, 'a self grade must reference the pending attempt it grades');
select lives_ok(
  $$ insert into public.question_attempts
       (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method, grades_attempt_id, graded_at)
     values ('50000000-0000-4000-8000-0000000041f3', '10000000-0000-4000-8000-0000000041b2',
             '20000000-0000-4000-8000-0000000041c3', '30000000-0000-4000-8000-0000000041d3',
             '40000000-0000-4000-8000-0000000041e2', '00000000-0000-4000-8000-0000000041a1',
             '{"text": "my essay"}', 'correct', 'self', '50000000-0000-4000-8000-0000000041f2',
             now()) $$,
  'self-grading appends a graded attempt for the pending one');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method, grades_attempt_id, graded_at)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c3',
             '30000000-0000-4000-8000-0000000041d3', '40000000-0000-4000-8000-0000000041e2',
             '00000000-0000-4000-8000-0000000041a1', '{"text": "my essay"}', 'incorrect', 'self',
             '50000000-0000-4000-8000-0000000041f2', now()) $$,
  '23505', null, 'a pending attempt is graded at most once');
select throws_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        submitted_answer, result, grading_method, grades_attempt_id, graded_at)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e3',
             '00000000-0000-4000-8000-0000000041a2', '{}', 'correct', 'reviewer',
             '50000000-0000-4000-8000-0000000041f1', now()) $$,
  '23503', null, 'a grade cannot target another user''s or revision''s attempt');

-- User state ------------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.question_user_states
       (user_id, question_id, workspace_id, first_viewed_at, last_viewed_at, last_graded_result,
        last_graded_attempt_id, needs_retry)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c1',
             '10000000-0000-4000-8000-0000000041b1', now(), now(), 'correct',
             '50000000-0000-4000-8000-0000000041f1', true) $$,
  'a user state records the last graded attempt');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id, is_favorite)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c1',
             '10000000-0000-4000-8000-0000000041b1', true) $$,
  '23505', null, 'one user state per (user, question)');
select lives_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id, is_favorite)
     values ('00000000-0000-4000-8000-0000000041a2', '20000000-0000-4000-8000-0000000041c1',
             '10000000-0000-4000-8000-0000000041b1', true) $$,
  'another user has an independent state for the same question');
select throws_ok(
  $$ insert into public.question_user_states
       (user_id, question_id, workspace_id, last_graded_result, last_graded_attempt_id)
     values ('00000000-0000-4000-8000-0000000041a2', '20000000-0000-4000-8000-0000000041c2',
             '10000000-0000-4000-8000-0000000041b1', 'correct',
             '50000000-0000-4000-8000-0000000041f1') $$,
  '23503', null, 'last graded attempt must be the user''s own attempt on that question');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id, last_graded_result)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c2',
             '10000000-0000-4000-8000-0000000041b1', 'correct') $$,
  '23514', null, 'a last graded result needs its attempt');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id, last_graded_result,
       last_graded_attempt_id)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c3',
             '10000000-0000-4000-8000-0000000041b2', 'pending',
             '50000000-0000-4000-8000-0000000041f2') $$,
  '23514', null, 'last graded result is correct or incorrect only');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c2',
             '10000000-0000-4000-8000-0000000041b2') $$,
  '23503', null, 'user state workspace must match the question');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id, last_viewed_at)
     values ('00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c2',
             '10000000-0000-4000-8000-0000000041b1', now()) $$,
  '23514', null, 'last_viewed_at requires first_viewed_at');

-- Generation / import runs, drafts and lineage -------------------------------------------------
insert into public.question_generation_runs
  (id, workspace_id, created_by, source_question_id, source_question_revision_id, variation_types)
values ('60000000-0000-4000-8000-000000004101', '10000000-0000-4000-8000-0000000041b1',
        '00000000-0000-4000-8000-0000000041a1', '20000000-0000-4000-8000-0000000041c1',
        '30000000-0000-4000-8000-0000000041d1', array['PARAPHRASE']);
insert into public.question_import_runs (id, workspace_id, created_by)
values ('60000000-0000-4000-8000-000000004102', '10000000-0000-4000-8000-0000000041b1',
        '00000000-0000-4000-8000-0000000041a1');

select throws_ok(
  $$ insert into public.question_generation_runs
       (workspace_id, source_question_id, source_question_revision_id, variation_types)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', array['OPTION_SHUFFLE']) $$,
  '23514', null, 'OPTION_SHUFFLE never creates a generation run');
select throws_ok(
  $$ insert into public.question_generation_runs
       (workspace_id, source_question_id, source_question_revision_id, variation_types)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', array['PARAPHRASE', null]) $$,
  '23514', null, 'variation types cannot contain null');

insert into public.async_jobs (id, workspace_id, job_type) values
  ('80000000-0000-4000-8000-000000004101', '10000000-0000-4000-8000-0000000041b1', 'question.import'),
  ('80000000-0000-4000-8000-000000004102', '10000000-0000-4000-8000-0000000041b2', 'question.import');
select throws_ok(
  $$ update public.question_import_runs set async_job_id = '80000000-0000-4000-8000-000000004102'
      where id = '60000000-0000-4000-8000-000000004102' $$,
  '23503', null, 'an import run cannot reference another workspace''s job');
select throws_ok(
  $$ update public.question_generation_runs
        set async_job_id = '80000000-0000-4000-8000-000000004102'
      where id = '60000000-0000-4000-8000-000000004101' $$,
  '23503', null, 'a generation run cannot reference another workspace''s job');
select lives_ok(
  $$ update public.question_import_runs set async_job_id = '80000000-0000-4000-8000-000000004101'
      where id = '60000000-0000-4000-8000-000000004102';
     update public.question_generation_runs
        set async_job_id = '80000000-0000-4000-8000-000000004101'
      where id = '60000000-0000-4000-8000-000000004101' $$,
  'runs reference a job of their own workspace');
delete from public.async_jobs where id = '80000000-0000-4000-8000-000000004101';
select results_eq(
  $$ select workspace_id, async_job_id from public.question_import_runs
      where id = '60000000-0000-4000-8000-000000004102'
     union all
     select workspace_id, async_job_id from public.question_generation_runs
      where id = '60000000-0000-4000-8000-000000004101' $$,
  $$ values ('10000000-0000-4000-8000-0000000041b1'::uuid, null::uuid),
            ('10000000-0000-4000-8000-0000000041b1'::uuid, null::uuid) $$,
  'deleting a job clears only the run''s job reference');
select throws_ok(
  $$ insert into public.question_generation_runs
       (workspace_id, source_question_id, source_question_revision_id, variation_types)
     values ('10000000-0000-4000-8000-0000000041b2', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', array['PARAPHRASE']) $$,
  '23503', null, 'a generation run cannot use another workspace''s question');
select throws_ok(
  $$ update public.question_import_runs set status = 'succeeded'
     where id = '60000000-0000-4000-8000-000000004102' $$,
  '23514', null, 'a finished run needs finished_at');

select lives_ok(
  $$ insert into public.question_drafts
       (id, workspace_id, source_type, generation_run_id, import_run_id, question_type, payload)
     values ('70000000-0000-4000-8000-000000004101', '10000000-0000-4000-8000-0000000041b1',
             'generation', '60000000-0000-4000-8000-000000004101', null, 'MCQ',
             '{"schema_version": 1, "stem": "Paraphrased?"}'),
            ('70000000-0000-4000-8000-000000004102', '10000000-0000-4000-8000-0000000041b1',
             'import', null, '60000000-0000-4000-8000-000000004102', 'SHORT_ANSWER',
             '{"schema_version": 1, "stem": "Imported?"}') $$,
  'generated and imported drafts are stored');
select is((select count(*)::int from public.questions
            where workspace_id = '10000000-0000-4000-8000-0000000041b1'), 2,
  'drafts do not create questions (no heatmap dot before approval)');
select throws_ok(
  $$ insert into public.question_drafts
       (workspace_id, source_type, generation_run_id, question_type, payload)
     values ('10000000-0000-4000-8000-0000000041b1', 'import',
             '60000000-0000-4000-8000-000000004101', 'MCQ', '{}') $$,
  '23514', null, 'draft source type must match its run');
select throws_ok(
  $$ insert into public.question_drafts
       (workspace_id, source_type, generation_run_id, question_type, payload)
     values ('10000000-0000-4000-8000-0000000041b2', 'generation',
             '60000000-0000-4000-8000-000000004101', 'MCQ', '{}') $$,
  '23503', null, 'a draft cannot attach to another workspace''s run');
select throws_ok(
  $$ update public.question_drafts
        set published_question_id = '20000000-0000-4000-8000-0000000041c2'
      where id = '70000000-0000-4000-8000-000000004101' $$,
  '23514', null, 'only an approved draft can be published');
select throws_ok(
  $$ update public.question_drafts set review_status = 'approved'
      where id = '70000000-0000-4000-8000-000000004101' $$,
  '23514', null, 'a reviewed draft records reviewed_at');
select throws_ok(
  $$ insert into public.question_user_states (user_id, question_id, workspace_id)
     values ('00000000-0000-4000-8000-0000000041a1', '70000000-0000-4000-8000-000000004101',
             '10000000-0000-4000-8000-0000000041b1') $$,
  '23503', null, 'a draft is not a question: no study state can reference it');
select throws_ok(
  $$ insert into public.question_revisions (workspace_id, question_id, version, stem)
     values ('10000000-0000-4000-8000-0000000041b1', '70000000-0000-4000-8000-000000004101', 1,
             'draft as question') $$,
  '23503', null, 'a draft is not a question: it has no revisions');
select throws_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '70000000-0000-4000-8000-000000004101', '30000000-0000-4000-8000-0000000041d1',
             'PARAPHRASE') $$,
  '23503', null, 'a draft is not a question: it cannot be a lineage child');

select lives_ok(
  $$ update public.question_drafts
        set review_status = 'approved', reviewed_at = now(),
            reviewed_by = '00000000-0000-4000-8000-0000000041a1',
            published_question_id = '20000000-0000-4000-8000-0000000041c2'
      where id = '70000000-0000-4000-8000-000000004101' $$,
  'an approved draft records the question it was published as');
select lives_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type, generation_run_id, draft_id, llm_model, prompt_version, source_block_ids)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '20000000-0000-4000-8000-0000000041c2', '30000000-0000-4000-8000-0000000041d1',
             'PARAPHRASE', '60000000-0000-4000-8000-000000004101',
             '70000000-0000-4000-8000-000000004101', 'fake-llm', 'gen-v1', array['blk-1']) $$,
  'lineage records parent revision, run, draft and generation provenance');
select throws_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '20000000-0000-4000-8000-0000000041c2', '30000000-0000-4000-8000-0000000041d1',
             'INVERT_POLARITY') $$,
  '23505', null, 'a child question has a single lineage parent');
select throws_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '20000000-0000-4000-8000-0000000041c1', '30000000-0000-4000-8000-0000000041d1',
             'PARAPHRASE') $$,
  '23514', null, 'a question is not its own variant');
select throws_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '20000000-0000-4000-8000-0000000041c3', '30000000-0000-4000-8000-0000000041d1',
             'PARAPHRASE') $$,
  '23503', null, 'lineage cannot cross workspaces');
select throws_ok(
  $$ insert into public.question_lineage
       (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
        variation_type)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c2',
             '20000000-0000-4000-8000-0000000041c1', '30000000-0000-4000-8000-0000000041d1',
             'PARAPHRASE') $$,
  '23503', null, 'lineage source revision must belong to the parent');

-- quiz_api: works within its grants; history is immutable ---------------------------------------
grant quiz_api to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select lives_ok(
  $$ insert into public.question_revisions
       (workspace_id, question_id, version, stem, options, correct_option_ids)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c2', 2,
             'edited', '[{"id": "x", "text": "X"}, {"id": "y", "text": "Y2"}]', array['y']) $$,
  'quiz_api can append a revision (CHECK helper functions are executable)');
select lives_ok(
  $$ insert into public.question_attempts
       (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
        displayed_option_ids, submitted_answer, result, grading_method, graded_at)
     values ('10000000-0000-4000-8000-0000000041b1', '20000000-0000-4000-8000-0000000041c1',
             '30000000-0000-4000-8000-0000000041d1', '40000000-0000-4000-8000-0000000041e3',
             '00000000-0000-4000-8000-0000000041a2', array['opt-a', 'opt-b', 'opt-c'],
             '{"option_ids": ["opt-a"]}', 'incorrect', 'auto', now()) $$,
  'quiz_api can append attempts');
select throws_ok($$ update public.question_attempts set result = 'correct' $$,
  '42501', null, 'quiz_api cannot rewrite attempts');
select throws_ok($$ delete from public.question_attempts $$,
  '42501', null, 'quiz_api cannot delete attempts');
select throws_ok($$ update public.question_revisions set stem = 'rewritten' $$,
  '42501', null, 'quiz_api cannot rewrite revisions');
select throws_ok($$ delete from public.question_revisions $$,
  '42501', null, 'quiz_api cannot delete revisions');
select throws_ok($$ update public.question_lineage set variation_type = 'INVERT_POLARITY' $$,
  '42501', null, 'quiz_api cannot rewrite lineage');
select throws_ok($$ delete from public.questions $$,
  '42501', null, 'quiz_api cannot hard-delete questions');
select throws_ok($$ delete from public.question_user_states $$,
  '42501', null, 'quiz_api cannot delete study state');
select throws_ok($$ delete from public.question_drafts $$,
  '42501', null, 'quiz_api cannot delete drafts');
select lives_ok(
  $$ update public.question_user_states set needs_retry = false
      where user_id = '00000000-0000-4000-8000-0000000041a1'
        and question_id = '20000000-0000-4000-8000-0000000041c1' $$,
  'quiz_api can toggle study flags');
reset role;

set local role anon;
select throws_ok($$ select * from public.questions $$, '42501', null,
  'anon cannot select questions');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.question_attempts $$, '42501', null,
  'authenticated cannot select attempts');
select throws_ok($$ select * from public.question_drafts $$, '42501', null,
  'authenticated cannot select drafts');
reset role;

select * from finish();
rollback;
