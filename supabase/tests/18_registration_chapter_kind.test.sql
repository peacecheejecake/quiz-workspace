-- UX6-UPLOAD-B (20261028120000): worker_register_import_drafts never registers a draft under a
-- chapter whose document stopped being a book after the selection (re-typed as a question paper);
-- the item is refused as changed (`stale-draft`), other items register as before.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c1001', 'regkind-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000c1001', 'regkind ws', '00000000-0000-4000-8000-0000000c1001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000c1001', '00000000-0000-4000-8000-0000000c1001', 'owner');

-- d1: the imported PDF; d2: the book whose chapter the selection chose.
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
select d.id::uuid, '10000000-0000-4000-8000-0000000c1001', 'Doc', 'd.pdf', 10, repeat('a', 64),
       'workspaces/10000000-0000-4000-8000-0000000c1001/documents/' || d.id || '/revisions/'
         || '30000000' || substr(d.id, 9) || '/source.pdf',
       '00000000-0000-4000-8000-0000000c1001', d.kind
  from (values ('20000000-0000-4000-8000-0000000c1001', 'question_paper'),
               ('20000000-0000-4000-8000-0000000c1002', 'book')) as d (id, kind);
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by)
select ('30000000' || substr(d.id::text, 9))::uuid, d.workspace_id, d.id, 1, d.source_object_key,
       d.created_by
  from public.documents d where d.workspace_id = '10000000-0000-4000-8000-0000000c1001';
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, title)
values ('40000000-0000-4000-8000-0000000c1002', '10000000-0000-4000-8000-0000000c1001',
        '20000000-0000-4000-8000-0000000c1002', '30000000-0000-4000-8000-0000000c1002', 'sec-ch1',
        1, '1장 물의 순환');
update public.document_revisions
   set status = 'published', content_hash = repeat('b', 64), published_at = now()
 where workspace_id = '10000000-0000-4000-8000-0000000c1001';
update public.documents d set active_revision_id = r.id, status = 'ready'
  from public.document_revisions r
 where r.document_id = d.id and d.workspace_id = '10000000-0000-4000-8000-0000000c1001';

insert into public.question_import_runs (id, workspace_id, created_by, source_document_id,
                                         source_document_revision_id, status, finished_at)
values ('50000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001',
        '00000000-0000-4000-8000-0000000c1001', '20000000-0000-4000-8000-0000000c1001',
        '30000000-0000-4000-8000-0000000c1001', 'succeeded', now());
insert into public.question_drafts (id, workspace_id, source_type, import_run_id, position,
                                    question_type, question_number, payload)
select ('60000000-0000-4000-8000-0000000c100' || n)::uuid,
       '10000000-0000-4000-8000-0000000c1001', 'import',
       '50000000-0000-4000-8000-0000000c1001', n - 1, 'MCQ', n,
       jsonb_build_object(
         'schema_version', 1, 'id', 'p-q00' || n, 'origin', 'pdf_import',
         'question_type', 'MCQ', 'stem', '문제 ' || n,
         'options', jsonb_build_array(jsonb_build_object('id', 'opt-1', 'text', '가'),
                                      jsonb_build_object('id', 'opt-2', 'text', '나')),
         'correct_option_ids', jsonb_build_array('opt-1'), 'accepted_answers', null,
         'explanation', null, 'evidence', '[]'::jsonb,
         'validations', '[]'::jsonb, 'review_status', 'pending')
  from generate_series(1, 2) n;
insert into public.async_jobs (id, workspace_id, created_by, job_type, idempotency_key, payload,
                               status, started_at, attempts, locked_by, lease_expires_at)
values ('70000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001',
        '00000000-0000-4000-8000-0000000c1001', 'question.import_register', 'reg:1',
        jsonb_build_object('import_id', '50000000-0000-4000-8000-0000000c1001'),
        'running', now(), 1, 't', now() + interval '1 hour');
-- q1 chose the book's chapter, q2 none.
insert into public.question_import_registration_items (workspace_id, job_id, import_run_id,
                                                       draft_id, ordinal, version, chapter_id)
select '10000000-0000-4000-8000-0000000c1001', '70000000-0000-4000-8000-0000000c1001',
       '50000000-0000-4000-8000-0000000c1001', qd.id, qd.position,
       to_hex((extract(epoch from qd.updated_at) * 1000000)::bigint),
       case when qd.position = 0 then '40000000-0000-4000-8000-0000000c1002'::uuid end
  from public.question_drafts qd
 where qd.import_run_id = '50000000-0000-4000-8000-0000000c1001';

-- The book is re-typed as a question paper after the selection.
update public.documents set document_type = 'question_paper', content_kind = 'question_paper'
 where id = '20000000-0000-4000-8000-0000000c1002';

grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select results_eq(
  $$ select outcome, registered, skipped, refused, remaining
       from public.worker_register_import_drafts('70000000-0000-4000-8000-0000000c1001', 10) $$,
  $$ values ('ok'::text, 1, 0, 1, 0) $$,
  'the draft filed under a non-book chapter is refused, the other registers');
reset role;

select results_eq(
  $$ select draft_id, state, reason from public.question_import_registration_items
      where job_id = '70000000-0000-4000-8000-0000000c1001' order by ordinal $$,
  $$ values ('60000000-0000-4000-8000-0000000c1001'::uuid, 'refused'::text, 'stale-draft'::text),
            ('60000000-0000-4000-8000-0000000c1002'::uuid, 'registered', null) $$,
  'refused as changed since the selection');
select is((select published_question_id from public.question_drafts
            where id = '60000000-0000-4000-8000-0000000c1001'), null,
  'the refused draft is not linked to a question');
select is((select count(*)::int from public.questions
            where workspace_id = '10000000-0000-4000-8000-0000000c1001'
              and chapter_id = '40000000-0000-4000-8000-0000000c1002'), 0,
  'nothing is registered under the question paper''s chapter');

select * from finish();
rollback;
