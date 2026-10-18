-- S3a (20261018170000): workspace_forks shape, privileges and the worker's commit function: the
-- published snapshot is copied with remapped ids in one call, personal data and drafts are not,
-- the link is re-checked first, a repeated commit is a no-op, terminal states are final. The
-- whole flow (API -> worker -> Storage/Qdrant) is covered by tests/integration/sharing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(52);

-- Shape -----------------------------------------------------------------------------------------
select columns_are('public', 'workspace_forks',
  array['id', 'source_workspace_id', 'source_share_link_id', 'target_workspace_id', 'forked_by',
        'name', 'async_job_id', 'source_snapshot_manifest', 'origin_attribution', 'status',
        'progress', 'last_error', 'created_at', 'updated_at', 'completed_at']);
select col_is_unique('public', 'workspace_forks', array['target_workspace_id'],
  'a workspace is the target of at most one fork');
select fk_ok('public', 'workspace_forks', 'forked_by', 'auth', 'users', 'id');
select fk_ok('public', 'workspace_forks', 'target_workspace_id', 'public', 'workspaces', 'id');
select has_trigger('public', 'workspace_forks', 'workspace_forks_guard', 'terminal-state guard');
select ok(
  (select prosecdef from pg_proc where oid = 'public.worker_fork_commit(uuid)'::regprocedure),
  'worker_fork_commit is SECURITY DEFINER');
select ok(
  (select prosecdef from pg_proc
    where oid = 'public.worker_fork_source_usable(uuid)'::regprocedure),
  'worker_fork_source_usable is SECURITY DEFINER');
select ok(
  not (select prosecdef from pg_proc
        where oid = 'public.worker_fork_documents(uuid)'::regprocedure),
  'worker_fork_documents runs with the caller''s privileges');

-- Privileges ------------------------------------------------------------------------------------
select table_privs_are('public', 'workspace_forks', r, array[]::text[],
  format('%s has no privileges on workspace_forks', r))
from unnest(array['anon', 'authenticated']) as r;
select table_privs_are('public', 'workspace_forks', 'quiz_api', array['SELECT', 'INSERT']);
select table_privs_are('public', 'workspace_forks', 'quiz_worker', array['SELECT']);
select ok(
  has_column_privilege('quiz_worker', 'public.workspace_forks', 'status', 'UPDATE')
  and has_column_privilege('quiz_worker', 'public.workspace_forks', 'progress', 'UPDATE')
  and not has_column_privilege('quiz_worker', 'public.workspace_forks', 'target_workspace_id',
                               'UPDATE')
  and not has_column_privilege('quiz_worker', 'public.workspace_forks', 'completed_at', 'UPDATE'),
  'quiz_worker moves status/progress only; it can never complete a fork itself');
select ok(
  has_function_privilege('quiz_worker', 'public.worker_fork_commit(uuid)', 'EXECUTE')
  and not has_function_privilege('quiz_api', 'public.worker_fork_commit(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.worker_fork_commit(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.worker_fork_source_usable(uuid)', 'EXECUTE'),
  'only quiz_worker runs the fork functions');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.workspace_forks'::regclass),
  'RLS is enabled on workspace_forks');

-- Fixtures (rolled back) ------------------------------------------------------------------------
-- owner ...f001, recipient ...f002; source workspace ...f001 with one document (revision 1
-- published and superseded, revision 2 published and active), two CONFIRMED questions (q1 in a
-- chapter of revision 2, q2 a variant of q1), one DRAFT and one soft-deleted question, owner
-- study state + attempt on q1, an import run with a draft, two share links (fork on / off).
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000f001', 's3a-owner@example.test'),
  ('00000000-0000-4000-8000-00000000f002', 's3a-recipient@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000000f001', 's3a source', '00000000-0000-4000-8000-00000000f001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f001', 'owner');

create function pg_temp.key(rev text) returns text language sql as $$
  select 'workspaces/10000000-0000-4000-8000-00000000f001/documents/'
         || '20000000-0000-4000-8000-00000000f001/revisions/' || rev || '/source.pdf'
$$;

insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001', 'Book',
   'book.pdf', 10, repeat('a', 64), pg_temp.key('30000000-0000-4000-8000-00000000f001'));
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, parent_revision_id, source_object_key,
   parsed_object_key, content_hash)
values
  ('30000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', 1, null,
   pg_temp.key('30000000-0000-4000-8000-00000000f001'),
   'workspaces/10000000-0000-4000-8000-00000000f001/documents/20000000-0000-4000-8000-00000000f001/revisions/30000000-0000-4000-8000-00000000f001/parsed_document.json',
   repeat('1', 64)),
  ('30000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', 2, '30000000-0000-4000-8000-00000000f001',
   pg_temp.key('30000000-0000-4000-8000-00000000f001'), null, repeat('2', 64));
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, parent_id, section_key, level, title)
values
  ('40000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', '30000000-0000-4000-8000-00000000f001', null,
   'sec-a', 1, 'A (old)'),
  ('40000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', '30000000-0000-4000-8000-00000000f002', null,
   'sec-a', 1, 'A'),
  ('40000000-0000-4000-8000-00000000f003', '10000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', '30000000-0000-4000-8000-00000000f002',
   '40000000-0000-4000-8000-00000000f002', 'sec-b', 2, 'B');
insert into public.content_blocks
  (workspace_id, document_id, document_revision_id, block_id, ordinal, chapter_id, block_type,
   text, page, provenance)
select '10000000-0000-4000-8000-00000000f001', '20000000-0000-4000-8000-00000000f001', rev,
       'blk-' || n, n, ch, 'text', 'text ' || n || ' of ' || rev, 1,
       '{"locations": [{"page": 1}]}'::jsonb
  from (values ('30000000-0000-4000-8000-00000000f001'::uuid,
                '40000000-0000-4000-8000-00000000f001'::uuid),
               ('30000000-0000-4000-8000-00000000f002'::uuid,
                '40000000-0000-4000-8000-00000000f003'::uuid)) as v(rev, ch),
       generate_series(0, 2) as n;
update public.document_revisions set status = 'published', published_at = now()
 where document_id = '20000000-0000-4000-8000-00000000f001';
update public.documents set active_revision_id = '30000000-0000-4000-8000-00000000f002',
       status = 'ready'
 where id = '20000000-0000-4000-8000-00000000f001';

insert into public.questions (id, workspace_id, chapter_id, question_type, sort_order) values
  ('50000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
   '40000000-0000-4000-8000-00000000f003', 'MCQ', 1),
  ('50000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-00000000f001', null, 'MCQ', 2),
  ('50000000-0000-4000-8000-00000000f003', '10000000-0000-4000-8000-00000000f001', null,
   'ESSAY', 3),
  ('50000000-0000-4000-8000-00000000f004', '10000000-0000-4000-8000-00000000f001', null,
   'ESSAY', 4);
insert into public.question_revisions
  (id, workspace_id, question_id, version, stem, options, correct_option_ids, explanation)
values
  ('60000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f001', 1, 'q1 v1',
   '[{"id": "o1", "text": "A"}, {"id": "o2", "text": "B"}]', '{o1}', 'old'),
  ('60000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f001', 2, 'q1 v2',
   '[{"id": "o1", "text": "A"}, {"id": "o2", "text": "B"}]', '{o2}', 'because B'),
  ('60000000-0000-4000-8000-00000000f003', '10000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f002', 1, 'q2',
   '[{"id": "x", "text": "X"}, {"id": "y", "text": "Y"}]', '{x}', null),
  ('60000000-0000-4000-8000-00000000f004', '10000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f003', 1, 'draft q', '[]', null, null),
  ('60000000-0000-4000-8000-00000000f005', '10000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f004', 1, 'deleted q', '[]', null, null);
update public.questions q set active_revision_id = v.rev, publication_status = v.status,
       deleted_at = v.deleted
  from (values ('50000000-0000-4000-8000-00000000f001'::uuid,
                '60000000-0000-4000-8000-00000000f002'::uuid, 'CONFIRMED', null::timestamptz),
               ('50000000-0000-4000-8000-00000000f002'::uuid,
                '60000000-0000-4000-8000-00000000f003'::uuid, 'CONFIRMED', null),
               ('50000000-0000-4000-8000-00000000f003'::uuid,
                '60000000-0000-4000-8000-00000000f004'::uuid, 'DRAFT', null),
               ('50000000-0000-4000-8000-00000000f004'::uuid,
                '60000000-0000-4000-8000-00000000f005'::uuid, 'CONFIRMED', now()))
       as v(q, rev, status, deleted)
 where q.id = v.q;
-- q1 cites revision 1 of the book (a revision that is not copied).
insert into public.question_sources
  (workspace_id, question_id, document_id, document_revision_id, page_start, page_end, block_ids)
values
  ('10000000-0000-4000-8000-00000000f001', '50000000-0000-4000-8000-00000000f001',
   '20000000-0000-4000-8000-00000000f001', '30000000-0000-4000-8000-00000000f001', 1, 1,
   '{blk-1}');
insert into public.question_lineage
  (workspace_id, parent_question_id, child_question_id, source_question_revision_id,
   variation_type)
values
  ('10000000-0000-4000-8000-00000000f001', '50000000-0000-4000-8000-00000000f001',
   '50000000-0000-4000-8000-00000000f002', '60000000-0000-4000-8000-00000000f001', 'PARAPHRASE');
insert into public.question_user_states (user_id, workspace_id, question_id, is_favorite,
                                         needs_retry)
values ('00000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
        '50000000-0000-4000-8000-00000000f001', true, true);
insert into public.question_import_runs (id, workspace_id, status, finished_at) values
  ('70000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001', 'succeeded',
   now());
insert into public.question_drafts (workspace_id, source_type, import_run_id, question_type,
                                    payload)
values ('10000000-0000-4000-8000-00000000f001', 'import', '70000000-0000-4000-8000-00000000f001',
        'ESSAY', '{}');
insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, allow_fork)
values
  ('80000000-0000-4000-8000-00000000f001', '10000000-0000-4000-8000-00000000f001',
   '00000000-0000-4000-8000-00000000f001', sha256('\xf1'::bytea), true),
  ('80000000-0000-4000-8000-00000000f002', '10000000-0000-4000-8000-00000000f001',
   '00000000-0000-4000-8000-00000000f001', sha256('\xf2'::bytea), false);

-- The API's request rows (one fork per link), pinning what the API pins: the active published
-- revision of the book and the active revision of each CONFIRMED live question.
create function pg_temp.fork(id text, link text, target text) returns text language sql as $$
  select format(
    'insert into public.workspace_forks (id, source_workspace_id, source_share_link_id, '
    'forked_by, name, source_snapshot_manifest, origin_attribution) values (%L, %L, %L, %L, %L, '
    '%L::jsonb, %L::jsonb)',
    id, '10000000-0000-4000-8000-00000000f001', link, '00000000-0000-4000-8000-00000000f002',
    'my fork',
    jsonb_build_object(
      'version', 1, 'id_salt', gen_random_uuid(), 'target_workspace_id', target,
      'documents', jsonb_build_array(jsonb_build_object(
        'document_id', '20000000-0000-4000-8000-00000000f001',
        'revision_id', '30000000-0000-4000-8000-00000000f002')),
      'questions', jsonb_build_array(
        jsonb_build_object('question_id', '50000000-0000-4000-8000-00000000f001',
                           'revision_id', '60000000-0000-4000-8000-00000000f002'),
        jsonb_build_object('question_id', '50000000-0000-4000-8000-00000000f002',
                           'revision_id', '60000000-0000-4000-8000-00000000f003'))),
    '{"source_workspace_name": "s3a source"}')
$$;

grant quiz_api to postgres;
grant quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api, quiz_worker;
grant execute on function pg_temp.fork(text, text, text) to quiz_api;

set local role quiz_api;
select lives_ok(
  pg_temp.fork('90000000-0000-4000-8000-00000000f001', '80000000-0000-4000-8000-00000000f001',
               'a0000000-0000-4000-8000-00000000f001'),
  'quiz_api records a fork request');
select lives_ok(
  pg_temp.fork('90000000-0000-4000-8000-00000000f002', '80000000-0000-4000-8000-00000000f002',
               'a0000000-0000-4000-8000-00000000f002'),
  'quiz_api records a fork request (link with fork off)');
select throws_ok(
  $$ update public.workspace_forks set status = 'COPYING' $$, '42501', null,
  'quiz_api cannot move a fork');
reset role;

-- Worker ----------------------------------------------------------------------------------------
set local role quiz_worker;
select ok(public.worker_fork_source_usable('90000000-0000-4000-8000-00000000f001'),
  'a fork-enabled link is usable');
select ok(not public.worker_fork_source_usable('90000000-0000-4000-8000-00000000f002'),
  'a link with fork off is not');
select is(
  (select count(*)::int from public.worker_fork_documents('90000000-0000-4000-8000-00000000f001')
    where target_object_key = 'workspaces/a0000000-0000-4000-8000-00000000f001/documents/'
          || target_document_id || '/revisions/' || target_revision_id || '/source.pdf'
      and source_parsed_object_key is null and target_parsed_object_key is null
      and target_document_id <> source_document_id),
  1, 'the copy plan names new ids and keys under the target workspace');
select lives_ok(
  $$ update public.workspace_forks set status = 'COPYING', progress = 10
      where id = '90000000-0000-4000-8000-00000000f001' $$,
  'quiz_worker marks a fork COPYING');
select throws_ok(
  $$ update public.workspace_forks set status = 'COMPLETED'
      where id = '90000000-0000-4000-8000-00000000f001' $$,
  null, null, 'quiz_worker cannot complete a fork');
select throws_ok(
  $$ insert into public.workspaces (name, owner_id)
     values ('x', '00000000-0000-4000-8000-00000000f002') $$,
  '42501', null, 'quiz_worker cannot create workspaces itself');
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f002'), 'unusable',
  'commit re-checks the link (fork off) and writes nothing');
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f001'), 'completed',
  'commit copies the snapshot');
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f001'), 'completed',
  'a repeated commit is a no-op');
reset role;

select is(
  (select (status, progress, target_workspace_id::text, completed_at is not null)::text
     from public.workspace_forks where id = '90000000-0000-4000-8000-00000000f001'),
  '(COMPLETED,100,a0000000-0000-4000-8000-00000000f001,t)', 'the fork is COMPLETED');
select is(
  (select (status, target_workspace_id)::text from public.workspace_forks
    where id = '90000000-0000-4000-8000-00000000f002'),
  '(PENDING,)', 'the unusable fork is untouched');
select is(
  (select count(*)::int from public.workspaces
    where id = 'a0000000-0000-4000-8000-00000000f002'
       or owner_id = '00000000-0000-4000-8000-00000000f002'),
  1, 'only the completed fork created a workspace');
select is(
  (select (name, owner_id, status)::text from public.workspaces
    where id = 'a0000000-0000-4000-8000-00000000f001'),
  '("my fork",00000000-0000-4000-8000-00000000f002,active)', 'the recipient owns the copy');
select results_eq(
  $$ select user_id::text, role from public.workspace_memberships
      where workspace_id = 'a0000000-0000-4000-8000-00000000f001' $$,
  $$ values ('00000000-0000-4000-8000-00000000f002', 'owner') $$,
  'the recipient is the only member');

-- Documents: one ready document whose revision 1 is the pinned revision 2.
select is(
  (select (d.status, r.revision_number, r.status, r.content_hash = repeat('2', 64),
           r.parent_revision_id is null, d.created_by = '00000000-0000-4000-8000-00000000f002',
           d.id <> '20000000-0000-4000-8000-00000000f001')::text
     from public.documents d join public.document_revisions r on r.id = d.active_revision_id
    where d.workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  '(ready,1,published,t,t,t,t)', 'the document is copied with its pinned revision as revision 1');
select is(
  (select count(*)::int from public.document_revisions
    where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  1, 'older revisions are not copied');
select results_eq(
  $$ select c.section_key, c.title, p.section_key from public.chapters c
       left join public.chapters p on p.id = c.parent_id
      where c.workspace_id = 'a0000000-0000-4000-8000-00000000f001' order by c.section_key $$,
  $$ values ('sec-a', 'A', null), ('sec-b', 'B', 'sec-a') $$,
  'the chapter tree is copied with remapped parents');
select results_eq(
  $$ select b.block_id, b.text, c.section_key from public.content_blocks b
       join public.chapters c on c.id = b.chapter_id
      where b.workspace_id = 'a0000000-0000-4000-8000-00000000f001' order by b.ordinal $$,
  $$ select 'blk-' || n, 'text ' || n || ' of 30000000-0000-4000-8000-00000000f002', 'sec-b'
       from generate_series(0, 2) n $$,
  'blocks keep their block ids and text, chapters are remapped');

-- Questions: the two CONFIRMED ones, nothing else.
select results_eq(
  $$ select r.stem, q.publication_status, r.version, r.correct_option_ids::text, r.explanation,
            q.created_by::text
       from public.questions q join public.question_revisions r on r.id = q.active_revision_id
      where q.workspace_id = 'a0000000-0000-4000-8000-00000000f001' order by q.sort_order $$,
  $$ values ('q1 v2', 'CONFIRMED', 1, '{o2}', 'because B', '00000000-0000-4000-8000-00000000f002'),
            ('q2', 'CONFIRMED', 1, '{x}', null, '00000000-0000-4000-8000-00000000f002') $$,
  'confirmed questions are copied at their pinned revision');
select is(
  (select count(*)::int from public.question_revisions
    where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  2, 'one revision per copied question');
select is(
  (select c.section_key || ':' || c.workspace_id::text from public.questions q
     join public.chapters c on c.id = q.chapter_id
    where q.workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  'sec-b:a0000000-0000-4000-8000-00000000f001', 'the question chapter points into the copy');
select is(
  (select count(*)::int from public.questions
    where workspace_id = 'a0000000-0000-4000-8000-00000000f001'
      and id in ('50000000-0000-4000-8000-00000000f001', '50000000-0000-4000-8000-00000000f002')),
  0, 'copied questions get new ids');
select is(
  (select (s.document_id = d.id, s.document_revision_id = d.active_revision_id, s.block_ids)::text
     from public.question_sources s
     join public.documents d on d.workspace_id = s.workspace_id
    where s.workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  '(t,t,{blk-1})', 'sources point at the copied document and revision');
select is(
  (select (l.variation_type, l.source_question_revision_id = p.active_revision_id,
           l.generation_run_id is null and l.draft_id is null)::text
     from public.question_lineage l join public.questions p on p.id = l.parent_question_id
    where l.workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
  '(PARAPHRASE,t,t)', 'lineage between copied questions is remapped');

-- Personal data, drafts, links, activity and jobs.
select is(
  (select array[
     (select count(*) from public.question_user_states
       where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
     (select count(*) from public.question_drafts
       where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
     (select count(*) from public.question_import_runs
       where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
     (select count(*) from public.workspace_share_links
       where workspace_id = 'a0000000-0000-4000-8000-00000000f001'),
     (select count(*) from public.activity_events
       where workspace_id = 'a0000000-0000-4000-8000-00000000f001'
         and actor_id = '00000000-0000-4000-8000-00000000f001')]::int[]),
  array[0, 0, 0, 0, 0], 'no study state, drafts, runs, share links or owner activity');
select results_eq(
  $$ select job_type, idempotency_key = 'index_sync:' || (payload ->> 'revision_id'), status,
            created_by::text
       from public.async_jobs where workspace_id = 'a0000000-0000-4000-8000-00000000f001' $$,
  $$ values ('document.index_sync', true, 'queued', '00000000-0000-4000-8000-00000000f002') $$,
  'the copied revision has an index_sync obligation');
select is(
  (select count(*)::int from public.questions
    where workspace_id = '10000000-0000-4000-8000-00000000f001'),
  4, 'the source is untouched');

-- Terminal states are final; the request is immutable.
select throws_ok(
  $$ update public.workspace_forks set status = 'CANCELLED'
      where id = '90000000-0000-4000-8000-00000000f001' $$,
  '23514', null, 'a COMPLETED fork cannot be cancelled');
select throws_ok(
  $$ update public.workspace_forks set name = 'other'
      where id = '90000000-0000-4000-8000-00000000f002' $$,
  '23514', null, 'the request is immutable');
update public.workspace_forks set status = 'CANCELLED'
 where id = '90000000-0000-4000-8000-00000000f002';
set local role quiz_worker;
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f002'), 'cancelled',
  'a cancelled fork is never committed');
select ok(not public.worker_fork_source_usable('90000000-0000-4000-8000-00000000f002'),
  'a cancelled fork is not running');
reset role;

-- A revoked link stops a running fork; a completed one survives revoke and source deletion.
select lives_ok(
  pg_temp.fork('90000000-0000-4000-8000-00000000f003', '80000000-0000-4000-8000-00000000f001',
               'a0000000-0000-4000-8000-00000000f003'),
  'another fork of the same link');
update public.workspace_share_links set revoked_at = now()
 where id = '80000000-0000-4000-8000-00000000f001';
set local role quiz_worker;
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f003'), 'unusable',
  'a revoked link cancels a fork that has not committed');
reset role;
update public.workspaces set status = 'deleted', deleted_at = now()
 where id = '10000000-0000-4000-8000-00000000f001';
select is(
  (select (f.status, w.status, w.owner_id)::text
     from public.workspace_forks f join public.workspaces w on w.id = f.target_workspace_id
    where f.id = '90000000-0000-4000-8000-00000000f001'),
  '(COMPLETED,active,00000000-0000-4000-8000-00000000f002)',
  'the completed fork survives the deletion of its source');

select * from finish();
rollback;
