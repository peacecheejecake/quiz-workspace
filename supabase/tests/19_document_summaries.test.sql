-- DOCSUM-B (20261029120000): summary runs/units, worker_start_document_summary (opted-in books
-- only, one live run per revision, supersedes older unfinished runs) and the role grants.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

-- Schema -----------------------------------------------------------------------------------------
select columns_are('public', 'document_summary_runs',
  array['id', 'workspace_id', 'document_id', 'document_revision_id', 'status', 'trigger', 'job_id',
        'prompt_version', 'model', 'error_code', 'usage', 'progress', 'created_by', 'created_at',
        'started_at', 'finished_at']);
select columns_are('public', 'document_summary_units',
  array['id', 'workspace_id', 'document_id', 'scope', 'section_key', 'input_hash',
        'prompt_version', 'model', 'body', 'page_from', 'page_to', 'usage',
        'generated_by_run_id', 'created_at']);
select columns_are('public', 'document_summary_run_units',
  array['workspace_id', 'run_id', 'unit_id', 'position']);
select has_index('public', 'document_summary_runs', 'document_summary_runs_live_revision_key',
  'one live run per revision');

-- Privileges -------------------------------------------------------------------------------------
select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
  from unnest(array['document_summary_runs', 'document_summary_units',
                    'document_summary_run_units']) as t,
       unnest(array['anon', 'authenticated']) as r;
select table_privs_are('public', 'document_summary_runs', 'quiz_api',
  array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'document_summary_units', 'quiz_api', array['SELECT']);
select table_privs_are('public', 'document_summary_run_units', 'quiz_api', array['SELECT']);
select table_privs_are('public', 'document_summary_runs', 'quiz_worker', array['SELECT']);
select table_privs_are('public', 'document_summary_units', 'quiz_worker',
  array['SELECT', 'INSERT']);
select table_privs_are('public', 'document_summary_run_units', 'quiz_worker',
  array['SELECT', 'INSERT']);
select ok(has_column_privilege('quiz_worker', 'public.document_summary_runs', 'status', 'update')
  and not has_column_privilege('quiz_worker', 'public.document_summary_runs',
                               'document_revision_id', 'update'),
  'quiz_worker moves a run''s state only');
select ok(has_function_privilege('quiz_worker',
  'public.worker_start_document_summary(uuid, uuid, boolean)', 'execute'), 'quiz_worker may start');
select ok(not has_function_privilege('quiz_api',
  'public.worker_start_document_summary(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated',
  'public.worker_start_document_summary(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('anon',
  'public.worker_start_document_summary(uuid, uuid, boolean)', 'execute'), 'nobody else may');

-- Fixtures (rolled back) -------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000d5001', 'docsum-owner@example.test'),
  ('00000000-0000-4000-8000-0000000d5002', 'docsum-editor@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000d5001', 'summary ws', '00000000-0000-4000-8000-0000000d5001'),
  ('10000000-0000-4000-8000-0000000d5002', 'archived ws', '00000000-0000-4000-8000-0000000d5001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000d5001', '00000000-0000-4000-8000-0000000d5001', 'owner'),
  ('10000000-0000-4000-8000-0000000d5001', '00000000-0000-4000-8000-0000000d5002', 'editor'),
  ('10000000-0000-4000-8000-0000000d5002', '00000000-0000-4000-8000-0000000d5001', 'owner');

-- d1: opted-in book, d2: book never opted in, d3: opted-in question paper, d4: opted-in book in
-- an archived workspace. Each has a published revision 1 (r..01) and d1 a revision 2 (r..05).
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type, summary_enabled_at,
                              summary_enabled_by)
select d.id::uuid, d.ws::uuid, 'Doc', 'doc.pdf', 10, repeat('a', 64),
       'workspaces/' || d.ws || '/documents/' || d.id || '/revisions/' || '3' || substr(d.id, 2)
         || '/source.pdf',
       '00000000-0000-4000-8000-0000000d5001', d.kind,
       case when d.opted then now() end,
       case when d.opted then '00000000-0000-4000-8000-0000000d5002'::uuid end
  from (values
    ('20000000-0000-4000-8000-0000000d5001', '10000000-0000-4000-8000-0000000d5001', 'book', true),
    ('20000000-0000-4000-8000-0000000d5002', '10000000-0000-4000-8000-0000000d5001', 'book', false),
    ('20000000-0000-4000-8000-0000000d5003', '10000000-0000-4000-8000-0000000d5001',
     'question_paper', true),
    ('20000000-0000-4000-8000-0000000d5004', '10000000-0000-4000-8000-0000000d5002', 'book', true)
  ) as d (id, ws, kind, opted);
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       parent_revision_id, source_object_key, created_by, status,
                                       content_hash, published_at)
select r.id::uuid, r.ws::uuid, r.doc::uuid, r.n, r.parent::uuid,
       'workspaces/' || r.ws || '/documents/' || r.doc || '/revisions/' || '3' || substr(r.doc, 2)
         || '/source.pdf',
       '00000000-0000-4000-8000-0000000d5001', 'published', repeat('b', 64), now()
  from (values
    ('30000000-0000-4000-8000-0000000d5001', '10000000-0000-4000-8000-0000000d5001',
     '20000000-0000-4000-8000-0000000d5001', 1, null),
    ('30000000-0000-4000-8000-0000000d5002', '10000000-0000-4000-8000-0000000d5001',
     '20000000-0000-4000-8000-0000000d5002', 1, null),
    ('30000000-0000-4000-8000-0000000d5003', '10000000-0000-4000-8000-0000000d5001',
     '20000000-0000-4000-8000-0000000d5003', 1, null),
    ('30000000-0000-4000-8000-0000000d5004', '10000000-0000-4000-8000-0000000d5002',
     '20000000-0000-4000-8000-0000000d5004', 1, null),
    ('30000000-0000-4000-8000-0000000d5005', '10000000-0000-4000-8000-0000000d5001',
     '20000000-0000-4000-8000-0000000d5001', 2, '30000000-0000-4000-8000-0000000d5001')
  ) as r (id, ws, doc, n, parent);
update public.documents d
   set active_revision_id = (select r.id from public.document_revisions r
                              where r.document_id = d.id order by r.revision_number desc limit 1),
       status = 'ready'
 where d.id::text like '20000000-0000-4000-8000-0000000d500%';
update public.workspaces set status = 'archived', archived_at = now()
 where id = '10000000-0000-4000-8000-0000000d5002';

-- An unfinished run of d1's revision 1, to be superseded by revision 2's run.
insert into public.document_summary_runs (id, workspace_id, document_id, document_revision_id,
                                          status, trigger, started_at)
values ('40000000-0000-4000-8000-0000000d5001', '10000000-0000-4000-8000-0000000d5001',
        '20000000-0000-4000-8000-0000000d5001', '30000000-0000-4000-8000-0000000d5001',
        'running', 'manual', now());

-- Constraints ------------------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5001',
             '30000000-0000-4000-8000-0000000d5001', 'manual') $$,
  '23505', null, 'a revision has one live run');
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger, status)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5001',
             '30000000-0000-4000-8000-0000000d5001', 'manual', 'paused') $$,
  '23514', null, 'status is one of the run states');
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger, status, error_code)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5002',
             '30000000-0000-4000-8000-0000000d5002', 'manual', 'queued', 'llm_unavailable') $$,
  '23514', null, 'only a failed run has an error code');
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger, status, finished_at, error_code)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5002',
             '30000000-0000-4000-8000-0000000d5002', 'manual', 'failed', now(),
             'The provider said: <book text>') $$,
  '23514', null, 'an error code is a code, never provider text');
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger)
     values ('10000000-0000-4000-8000-0000000d5002', '20000000-0000-4000-8000-0000000d5002',
             '30000000-0000-4000-8000-0000000d5002', 'manual') $$,
  '23503', null, 'a run stays in its document''s workspace');
insert into public.document_summary_units (workspace_id, document_id, scope, section_key,
                                           input_hash, prompt_version, model, body)
values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5001', 'chapter',
        'ch1', repeat('c', 64), 'docsum-v1', 'fake', '{}');
select throws_ok(
  $$ insert into public.document_summary_units (workspace_id, document_id, scope, section_key,
                                                input_hash, prompt_version, model, body)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5001',
             'chapter', 'ch1', repeat('c', 64), 'docsum-v1', 'fake', '{}') $$,
  '23505', null, 'units are content-addressed per document');
select lives_ok(
  $$ insert into public.document_summary_units (workspace_id, document_id, scope, section_key,
                                                input_hash, prompt_version, model, body)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5002',
             'chapter', 'ch1', repeat('c', 64), 'docsum-v1', 'fake', '{}') $$,
  'the same content in another document is its own unit');
select throws_ok(
  $$ insert into public.document_summary_units (workspace_id, document_id, scope, section_key,
                                                input_hash, prompt_version, model, body,
                                                page_from, page_to)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5001',
             'chapter', 'ch2', repeat('d', 64), 'docsum-v1', 'fake', '{}', 5, 4) $$,
  '23514', null, 'a unit''s page range is ordered');

-- worker_start_document_summary as quiz_worker ---------------------------------------------------
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select throws_ok(
  $$ insert into public.document_summary_runs (workspace_id, document_id, document_revision_id,
                                               trigger)
     values ('10000000-0000-4000-8000-0000000d5001', '20000000-0000-4000-8000-0000000d5002',
             '30000000-0000-4000-8000-0000000d5002', 'publish') $$,
  '42501', null, 'quiz_worker cannot insert runs directly');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5001', '30000000-0000-4000-8000-0000000d5005', false)), 0,
  'the worker''s switch is off: nothing starts');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5002', '30000000-0000-4000-8000-0000000d5002', true)), 0,
  'a book never opted in starts nothing');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5003', '30000000-0000-4000-8000-0000000d5003', true)), 0,
  'a question paper is never summarized');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5004', '30000000-0000-4000-8000-0000000d5004', true)), 0,
  'an archived workspace starts nothing');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5001', '30000000-0000-4000-8000-0000000d5001', true)), 0,
  'a revision that is not the active one starts nothing');
create temporary table started on commit drop as
select * from public.worker_start_document_summary('20000000-0000-4000-8000-0000000d5001',
  '30000000-0000-4000-8000-0000000d5005', true);
select is((select count(*)::int from started), 1, 'the active revision of an opted-in book starts');
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5001', '30000000-0000-4000-8000-0000000d5005', true)), 0,
  'a re-delivered publish starts nothing more');
reset role;

select results_eq(
  $$ select r.workspace_id, r.created_by, r.document_id, r.document_revision_id, r.status,
            r.trigger, r.job_id = s.job_id
       from public.document_summary_runs r join started s on s.run_id = r.id $$,
  $$ values ('10000000-0000-4000-8000-0000000d5001'::uuid,
             '00000000-0000-4000-8000-0000000d5002'::uuid,
             '20000000-0000-4000-8000-0000000d5001'::uuid,
             '30000000-0000-4000-8000-0000000d5005'::uuid, 'queued'::text, 'publish'::text,
             true) $$,
  'a queued publish run of the revision, attributed to the person who opted in');
select results_eq(
  $$ select j.job_type, j.created_by, j.idempotency_key, j.payload, j.status,
            j.published_at is null
       from public.async_jobs j join started s on s.job_id = j.id $$,
  $$ select 'document.summarize'::text, '00000000-0000-4000-8000-0000000d5002'::uuid,
            'document_summary:' || run_id::text,
            jsonb_build_object('run_id', run_id::text,
                               'document_id', '20000000-0000-4000-8000-0000000d5001'),
            'queued'::text, true
       from started $$,
  'its document.summarize job carries ids only and is not yet published');
select results_eq(
  $$ select status, finished_at is not null from public.document_summary_runs
      where id = '40000000-0000-4000-8000-0000000d5001' $$,
  $$ values ('superseded'::text, true) $$,
  'the older revision''s unfinished run is superseded');

-- Auto refresh off: nothing starts for the next revision.
update public.documents set summary_enabled_at = null, summary_disabled_at = now()
 where id = '20000000-0000-4000-8000-0000000d5001';
update public.document_summary_runs set status = 'failed', finished_at = now(),
       error_code = 'llm_unavailable'
 where id = (select run_id from started);
set local role quiz_worker;
select is((select count(*)::int from public.worker_start_document_summary(
  '20000000-0000-4000-8000-0000000d5001', '30000000-0000-4000-8000-0000000d5005', true)), 0,
  'auto refresh off: no run');
reset role;
select is((select count(*)::int from public.document_summary_runs
            where document_id = '20000000-0000-4000-8000-0000000d5001'), 2,
  'no other run was created');

select * from finish();
rollback;
