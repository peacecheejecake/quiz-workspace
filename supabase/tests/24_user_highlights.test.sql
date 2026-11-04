-- UX9-HL-B (20261103140000_user_highlights.sql): personal highlights — shape, grants and RLS
-- (HILITE-01-C01), target columns per kind, anchor/quote/color checks, AI explanation targets
-- refused until AIEXPL, soft delete only for quiz_api, cascades with the question / note.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

-- Shape, grants, RLS ---------------------------------------------------------------------------
select has_table('public', 'user_highlights', 'user_highlights exists');
select columns_are('public', 'user_highlights',
  array['id', 'workspace_id', 'user_id', 'target_kind', 'chapter_note_id', 'question_id',
        'question_revision_id', 'ai_explanation_id', 'anchor', 'quote', 'prefix', 'suffix',
        'color', 'version', 'replaced_by', 'created_at', 'updated_at', 'deleted_at']);
select has_index('public', 'user_highlights', 'user_highlights_user_note_idx',
  'index user_highlights_user_note_idx exists');
select has_index('public', 'user_highlights', 'user_highlights_user_question_idx',
  'index user_highlights_user_question_idx exists');
select has_index('public', 'user_highlights', 'user_highlights_workspace_user_idx',
  'index user_highlights_workspace_user_idx exists');
select ok((select pg_get_indexdef(indexrelid) like '%WHERE (deleted_at IS NULL)%'
             from pg_index where indexrelid = 'public.user_highlights_user_question_idx'::regclass),
  'the per-user target index covers live rows only');
select ok((select relrowsecurity from pg_class where oid = 'public.user_highlights'::regclass),
  'RLS is enabled on user_highlights');
select table_privs_are('public', 'user_highlights', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api reads and inserts highlights (no table-wide UPDATE, no DELETE)');
select ok(has_column_privilege('quiz_api', 'public.user_highlights', 'color', 'update')
          and has_column_privilege('quiz_api', 'public.user_highlights', 'version', 'update')
          and has_column_privilege('quiz_api', 'public.user_highlights', 'deleted_at', 'update')
          and has_column_privilege('quiz_api', 'public.user_highlights', 'replaced_by', 'update')
          and not has_column_privilege('quiz_api', 'public.user_highlights', 'quote', 'update')
          and not has_column_privilege('quiz_api', 'public.user_highlights', 'anchor', 'update')
          and not has_column_privilege('quiz_api', 'public.user_highlights', 'user_id', 'update')
          and not has_column_privilege('quiz_api', 'public.user_highlights', 'question_id',
                                       'update'),
  'quiz_api can only change the color, version, deletion and replacement of a highlight');
select table_privs_are('public', 'user_highlights', r, array[]::text[],
  format('%s has no privileges on user_highlights', r))
  from unnest(array['quiz_worker', 'anon', 'authenticated']) as r;
select is((select array_agg(policyname::text order by policyname) from pg_policies
            where schemaname = 'public' and tablename = 'user_highlights'),
  array['quiz_api_insert', 'quiz_api_select', 'quiz_api_update'],
  'quiz_api policies only');

-- Fixtures: user u (workspace w: a book with a note row, question q and its revision) ---------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0001', 'hilite-u@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0001', 'hilite w', '00000000-0000-4000-8000-0000000f0001'),
  ('10000000-0000-4000-8000-0000000f0002', 'hilite w2', '00000000-0000-4000-8000-0000000f0001');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001', 'Book',
   'book.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-0000000f0001/documents/20000000-0000-4000-8000-0000000f0001/revisions/30000000-0000-4000-8000-0000000f0001/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key, content_hash)
values
  ('30000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
   '20000000-0000-4000-8000-0000000f0001', 1,
   'workspaces/10000000-0000-4000-8000-0000000f0001/documents/20000000-0000-4000-8000-0000000f0001/revisions/30000000-0000-4000-8000-0000000f0001/source.pdf',
   repeat('1', 64));
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('50000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
   'SHORT_ANSWER', 1);
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('60000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
   '50000000-0000-4000-8000-0000000f0001', 1, 'Q');
insert into public.chapter_notes (id, workspace_id, document_id, document_revision_id,
                                  section_key, input_fingerprint, body_hash, question_refs)
values ('70000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '20000000-0000-4000-8000-0000000f0001', '30000000-0000-4000-8000-0000000f0001', 'c1',
        repeat('0', 64), repeat('b', 64),
        '[{"tag": "Q1", "question_id": "50000000-0000-4000-8000-0000000f0001",
           "question_revision_id": "60000000-0000-4000-8000-0000000f0001", "label": "1장 1번"}]');

-- Target columns and checks (as quiz_api) ------------------------------------------------------
grant quiz_api to postgres;
-- Test-only (rolled back): let assertions run while the role is switched.
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select lives_ok(
  $$ insert into public.user_highlights (id, workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, prefix, suffix,
                                         color)
     values ('80000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
             '00000000-0000-4000-8000-0000000f0001', 'explanation',
             '50000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
             '{"block": "p0", "start": 4, "end": 7}', '라마바', '가나다 ', ' 사아자',
             'yellow') $$,
  'an explanation highlight');
select lives_ok(
  $$ insert into public.user_highlights (id, workspace_id, user_id, target_kind, chapter_note_id,
                                         anchor, quote, color)
     values ('80000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0001',
             '00000000-0000-4000-8000-0000000f0001', 'note',
             '70000000-0000-4000-8000-0000000f0001', '{"block": "s0.i1", "start": 0, "end": 2}',
             '핵심', 'pink') $$,
  'a note highlight');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, chapter_note_id,
                                         question_id, question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'note', '70000000-0000-4000-8000-0000000f0001',
             '50000000-0000-4000-8000-0000000f0001', '60000000-0000-4000-8000-0000000f0001',
             '{"block": "s0.i0", "start": 0, "end": 1}', '핵', 'blue') $$,
  '23514', null, 'one target per row');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         ai_explanation_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'ai_explanation', '50000000-0000-4000-8000-0000000f0001', gen_random_uuid(),
             '{"block": "p0", "start": 0, "end": 1}', '가', 'blue') $$,
  '23514', null, 'AI explanation targets wait for AIEXPL-01');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0002', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001', '{"block": "p0", "start": 0, "end": 1}',
             '가', 'blue') $$,
  '23503', null, 'the target belongs to the row''s workspace');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001', '{"block": "p0", "start": 3, "end": 3}',
             '가', 'blue') $$,
  '23514', null, 'an empty range is refused');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001',
             '{"block": "x1", "start": 0, "end": 1, "text": "client"}', '가', 'blue') $$,
  '23514', null, 'anchors are {block, start, end} with a known block shape');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001', '{"block": "p0", "start": 0, "end": 1}',
             repeat('가', 2001), 'blue') $$,
  '23514', null, 'quotes hold at most 2,000 characters');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, prefix, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001', '{"block": "p0", "start": 0, "end": 1}',
             '가', repeat('나', 33), 'blue') $$,
  '23514', null, 'prefix/suffix hold at most 32 characters');
select throws_ok(
  $$ insert into public.user_highlights (workspace_id, user_id, target_kind, question_id,
                                         question_revision_id, anchor, quote, color)
     values ('10000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0001',
             'explanation', '50000000-0000-4000-8000-0000000f0001',
             '60000000-0000-4000-8000-0000000f0001', '{"block": "p0", "start": 0, "end": 1}',
             '가', 'green') $$,
  '23514', null, 'three colors only');

-- Updates: color/version/deletion only; no delete -----------------------------------------------
select lives_ok(
  $$ update public.user_highlights set color = 'blue', version = version + 1
      where id = '80000000-0000-4000-8000-0000000f0001' $$,
  'quiz_api changes a color');
select throws_ok(
  $$ update public.user_highlights set quote = '위조'
      where id = '80000000-0000-4000-8000-0000000f0001' $$,
  '42501', null, 'quiz_api cannot rewrite a quote');
select throws_ok(
  $$ update public.user_highlights set replaced_by = '80000000-0000-4000-8000-0000000f0002'
      where id = '80000000-0000-4000-8000-0000000f0001' $$,
  '23514', null, 'only a deleted row is replaced');
select lives_ok(
  $$ update public.user_highlights
        set deleted_at = now(), replaced_by = '80000000-0000-4000-8000-0000000f0002'
      where id = '80000000-0000-4000-8000-0000000f0001' $$,
  'a replaced row is soft-deleted');
select throws_ok(
  $$ delete from public.user_highlights where id = '80000000-0000-4000-8000-0000000f0002' $$,
  '42501', null, 'quiz_api never deletes a highlight row');
reset role;
select is((select version from public.user_highlights
            where id = '80000000-0000-4000-8000-0000000f0001'), 2, 'the version moved');

-- Cascades: the note version / question going away removes their highlights -----------------
delete from public.chapter_notes where id = '70000000-0000-4000-8000-0000000f0001';
select is((select count(*)::int from public.user_highlights
            where id = '80000000-0000-4000-8000-0000000f0002'), 0,
  'a note version takes its highlights');
select is((select replaced_by from public.user_highlights
            where id = '80000000-0000-4000-8000-0000000f0001'), null,
  'replaced_by is cleared when the replacing row goes');
delete from public.questions where id = '50000000-0000-4000-8000-0000000f0001';
select is((select count(*)::int from public.user_highlights
            where workspace_id = '10000000-0000-4000-8000-0000000f0001'), 0,
  'a question takes its highlights');

select * from finish();
rollback;
