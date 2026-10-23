-- QIMP-JOB (20261023120000): worker_register_import_drafts
-- approves and registers the pending items of a question.import_register job in batches, only for
-- quiz_worker, fenced by the job's state and the workspace's writability, never twice.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000b1001', 'qjob-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000b1001', 'reg ws', '00000000-0000-4000-8000-0000000b1001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000b1001', '00000000-0000-4000-8000-0000000b1001', 'owner');

-- d1: the question paper; d2: a book with revisions r2a (old) and r2b (active), same section.
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
values
  ('20000000-0000-4000-8000-0000000b1001', '10000000-0000-4000-8000-0000000b1001', 'Paper',
   'p.pdf', 10, repeat('a', 64), 'workspaces/10000000-0000-4000-8000-0000000b1001/documents/20000000-0000-4000-8000-0000000b1001/revisions/30000000-0000-4000-8000-0000000b1001/source.pdf',
   '00000000-0000-4000-8000-0000000b1001', 'question_paper'),
  ('20000000-0000-4000-8000-0000000b1002', '10000000-0000-4000-8000-0000000b1001', 'Book',
   'b.pdf', 10, repeat('a', 64), 'workspaces/10000000-0000-4000-8000-0000000b1001/documents/20000000-0000-4000-8000-0000000b1002/revisions/30000000-0000-4000-8000-0000000b102a/source.pdf',
   '00000000-0000-4000-8000-0000000b1001', 'book');
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by)
values
  ('30000000-0000-4000-8000-0000000b1001', '10000000-0000-4000-8000-0000000b1001',
   '20000000-0000-4000-8000-0000000b1001', 1, 'workspaces/10000000-0000-4000-8000-0000000b1001/documents/20000000-0000-4000-8000-0000000b1001/revisions/30000000-0000-4000-8000-0000000b1001/source.pdf', '00000000-0000-4000-8000-0000000b1001'),
  ('30000000-0000-4000-8000-0000000b102a', '10000000-0000-4000-8000-0000000b1001',
   '20000000-0000-4000-8000-0000000b1002', 1, 'workspaces/10000000-0000-4000-8000-0000000b1001/documents/20000000-0000-4000-8000-0000000b1002/revisions/30000000-0000-4000-8000-0000000b102a/source.pdf', '00000000-0000-4000-8000-0000000b1001'),
  ('30000000-0000-4000-8000-0000000b102b', '10000000-0000-4000-8000-0000000b1001',
   '20000000-0000-4000-8000-0000000b1002', 2, 'workspaces/10000000-0000-4000-8000-0000000b1001/documents/20000000-0000-4000-8000-0000000b1002/revisions/30000000-0000-4000-8000-0000000b102b/source.pdf', '00000000-0000-4000-8000-0000000b1001');
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, title)
values
  ('40000000-0000-4000-8000-0000000b102a', '10000000-0000-4000-8000-0000000b1001',
   '20000000-0000-4000-8000-0000000b1002', '30000000-0000-4000-8000-0000000b102a', 'sec-ch1',
   1, '1장 물의 순환'),
  ('40000000-0000-4000-8000-0000000b102b', '10000000-0000-4000-8000-0000000b1001',
   '20000000-0000-4000-8000-0000000b1002', '30000000-0000-4000-8000-0000000b102b', 'sec-ch1',
   1, '1장 물의 순환');
update public.document_revisions
   set status = 'published', content_hash = repeat('b', 64), published_at = now()
 where workspace_id = '10000000-0000-4000-8000-0000000b1001';
update public.documents set active_revision_id = '30000000-0000-4000-8000-0000000b1001',
                            status = 'ready'
 where id = '20000000-0000-4000-8000-0000000b1001';
update public.documents set active_revision_id = '30000000-0000-4000-8000-0000000b102b',
                            status = 'ready'
 where id = '20000000-0000-4000-8000-0000000b1002';

insert into public.question_import_runs (id, workspace_id, created_by, source_document_id,
                                         source_document_revision_id, status, finished_at)
values ('50000000-0000-4000-8000-0000000b1001', '10000000-0000-4000-8000-0000000b1001',
        '00000000-0000-4000-8000-0000000b1001', '20000000-0000-4000-8000-0000000b1001',
        '30000000-0000-4000-8000-0000000b1001', 'succeeded', now());

-- Drafts q1..q4 (positions 0..3); q4 is published already.
insert into public.question_drafts (id, workspace_id, source_type, import_run_id, position,
                                    question_type, question_number, payload)
select ('60000000-0000-4000-8000-0000000b100' || n)::uuid,
       '10000000-0000-4000-8000-0000000b1001', 'import',
       '50000000-0000-4000-8000-0000000b1001', n - 1, 'MCQ', n,
       jsonb_build_object(
         'schema_version', 1, 'id', 'p-q00' || n, 'origin', 'pdf_import',
         'question_type', 'MCQ', 'stem', '문제 ' || n,
         'options', jsonb_build_array(jsonb_build_object('id', 'opt-1', 'text', '가'),
                                      jsonb_build_object('id', 'opt-2', 'text', '나')),
         'correct_option_ids', jsonb_build_array('opt-1'), 'accepted_answers', null,
         'explanation', null,
         'evidence', jsonb_build_array(jsonb_build_object(
           'document_id', '20000000-0000-4000-8000-0000000b1001',
           'block_ids', jsonb_build_array('cb-' || n),
           'locations', jsonb_build_array(jsonb_build_object('page', n, 'bbox', null,
                                                             'block_id', 'cb-' || n)))),
         'validations', '[]'::jsonb, 'review_status', 'pending')
  from generate_series(1, 4) n;

-- Version token as the API computes it.
create temporary table v on commit drop as
select id, to_hex((extract(epoch from updated_at) * 1000000)::bigint) as version
  from public.question_drafts where import_run_id = '50000000-0000-4000-8000-0000000b1001';

insert into public.async_jobs (id, workspace_id, created_by, job_type, idempotency_key, payload)
values ('70000000-0000-4000-8000-0000000b1001', '10000000-0000-4000-8000-0000000b1001',
        '00000000-0000-4000-8000-0000000b1001', 'question.import_register', 'reg:1',
        jsonb_build_object('import_id', '50000000-0000-4000-8000-0000000b1001'));
-- q1 (old-revision chapter), q2, q3 (stale version) pending; q4 is linked to a question already.
insert into public.question_import_registration_items (workspace_id, job_id, import_run_id,
                                                       draft_id, ordinal, version, chapter_id)
select '10000000-0000-4000-8000-0000000b1001', '70000000-0000-4000-8000-0000000b1001',
       '50000000-0000-4000-8000-0000000b1001', v.id,
       (right(v.id::text, 1))::int - 1,
       case when v.id = '60000000-0000-4000-8000-0000000b1003' then 'abc' else v.version end,
       case when v.id = '60000000-0000-4000-8000-0000000b1001'
            then '40000000-0000-4000-8000-0000000b102a'::uuid end
  from v;

-- Schema / privileges ---------------------------------------------------------------------------
select has_column('public', 'question_import_runs', 'registration_job_id',
  'runs point at their newest registration job');
select throws_ok(
  $$ update public.question_import_registration_items set state = 'refused'
      where draft_id = '60000000-0000-4000-8000-0000000b1002' $$,
  '23514', null, 'a refused item names its reason');
select ok(has_function_privilege('quiz_worker',
  'public.worker_register_import_drafts(uuid, integer)', 'execute'), 'quiz_worker may register');
select ok(not has_function_privilege('quiz_api',
  'public.worker_register_import_drafts(uuid, integer)', 'execute')
  and not has_function_privilege('authenticated',
  'public.worker_register_import_drafts(uuid, integer)', 'execute')
  and not has_function_privilege('anon',
  'public.worker_register_import_drafts(uuid, integer)', 'execute'), 'nobody else may');
select ok(has_table_privilege('quiz_api', 'public.question_import_registration_items', 'insert')
  and not has_table_privilege('quiz_api', 'public.question_import_registration_items', 'update')
  and not has_table_privilege('quiz_api', 'public.question_import_registration_items', 'delete'),
  'quiz_api records items but never moves them');
select ok(not has_table_privilege('quiz_worker', 'public.question_import_registration_items',
                                  'update')
  and not has_table_privilege('quiz_worker', 'public.question_drafts', 'update')
  and not has_table_privilege('quiz_worker', 'public.questions', 'insert'),
  'quiz_worker gets no direct write privilege');
select ok(not has_column_privilege('quiz_worker', 'public.question_import_runs',
                                   'registration_job_id', 'update'),
  'quiz_worker cannot re-point a run''s registration');

-- Behaviour as quiz_worker ----------------------------------------------------------------------
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select results_eq(
  $$ select outcome, registered, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000b1001', 10) $$,
  $$ values ('not_running'::text, 0, 0) $$,
  'a job that is not running registers nothing');
reset role;
-- q4 was published by an earlier request: give it a question.
insert into public.questions (id, workspace_id, question_type, origin, created_by)
values ('80000000-0000-4000-8000-0000000b1004', '10000000-0000-4000-8000-0000000b1001', 'MCQ',
        'import', '00000000-0000-4000-8000-0000000b1001');
update public.question_drafts
   set review_status = 'approved', reviewed_at = now(),
       published_question_id = '80000000-0000-4000-8000-0000000b1004'
 where id = '60000000-0000-4000-8000-0000000b1004';
update public.async_jobs set status = 'running', started_at = now(), attempts = 1,
                             locked_by = 't', lease_expires_at = now() + interval '1 hour'
 where id = '70000000-0000-4000-8000-0000000b1001';

set local role quiz_worker;
select results_eq(
  $$ select outcome, registered, skipped, refused, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000b1001', 2) $$,
  $$ values ('ok'::text, 2, 0, 0, 2) $$,
  'a batch registers the first pending drafts in position order');
select results_eq(
  $$ select outcome, registered, skipped, refused, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000b1001', 10) $$,
  $$ values ('ok'::text, 0, 1, 1, 0) $$,
  'a stale draft is refused and a registered one skipped');
select results_eq(
  $$ select outcome, registered, skipped, refused, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000b1001', 10) $$,
  $$ values ('ok'::text, 0, 0, 0, 0) $$,
  'a re-delivered job finds nothing left to do');
reset role;

select results_eq(
  $$ select draft_id, state, reason from public.question_import_registration_items
      where job_id = '70000000-0000-4000-8000-0000000b1001' order by ordinal $$,
  $$ values ('60000000-0000-4000-8000-0000000b1001'::uuid, 'registered'::text, null::text),
            ('60000000-0000-4000-8000-0000000b1002'::uuid, 'registered', null),
            ('60000000-0000-4000-8000-0000000b1003'::uuid, 'refused', 'stale-draft'),
            ('60000000-0000-4000-8000-0000000b1004'::uuid, 'skipped', null) $$,
  'every item ends with its outcome');
select is((select count(*)::int from public.questions
            where workspace_id = '10000000-0000-4000-8000-0000000b1001'
              and publication_status = 'CONFIRMED' and origin = 'import'), 2,
  'two CONFIRMED import questions, once each');
select results_eq(
  $$ select d.review_status, d.reviewed_by, d.payload ->> 'review_status',
            d.published_question_id = i.question_id
       from public.question_drafts d
       join public.question_import_registration_items i on i.draft_id = d.id
      where d.id = '60000000-0000-4000-8000-0000000b1001' $$,
  $$ values ('approved'::text, '00000000-0000-4000-8000-0000000b1001'::uuid, 'approved'::text,
             true) $$,
  'the job''s user approves the draft and it links to its question');
select is((select review_status from public.question_drafts
            where id = '60000000-0000-4000-8000-0000000b1003'), 'pending',
  'the stale draft is left as it was');
select is((select q.chapter_id from public.questions q
             join public.question_import_registration_items i on i.question_id = q.id
            where i.draft_id = '60000000-0000-4000-8000-0000000b1001'),
  '40000000-0000-4000-8000-0000000b102b'::uuid,
  'a chapter of an older revision is registered as the same section of the current one');
select is((select q.chapter_id from public.questions q
             join public.question_import_registration_items i on i.question_id = q.id
            where i.draft_id = '60000000-0000-4000-8000-0000000b1002'), null,
  'no chapter stays no chapter');
select results_eq(
  $$ select r.stem, r.options, r.correct_option_ids, r.version
       from public.question_revisions r
       join public.question_import_registration_items i on i.question_id = r.question_id
      where i.draft_id = '60000000-0000-4000-8000-0000000b1002' $$,
  $$ values ('문제 2'::text,
             '[{"id": "opt-1", "text": "가"}, {"id": "opt-2", "text": "나"}]'::jsonb,
             array['opt-1']::text[], 1) $$,
  'revision 1 carries the draft content');
select results_eq(
  $$ select s.document_id, s.document_revision_id, s.page_start, s.page_end, s.block_ids,
            s.import_run_id
       from public.question_sources s
       join public.question_import_registration_items i on i.question_id = s.question_id
      where i.draft_id = '60000000-0000-4000-8000-0000000b1002' $$,
  $$ values ('20000000-0000-4000-8000-0000000b1001'::uuid,
             '30000000-0000-4000-8000-0000000b1001'::uuid, 2, 2, array['cb-2']::text[],
             '50000000-0000-4000-8000-0000000b1001'::uuid) $$,
  'one import source row points at the paper revision and pages');
select is((select count(*)::int from public.activity_events
            where workspace_id = '10000000-0000-4000-8000-0000000b1001'
              and event_type = 'question.created'), 2, 'question.created per registration');
select is((select sum((metadata ->> 'count')::int)::int from public.activity_events
            where workspace_id = '10000000-0000-4000-8000-0000000b1001'
              and event_type = 'question_import.published'), 2,
  'question_import.published counts the batches');

-- Archived workspace / unknown job --------------------------------------------------------------
insert into public.async_jobs (id, workspace_id, created_by, job_type, idempotency_key, payload,
                               status, started_at, attempts, locked_by, lease_expires_at)
values ('70000000-0000-4000-8000-0000000b1002', '10000000-0000-4000-8000-0000000b1001',
        '00000000-0000-4000-8000-0000000b1001', 'question.import_register', 'reg:2',
        jsonb_build_object('import_id', '50000000-0000-4000-8000-0000000b1001'), 'running',
        now(), 1, 't', now() + interval '1 hour');
insert into public.question_import_registration_items (workspace_id, job_id, import_run_id,
                                                       draft_id, ordinal, version)
select '10000000-0000-4000-8000-0000000b1001', '70000000-0000-4000-8000-0000000b1002',
       '50000000-0000-4000-8000-0000000b1001', '60000000-0000-4000-8000-0000000b1003', 0,
       version from v where id = '60000000-0000-4000-8000-0000000b1003';
update public.workspaces set status = 'archived', archived_at = now()
 where id = '10000000-0000-4000-8000-0000000b1001';
set local role quiz_worker;
select results_eq(
  $$ select outcome, registered, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000b1002', 10) $$,
  $$ values ('workspace_unavailable'::text, 0, 0) $$,
  'an archived workspace stops the registration');
select results_eq(
  $$ select outcome from public.worker_register_import_drafts(
       '70000000-0000-4000-8000-0000000b1099', 10) $$,
  $$ values ('not_found'::text) $$, 'an unknown job registers nothing');
reset role;
select is((select state from public.question_import_registration_items
            where job_id = '70000000-0000-4000-8000-0000000b1002'), 'pending',
  'its items stay pending');
select is((select published_question_id from public.question_drafts
            where id = '60000000-0000-4000-8000-0000000b1003'), null,
  'and nothing was registered');

select * from finish();
rollback;
