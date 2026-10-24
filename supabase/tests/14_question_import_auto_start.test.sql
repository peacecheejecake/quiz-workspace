-- QIMP-AUTO (20261021120000): worker_start_question_import starts one system run per question
-- paper, attributed to the given user in the document's workspace, and only for quiz_worker.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a7001', 'qauto-owner@example.test'),
  ('00000000-0000-4000-8000-0000000a7002', 'qauto-viewer@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000a7001', 'auto ws', '00000000-0000-4000-8000-0000000a7001'),
  ('10000000-0000-4000-8000-0000000a7002', 'archived ws', '00000000-0000-4000-8000-0000000a7001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000a7001', '00000000-0000-4000-8000-0000000a7001', 'owner'),
  ('10000000-0000-4000-8000-0000000a7001', '00000000-0000-4000-8000-0000000a7002', 'viewer'),
  ('10000000-0000-4000-8000-0000000a7002', '00000000-0000-4000-8000-0000000a7001', 'owner');

-- d1: question paper (active ws), d2: book (active ws), d3: question paper (archived ws).
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
select d.id::uuid, d.ws::uuid, 'Doc', 'doc.pdf', 10, repeat('a', 64), 'workspaces/' || d.ws || '/documents/' || d.id || '/revisions/' || r_id || '/source.pdf',
       '00000000-0000-4000-8000-0000000a7001', d.kind
  from (values
    ('20000000-0000-4000-8000-0000000a7001', '10000000-0000-4000-8000-0000000a7001', 'question_paper'),
    ('20000000-0000-4000-8000-0000000a7002', '10000000-0000-4000-8000-0000000a7001', 'book'),
    ('20000000-0000-4000-8000-0000000a7003', '10000000-0000-4000-8000-0000000a7002', 'question_paper')
  ) as d (id, ws, kind)
  cross join lateral (select '30000000' || substr(d.id, 9) as r_id) r;
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by, status, content_hash,
                                       published_at)
select r.id::uuid, r.ws::uuid, r.doc::uuid, 1,
       'workspaces/' || r.ws || '/documents/' || r.doc || '/revisions/' || r.id || '/source.pdf',
       '00000000-0000-4000-8000-0000000a7001', 'published', repeat('b', 64), now()
  from (values
    ('30000000-0000-4000-8000-0000000a7001', '10000000-0000-4000-8000-0000000a7001', '20000000-0000-4000-8000-0000000a7001'),
    ('30000000-0000-4000-8000-0000000a7002', '10000000-0000-4000-8000-0000000a7001', '20000000-0000-4000-8000-0000000a7002'),
    ('30000000-0000-4000-8000-0000000a7003', '10000000-0000-4000-8000-0000000a7002', '20000000-0000-4000-8000-0000000a7003')
  ) as r (id, ws, doc);
update public.documents d set active_revision_id = r.id, status = 'ready'
  from public.document_revisions r where r.document_id = d.id
   and d.id::text like '20000000-0000-4000-8000-0000000a700%';
update public.workspaces set status = 'archived', archived_at = now()
 where id = '10000000-0000-4000-8000-0000000a7002';

-- Schema / privileges ---------------------------------------------------------------------------
select col_default_is('public', 'question_import_runs', 'started_by', 'user',
  'runs are user-started by default');
select throws_ok(
  $$ insert into public.question_import_runs (workspace_id, started_by)
     values ('10000000-0000-4000-8000-0000000a7001', 'robot') $$,
  '23514', null, 'started_by is user or system');
select ok(has_function_privilege('quiz_worker',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute'), 'quiz_worker may start');
select ok(not has_function_privilege('quiz_api',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon',
  'public.worker_start_question_import(uuid, uuid, uuid)', 'execute'), 'nobody else may');
select ok(not has_table_privilege('quiz_worker', 'public.question_import_runs', 'insert'),
  'quiz_worker still cannot insert runs directly');

-- Behaviour as quiz_worker ----------------------------------------------------------------------
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
create temporary table started on commit drop as
select * from public.worker_start_question_import('20000000-0000-4000-8000-0000000a7001',
  '30000000-0000-4000-8000-0000000a7001', '00000000-0000-4000-8000-0000000a7001');
select is((select count(*)::int from started), 1, 'a ready question paper starts one run');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000a7001', '30000000-0000-4000-8000-0000000a7001',
  '00000000-0000-4000-8000-0000000a7001')), 0, 'a second call starts nothing');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000a7002', '30000000-0000-4000-8000-0000000a7002',
  '00000000-0000-4000-8000-0000000a7001')), 0, 'a book starts nothing');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000a7003', '30000000-0000-4000-8000-0000000a7003',
  '00000000-0000-4000-8000-0000000a7001')), 0, 'an archived workspace starts nothing');
reset role;

select results_eq(
  $$ select r.workspace_id, r.created_by, r.source_document_id, r.source_document_revision_id,
            r.status, r.started_by
       from public.question_import_runs r join started s on s.run_id = r.id $$,
  $$ values ('10000000-0000-4000-8000-0000000a7001'::uuid,
             '00000000-0000-4000-8000-0000000a7001'::uuid,
             '20000000-0000-4000-8000-0000000a7001'::uuid,
             '30000000-0000-4000-8000-0000000a7001'::uuid, 'queued'::text, 'system'::text) $$,
  'the run is the uploader''s, in the document''s workspace, pinned to the revision');
select results_eq(
  $$ select j.job_type, j.created_by, j.idempotency_key, j.payload, j.status,
            j.published_at is null
       from public.async_jobs j join started s on s.job_id = j.id $$,
  $$ select 'question.import'::text, '00000000-0000-4000-8000-0000000a7001'::uuid,
            'question_import:' || run_id::text || ':1',
            jsonb_build_object('import_id', run_id::text), 'queued'::text, true
       from started $$,
  'its first question.import job uses the API key scheme and is not yet published');
select is((select async_job_id from public.question_import_runs r join started s on s.run_id = r.id),
  (select job_id from started), 'the run points at the job');
select is((select count(*)::int from public.activity_events a join started s on s.run_id = a.target_id
            where a.event_type = 'question_import.started'
              and a.actor_id = '00000000-0000-4000-8000-0000000a7001'), 1,
  'the start is recorded for the uploader');

-- A viewer is not writable; a document that already has a (user) run is never auto-started.
delete from public.question_import_runs where workspace_id = '10000000-0000-4000-8000-0000000a7001';
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000a7001', '30000000-0000-4000-8000-0000000a7001',
  '00000000-0000-4000-8000-0000000a7002')), 0, 'a viewer cannot start one');
insert into public.question_import_runs (workspace_id, created_by, source_document_id,
                                         source_document_revision_id)
values ('10000000-0000-4000-8000-0000000a7001', '00000000-0000-4000-8000-0000000a7001',
        '20000000-0000-4000-8000-0000000a7001', '30000000-0000-4000-8000-0000000a7001');
select is((select count(*)::int from public.worker_start_question_import(
  '20000000-0000-4000-8000-0000000a7001', '30000000-0000-4000-8000-0000000a7001',
  '00000000-0000-4000-8000-0000000a7001')), 0, 'a document with a run starts nothing');
select throws_ok(
  $$ insert into public.question_import_runs (workspace_id, source_document_id, started_by)
     values ('10000000-0000-4000-8000-0000000a7001', '20000000-0000-4000-8000-0000000a7001',
             'system'),
            ('10000000-0000-4000-8000-0000000a7001', '20000000-0000-4000-8000-0000000a7001',
             'system') $$,
  '23505', null, 'at most one system-started run per document');

select * from finish();
rollback;
