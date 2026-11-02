-- RELSRC-B (20261103160000_related_sources.sql): stored related-passage lists keyed by
-- (revision, corpus fingerprint, retrieval version), references only, one current list per
-- question, quiz_api only (RELSRC-01-C03, C07).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

select has_table('public', 'question_related_sources', 'question_related_sources exists');
select has_table('public', 'mock_exam_question_related_sources',
  'mock_exam_question_related_sources exists');
select columns_are('public', 'question_related_sources',
  array['id', 'workspace_id', 'question_id', 'question_revision_id', 'corpus_fingerprint',
        'retrieval_version', 'items', 'superseded_at', 'created_at'],
  'question lists hold references only (no passage text, stem or query column)');
select columns_are('public', 'mock_exam_question_related_sources',
  array['id', 'workspace_id', 'mock_exam_question_id', 'mock_exam_question_revision_id',
        'corpus_fingerprint', 'retrieval_version', 'items', 'superseded_at', 'created_at'],
  'mock lists hold references only');
select col_is_unique('public', 'question_related_sources',
  array['question_revision_id', 'corpus_fingerprint', 'retrieval_version'],
  'one question list per key');
select col_is_unique('public', 'mock_exam_question_related_sources',
  array['mock_exam_question_revision_id', 'corpus_fingerprint', 'retrieval_version'],
  'one mock list per key');
select index_is_unique('public', 'question_related_sources', 'question_related_sources_one_current');
select index_is_unique('public', 'mock_exam_question_related_sources',
  'mock_exam_question_related_sources_one_current');
select fk_ok('public', 'question_related_sources',
             array['workspace_id', 'question_id', 'question_revision_id'],
             'public', 'question_revisions', array['workspace_id', 'question_id', 'id'],
  'a list belongs to a revision of its own question and workspace');
select fk_ok('public', 'mock_exam_question_related_sources',
             array['workspace_id', 'mock_exam_question_id', 'mock_exam_question_revision_id'],
             'public', 'mock_exam_question_revisions',
             array['workspace_id', 'mock_exam_question_id', 'id'],
  'a mock list belongs to a revision of its own mock question and workspace');
select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
from unnest(array['question_related_sources', 'mock_exam_question_related_sources']) as t,
     unnest(array['anon', 'authenticated', 'quiz_worker']) as r;
select table_privs_are('public', t, 'quiz_api', array['SELECT', 'INSERT'],
  format('quiz_api reads and inserts %s (updates superseded_at only)', t))
from unnest(array['question_related_sources', 'mock_exam_question_related_sources']) as t;
select ok(has_column_privilege('quiz_api', 'public.question_related_sources', 'superseded_at',
                               'update')
          and not has_column_privilege('quiz_api', 'public.question_related_sources', 'items',
                                       'update'),
  'quiz_api may supersede a list but never rewrite it');

-- Fixtures (superuser; rolled back) ------------------------------------------------------------
grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a261', 'relsrc-pgtap@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('00000000-0000-4000-8000-00000000a262', 'relsrc pgtap',
   '00000000-0000-4000-8000-00000000a261');
insert into public.questions (id, workspace_id, question_type) values
  ('00000000-0000-4000-8000-00000000a263', '00000000-0000-4000-8000-00000000a262', 'ESSAY');
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('00000000-0000-4000-8000-00000000a264', '00000000-0000-4000-8000-00000000a262',
   '00000000-0000-4000-8000-00000000a263', 1, 'stem');

set local role quiz_api;
select lives_ok($$
  insert into public.question_related_sources (workspace_id, question_id, question_revision_id,
    corpus_fingerprint, retrieval_version, items)
  values ('00000000-0000-4000-8000-00000000a262', '00000000-0000-4000-8000-00000000a263',
          '00000000-0000-4000-8000-00000000a264', repeat('a', 64), 'a1', '[{"rank": 1}]') $$,
  'quiz_api stores a list');
select throws_ok($$
  insert into public.question_related_sources (workspace_id, question_id, question_revision_id,
    corpus_fingerprint, retrieval_version)
  values ('00000000-0000-4000-8000-00000000a262', '00000000-0000-4000-8000-00000000a263',
          '00000000-0000-4000-8000-00000000a264', repeat('a', 64), 'a1') $$,
  '23505', null, 'the same key twice is refused');
select throws_ok($$
  insert into public.question_related_sources (workspace_id, question_id, question_revision_id,
    corpus_fingerprint, retrieval_version)
  values ('00000000-0000-4000-8000-00000000a262', '00000000-0000-4000-8000-00000000a263',
          '00000000-0000-4000-8000-00000000a264', repeat('b', 64), 'a1') $$,
  '23505', null, 'a second current list of the same question is refused');
select lives_ok($$
  update public.question_related_sources set superseded_at = now()
   where question_id = '00000000-0000-4000-8000-00000000a263' $$,
  'quiz_api supersedes the old key');
select lives_ok($$
  insert into public.question_related_sources (workspace_id, question_id, question_revision_id,
    corpus_fingerprint, retrieval_version)
  values ('00000000-0000-4000-8000-00000000a262', '00000000-0000-4000-8000-00000000a263',
          '00000000-0000-4000-8000-00000000a264', repeat('b', 64), 'a1') $$,
  'then the new key is the current list');
select throws_ok($$
  insert into public.question_related_sources (workspace_id, question_id, question_revision_id,
    corpus_fingerprint, retrieval_version, superseded_at)
  values ('00000000-0000-4000-8000-00000000a262', '00000000-0000-4000-8000-00000000a263',
          '00000000-0000-4000-8000-00000000a264', 'not-a-sha', 'a1', now()) $$,
  '23514', null, 'the fingerprint is a hex SHA-256');
reset role;

select is((select count(*)::int from public.question_related_sources
            where question_id = '00000000-0000-4000-8000-00000000a263'), 2,
  'old keys are kept');
delete from public.questions where id = '00000000-0000-4000-8000-00000000a263';
select is((select count(*)::int from public.question_related_sources
            where question_id = '00000000-0000-4000-8000-00000000a263'), 0,
  'lists go with their question');

select * from finish();
rollback;
