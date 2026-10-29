-- CHNOTE-B (20261029130000_chapter_notes.sql): chapter note versions, one running generation per
-- chapter, role grants, the fingerprint/body-hash functions, the generated activity and the fork
-- copy of source-matched newest notes.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(34);

-- Shape ----------------------------------------------------------------------------------------
select has_table('public', 'chapter_notes', 'chapter_notes exists');
select columns_are('public', 'chapter_notes',
  array['id', 'workspace_id', 'document_id', 'document_revision_id', 'section_key', 'version',
        'status', 'job_id', 'input_fingerprint', 'body_hash', 'question_refs', 'body',
        'dropped_items', 'batches_total', 'batches_done', 'prompt_version', 'model',
        'error_code', 'usage', 'created_by', 'created_at', 'updated_at', 'finished_at',
        'superseded_at']);
select ok((select relrowsecurity from pg_class where oid = 'public.chapter_notes'::regclass),
  'RLS is enabled on chapter_notes');
select table_privs_are('public', 'chapter_notes', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api reads and inserts notes (no table-wide UPDATE/DELETE)');
select table_privs_are('public', 'chapter_notes', 'quiz_worker', array['SELECT'],
  'quiz_worker reads notes (column UPDATE only)');
select table_privs_are('public', 'chapter_notes', r, array[]::text[],
  format('%s has no privileges on chapter_notes', r))
  from unnest(array['anon', 'authenticated']) as r;
select ok(has_column_privilege('quiz_api', 'public.chapter_notes', 'status', 'update')
          and not has_column_privilege('quiz_api', 'public.chapter_notes', 'body', 'update')
          and not has_column_privilege('quiz_api', 'public.chapter_notes', 'version', 'update'),
  'quiz_api can only settle a row (status/error_code/finished_at)');
select ok(has_column_privilege('quiz_worker', 'public.chapter_notes', 'body', 'update')
          and not has_column_privilege('quiz_worker', 'public.chapter_notes', 'question_refs',
                                       'update')
          and not has_column_privilege('quiz_worker', 'public.chapter_notes', 'section_key',
                                       'update')
          and not has_column_privilege('quiz_worker', 'public.chapter_notes', 'job_id', 'update'),
  'quiz_worker writes results, never the pinned input, chapter or job');
select ok(not has_function_privilege('quiz_api', 'public.chapter_notes_record_generated()',
                                     'execute')
          and not has_function_privilege('quiz_worker', 'public.fork_copy_chapter_notes()',
                                         'execute')
          and has_function_privilege('quiz_api', 'public.chapter_note_body_hash(uuid, text)',
                                     'execute'),
  'trigger functions are not callable; the body hash is callable by quiz_api');

-- Fingerprint agrees with quiz_api.chapter_notes.input_fingerprint (Python, byte-order sort).
select is(
  public.chapter_note_fingerprint(
    '[{"question_id": "20000000-0000-4000-8000-000000000002",
       "question_revision_id": "30000000-0000-4000-8000-000000000002"},
      {"question_id": "20000000-0000-4000-8000-00000000000a",
       "question_revision_id": "30000000-0000-4000-8000-00000000000a"},
      {"question_id": "20000000-0000-4000-8000-000000000001",
       "question_revision_id": "30000000-0000-4000-8000-000000000001"}]'::jsonb,
    repeat('a', 64)),
  '539b6a1e30e3dc0b1025c8d951e5dd969bf124ebcdb5feb216e7cf18a34a47cc',
  'the SQL fingerprint matches the Python one');

-- Fixture: a workspace with a book (chapter c1 with sub-section c1s1, chapter c2) ---------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0001', 'chnote-owner@example.test'),
  ('00000000-0000-4000-8000-0000000c0002', 'chnote-forker@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000c0001', 'chnote', '00000000-0000-4000-8000-0000000c0001');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001', 'Book',
   'book.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-0000000c0001/documents/20000000-0000-4000-8000-0000000c0001/revisions/30000000-0000-4000-8000-0000000c0001/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key, content_hash)
values
  ('30000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0001', 1,
   'workspaces/10000000-0000-4000-8000-0000000c0001/documents/20000000-0000-4000-8000-0000000c0001/revisions/30000000-0000-4000-8000-0000000c0001/source.pdf',
   repeat('1', 64));
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, parent_id, section_key, level,
   sort_order, title)
values
  ('40000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', null, 'c1', 1,
   0, '1장'),
  ('40000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001',
   '40000000-0000-4000-8000-0000000c0001', 'c1s1', 2, 1, '1.1'),
  ('40000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-0000000c0001',
   '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', null, 'c2', 1,
   2, '2장');
insert into public.content_blocks
  (workspace_id, document_id, document_revision_id, block_id, ordinal, chapter_id, block_type,
   text, page, provenance)
select '10000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-0000000c0001',
       '30000000-0000-4000-8000-0000000c0001', b.block_id, b.ordinal, b.chapter_id::uuid, 'text',
       b.text, 1, '{"locations": [{"page": 1}]}'::jsonb
  from (values ('p1', 0, '40000000-0000-4000-8000-0000000c0001', '첫 문단'),
               ('p2', 1, '40000000-0000-4000-8000-0000000c0002', '하위 문단'),
               ('p3', 2, '40000000-0000-4000-8000-0000000c0003', '다른 장')) as b(block_id, ordinal,
                                                                         chapter_id, text);
update public.document_revisions set status = 'published', published_at = now()
 where id = '30000000-0000-4000-8000-0000000c0001';
update public.documents set active_revision_id = '30000000-0000-4000-8000-0000000c0001',
       status = 'ready'
 where id = '20000000-0000-4000-8000-0000000c0001';

select is(public.chapter_note_body_hash('30000000-0000-4000-8000-0000000c0001', 'c1'),
  encode(sha256(convert_to(E'첫 문단\n하위 문단', 'UTF8')), 'hex'),
  'the body hash covers the chapter and its sub-sections in reading order');
select is(public.chapter_note_body_hash('30000000-0000-4000-8000-0000000c0001', 'missing'),
  encode(sha256(''::bytea), 'hex'), 'an unknown chapter hashes the empty text');

-- Questions q1, q2 (CONFIRMED) in c1; q3 in c2 whose revision changes before the fork.
insert into public.questions (id, workspace_id, question_type, chapter_id, question_number) values
  ('50000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001', 'ESSAY',
   '40000000-0000-4000-8000-0000000c0001', 1),
  ('50000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-0000000c0001', 'ESSAY',
   '40000000-0000-4000-8000-0000000c0001', 2),
  ('50000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-0000000c0001', 'ESSAY',
   '40000000-0000-4000-8000-0000000c0003', 3);
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('60000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
   '50000000-0000-4000-8000-0000000c0001', 1, 'q1'),
  ('60000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-0000000c0001',
   '50000000-0000-4000-8000-0000000c0002', 1, 'q2'),
  ('60000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-0000000c0001',
   '50000000-0000-4000-8000-0000000c0003', 1, 'q3'),
  ('60000000-0000-4000-8000-0000000c0004', '10000000-0000-4000-8000-0000000c0001',
   '50000000-0000-4000-8000-0000000c0003', 2, 'q3 edited');
update public.questions q set active_revision_id = r.id, publication_status = 'CONFIRMED'
  from (values ('50000000-0000-4000-8000-0000000c0001'::uuid,
                '60000000-0000-4000-8000-0000000c0001'::uuid),
               ('50000000-0000-4000-8000-0000000c0002', '60000000-0000-4000-8000-0000000c0002'),
               ('50000000-0000-4000-8000-0000000c0003', '60000000-0000-4000-8000-0000000c0004'))
       as r(qid, id)
 where q.id = r.qid;

-- quiz_api inserts queued rows only ----------------------------------------------------------
grant quiz_api to postgres;
grant quiz_worker to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api, quiz_worker;
set local role quiz_api;
insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                  section_key, input_fingerprint, body_hash, question_refs,
                                  created_by)
values ('70000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
        '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', 'c1',
        repeat('0', 64), repeat('b', 64),
        '[{"tag": "Q1", "question_id": "50000000-0000-4000-8000-0000000c0001",
           "question_revision_id": "60000000-0000-4000-8000-0000000c0001", "label": "1장 1번"},
          {"tag": "Q2", "question_id": "50000000-0000-4000-8000-0000000c0002",
           "question_revision_id": "60000000-0000-4000-8000-0000000c0002", "label": "1장 2번"}]',
        '00000000-0000-4000-8000-0000000c0001');
select throws_ok(
  $$ insert into public.chapter_notes (workspace_id, document_id, document_revision_id,
                                       section_key, status, version, body, input_fingerprint,
                                       body_hash, question_refs)
     values ('10000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-0000000c0001',
             '30000000-0000-4000-8000-0000000c0001', 'c9', 'succeeded', 1, '{}',
             repeat('0', 64), repeat('b', 64), '[{"tag": "Q1"}]') $$,
  '42501', null, 'API: cannot insert a succeeded version');
select throws_ok(
  $$ update public.chapter_notes set body = '{}' where section_key = 'c1' $$,
  '42501', null, 'API: cannot write a result');
reset role;

select throws_ok(
  $$ insert into public.chapter_notes (workspace_id, document_id, document_revision_id,
                                       section_key, input_fingerprint, body_hash, question_refs)
     values ('10000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-0000000c0001',
             '30000000-0000-4000-8000-0000000c0001', 'c1', repeat('0', 64), repeat('b', 64),
             '[{"tag": "Q1"}]') $$,
  '23505', null, 'one queued/running generation per chapter');
select throws_ok(
  $$ insert into public.chapter_notes (workspace_id, document_id, document_revision_id,
                                       section_key, input_fingerprint, body_hash, question_refs)
     values ('10000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-0000000c0001',
             '30000000-0000-4000-8000-0000000c0001', 'c3', repeat('0', 64), repeat('b', 64),
             '[]') $$,
  '23514', null, 'a note needs at least one input question');
select throws_ok(
  $$ update public.chapter_notes set status = 'succeeded' where section_key = 'c1' $$,
  '23514', null, 'a succeeded row needs a version and a body');

-- quiz_worker finishes the generation ---------------------------------------------------------
set local role quiz_worker;
select lives_ok(
  $$ update public.chapter_notes
        set status = 'succeeded', version = 1, finished_at = now(), dropped_items = 1,
            body = '{"sections": [{"heading": "h", "items": [{"text": "t", "tags": ["Q1"]}]}]}',
            usage = '{"llm_calls": 1}'
      where id = '70000000-0000-4000-8000-0000000c0001' $$,
  'the worker writes the result');
select throws_ok(
  $$ update public.chapter_notes set question_refs = '[]'
      where id = '70000000-0000-4000-8000-0000000c0001' $$,
  '42501', null, 'the worker never rewrites the pinned input');
select throws_ok(
  $$ insert into public.chapter_notes (workspace_id, document_id, document_revision_id,
                                       section_key, input_fingerprint, body_hash, question_refs)
     values ('10000000-0000-4000-8000-0000000c0001', '20000000-0000-4000-8000-0000000c0001',
             '30000000-0000-4000-8000-0000000c0001', 'c2', repeat('0', 64), repeat('b', 64),
             '[{"tag": "Q1"}]') $$,
  '42501', null, 'the worker never creates notes');
reset role;

select is(
  (select (actor_id, target_type, metadata ->> 'version', metadata ->> 'question_count')::text
     from public.activity_events
    where event_type = 'chapter_note.generated'
      and target_id = '70000000-0000-4000-8000-0000000c0001'),
  '(00000000-0000-4000-8000-0000000c0001,chapter_note,1,2)',
  'a succeeded note records chapter_note.generated with ids and counts');
select is(
  (select count(*)::int from public.activity_events
    where event_type = 'chapter_note.generated'
      and metadata::text like '%"t"%'),
  0, 'the activity carries no note text');

-- A second version supersedes the first; the version number is unique per chapter.
insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                  section_key, input_fingerprint, body_hash, question_refs)
values ('70000000-0000-4000-8000-0000000c0002', '10000000-0000-4000-8000-0000000c0001',
        '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', 'c1',
        repeat('0', 64), repeat('b', 64),
        (select question_refs from public.chapter_notes
          where id = '70000000-0000-4000-8000-0000000c0001'));
select throws_ok(
  $$ update public.chapter_notes set status = 'succeeded', version = 1, body = '{}'
      where id = '70000000-0000-4000-8000-0000000c0002' $$,
  '23505', null, 'a version number is used once per chapter');
update public.chapter_notes set superseded_at = now()
 where id = '70000000-0000-4000-8000-0000000c0001';
update public.chapter_notes
   set status = 'succeeded', version = 2,
       body = '{"sections": [{"heading": "h", "items": [{"text": "t2", "tags": ["Q2"]}]}]}'
 where id = '70000000-0000-4000-8000-0000000c0002';
select throws_ok(
  $$ update public.chapter_notes set superseded_at = now(), status = 'failed', version = null,
            body = null
      where id = '70000000-0000-4000-8000-0000000c0002' $$,
  '23514', null, 'only a succeeded row can be superseded');

-- quiz_api settles an orphaned generation (job already ended) ---------------------------------
insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                  section_key, input_fingerprint, body_hash, question_refs)
values ('70000000-0000-4000-8000-0000000c0009', '10000000-0000-4000-8000-0000000c0001',
        '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', 'c2',
        repeat('0', 64), repeat('b', 64),
        '[{"tag": "Q1", "question_id": "50000000-0000-4000-8000-0000000c0003",
           "question_revision_id": "60000000-0000-4000-8000-0000000c0003", "label": "2장 3번"}]');
set local role quiz_api;
select lives_ok(
  $$ update public.chapter_notes set status = 'failed', error_code = 'job_failed',
            finished_at = now() where id = '70000000-0000-4000-8000-0000000c0009' $$,
  'API: a queued row whose job ended can be marked failed');
select is(
  (select status from public.chapter_notes where id = '70000000-0000-4000-8000-0000000c0009'),
  'failed', 'the orphaned row is failed');
reset role;
-- c2's newest succeeded note cites q3's *first* revision (q3 was edited since).
insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                  section_key, input_fingerprint, body_hash, question_refs)
values ('70000000-0000-4000-8000-0000000c0003', '10000000-0000-4000-8000-0000000c0001',
        '20000000-0000-4000-8000-0000000c0001', '30000000-0000-4000-8000-0000000c0001', 'c2',
        repeat('0', 64), repeat('b', 64),
        '[{"tag": "Q1", "question_id": "50000000-0000-4000-8000-0000000c0003",
           "question_revision_id": "60000000-0000-4000-8000-0000000c0003", "label": "2장 3번"}]');
update public.chapter_notes set status = 'succeeded', version = 1, body = '{"sections": []}'
 where id = '70000000-0000-4000-8000-0000000c0003';

-- Fork: copies c1's newest version only (source-matched), not c2's ----------------------------
insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, allow_fork)
values ('80000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
        '00000000-0000-4000-8000-0000000c0001', sha256('\xc001'::bytea), true);
insert into public.workspace_forks
  (id, source_workspace_id, source_share_link_id, forked_by, name, source_snapshot_manifest,
   origin_attribution)
values (
  '90000000-0000-4000-8000-0000000c0001', '10000000-0000-4000-8000-0000000c0001',
  '80000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000c0002', 'fork',
  jsonb_build_object(
    'version', 2, 'id_salt', 'b0000000-0000-4000-8000-0000000c0001',
    'target_workspace_id', 'a0000000-0000-4000-8000-0000000c0001',
    'documents', jsonb_build_array(jsonb_build_object(
      'document_id', '20000000-0000-4000-8000-0000000c0001',
      'revision_id', '30000000-0000-4000-8000-0000000c0001')),
    'questions', jsonb_build_array(
      jsonb_build_object('question_id', '50000000-0000-4000-8000-0000000c0001',
                         'revision_id', '60000000-0000-4000-8000-0000000c0001',
                         'sources', '[]'::jsonb),
      jsonb_build_object('question_id', '50000000-0000-4000-8000-0000000c0002',
                         'revision_id', '60000000-0000-4000-8000-0000000c0002',
                         'sources', '[]'::jsonb),
      jsonb_build_object('question_id', '50000000-0000-4000-8000-0000000c0003',
                         'revision_id', '60000000-0000-4000-8000-0000000c0004',
                         'sources', '[]'::jsonb))),
  '{}'::jsonb);
set local role quiz_worker;
select is(public.worker_fork_commit('90000000-0000-4000-8000-0000000c0001'), 'completed',
  'the fork commits');
reset role;

select is(
  (select count(*)::int from public.chapter_notes
    where workspace_id = 'a0000000-0000-4000-8000-0000000c0001'),
  1, 'one note is copied (c1); c2''s note cites an edited revision');
select is(
  (select (section_key, version, status, usage is null, job_id is null,
           id <> '70000000-0000-4000-8000-0000000c0002',
           body ->> 'sections' = (select body ->> 'sections' from public.chapter_notes
                                   where id = '70000000-0000-4000-8000-0000000c0002'))::text
     from public.chapter_notes where workspace_id = 'a0000000-0000-4000-8000-0000000c0001'),
  '(c1,1,succeeded,t,t,t,t)',
  'the copy is the newest version as version 1 with a new id and no usage or job');
select is(
  (select pg_catalog.array_agg(r ->> 'tag' order by r ->> 'tag')::text
     from public.chapter_notes n, jsonb_array_elements(n.question_refs) r
    where n.workspace_id = 'a0000000-0000-4000-8000-0000000c0001'
      and exists (select 1 from public.questions q
                   where q.id = (r ->> 'question_id')::uuid
                     and q.workspace_id = n.workspace_id
                     and q.active_revision_id = (r ->> 'question_revision_id')::uuid)),
  '{Q1,Q2}', 'question_refs point at the copied questions and revisions');
select is(
  (select n.document_id = d.id and n.document_revision_id = d.active_revision_id
     from public.chapter_notes n
     join public.documents d on d.workspace_id = n.workspace_id
    where n.workspace_id = 'a0000000-0000-4000-8000-0000000c0001'),
  true, 'the copy belongs to the copied document and revision');
select is(
  (select n.input_fingerprint = public.chapter_note_fingerprint(n.question_refs, n.body_hash)
          and n.input_fingerprint <> (select input_fingerprint from public.chapter_notes
                                        where id = '70000000-0000-4000-8000-0000000c0002')
     from public.chapter_notes n
    where n.workspace_id = 'a0000000-0000-4000-8000-0000000c0001'),
  true, 'the fingerprint is recomputed over the remapped refs');
select is(
  (select count(*)::int from public.chapter_notes
    where workspace_id = '10000000-0000-4000-8000-0000000c0001'),
  4, 'the source notes are untouched');

select * from finish();
rollback;
