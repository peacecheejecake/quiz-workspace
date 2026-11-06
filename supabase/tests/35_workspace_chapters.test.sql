-- UX12-CHAPTERADD (20261106210000_workspace_chapters.sql): chapters without a document, their tree
-- row, import registration and the fork copy.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(28);

-- Privileges -----------------------------------------------------------------------------------
select ok(has_table_privilege('quiz_api', 'public.workspace_chapter_trees', 'update'),
  'quiz_api locks and bumps the tree row');
select ok(not has_table_privilege(r, 'public.workspace_chapter_trees', 'select'),
  r || ' cannot read the tree row')
  from unnest(array['quiz_worker', 'authenticated', 'anon']) r;
select ok((select relrowsecurity from pg_class
            where oid = 'public.workspace_chapter_trees'::regclass), 'the tree row has RLS');

-- Lock order: the chapters' owners before the drafts.
select ok(strpos(prosrc, 'for share of t') < strpos(prosrc, 'for share of doc'),
  'registration takes the tree row before the documents')
  from pg_proc where oid = 'public.worker_register_import_drafts(uuid, integer)'::regprocedure;
select ok(strpos(prosrc, 'for share of doc') < strpos(prosrc, 'for update of qd'),
  'registration takes the documents before the drafts')
  from pg_proc where oid = 'public.worker_register_import_drafts(uuid, integer)'::regprocedure;

-- Fixtures: a source workspace with one published book chapter, a target for the fork.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0001', 'wc-owner@example.test'),
  ('00000000-0000-4000-8000-0000000f0002', 'wc-forker@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0001', 'wc', '00000000-0000-4000-8000-0000000f0001'),
  ('10000000-0000-4000-8000-0000000f0002', 'other', '00000000-0000-4000-8000-0000000f0001');
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by)
values ('20000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001', 'D',
        'd.pdf', 10, repeat('b', 64),
        'workspaces/10000000-0000-4000-8000-0000000f0001/documents/'
        '20000000-0000-4000-8000-0000000f0001/revisions/30000000-0000-4000-8000-0000000f0001/source.pdf',
        '00000000-0000-4000-8000-0000000f0001');
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by, content_hash)
select '30000000-0000-4000-8000-0000000f0001', workspace_id, id, 1, source_object_key, created_by,
       repeat('a', 64)
  from public.documents where id = '20000000-0000-4000-8000-0000000f0001';
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, sort_order, title)
values ('40000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '20000000-0000-4000-8000-0000000f0001', '30000000-0000-4000-8000-0000000f0001', 'book-a', 1,
        0, 'book a');
update public.document_revisions set status = 'published', published_at = now()
 where id = '30000000-0000-4000-8000-0000000f0001';
update public.documents
   set status = 'ready', active_revision_id = '30000000-0000-4000-8000-0000000f0001'
 where id = '20000000-0000-4000-8000-0000000f0001';

-- The row -------------------------------------------------------------------------------------
create function pg_temp.w(n int) returns uuid language sql as $$
  select ('50000000-0000-4000-8000-0000000f000' || n)::uuid
$$;
create function pg_temp.put(n int, parent uuid, ws uuid) returns void language sql as $$
  insert into public.chapters (id, workspace_id, workspace_level_of, parent_id, section_key, level,
                               sort_order, title)
  values (pg_temp.w(n), ws, ws, parent, 'user-' || pg_temp.w(n)::text,
          case when parent is null then 1 else 2 end, n, 'w' || n)
$$;

select lives_ok($$ select pg_temp.put(1, null, '10000000-0000-4000-8000-0000000f0001') $$,
  'a Workspace chapter needs no chapter_edit path: no revision guard applies');
select lives_ok($$ select pg_temp.put(2, pg_temp.w(1), '10000000-0000-4000-8000-0000000f0001') $$,
  'a Workspace chapter hangs under a Workspace chapter');
select lives_ok($$ update public.chapters set title = 'w1 renamed' where id = pg_temp.w(1) $$,
  'no revision guard on a rename');
select throws_ok($$ insert into public.chapters
    (workspace_id, workspace_level_of, section_key, level, sort_order, title)
  values ('10000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          'parser-key', 1, 0, 'x') $$,
  '23514', null, 'a Workspace chapter has a user key');
select throws_ok($$ insert into public.chapters
    (id, workspace_id, workspace_level_of, section_key, level, sort_order, title, page)
  values ('50000000-0000-4000-8000-0000000f0009', '10000000-0000-4000-8000-0000000f0001',
          '10000000-0000-4000-8000-0000000f0001', 'user-50000000-0000-4000-8000-0000000f0009', 1, 0, 'x', 3) $$,
  '23514', null, 'a Workspace chapter has no page');
select throws_ok($$ insert into public.chapters
    (workspace_id, document_id, section_key, level, sort_order, title)
  values ('10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001',
          'user-50000000-0000-4000-8000-0000000f0009', 1, 0, 'x') $$,
  '23514', null, 'document and revision are null together');
select throws_ok($$ insert into public.chapters
    (workspace_id, workspace_level_of, parent_id, section_key, level, sort_order, title)
  values ('10000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
          '40000000-0000-4000-8000-0000000f0001',
          'user-50000000-0000-4000-8000-0000000f0009', 2, 0, 'x') $$,
  '23514', null, 'a book chapter is no parent of a Workspace chapter');
select throws_ok($$ insert into public.chapters
    (workspace_id, workspace_level_of, parent_id, section_key, level, sort_order, title)
  values ('10000000-0000-4000-8000-0000000f0002', '10000000-0000-4000-8000-0000000f0002',
          pg_temp.w(1),
          'user-50000000-0000-4000-8000-0000000f0009', 2, 0, 'x') $$,
  '23503', null, 'a parent of another workspace is refused');
select throws_ok($$ insert into public.chapters
    (workspace_id, section_key, level, sort_order, title)
  values ('10000000-0000-4000-8000-0000000f0001',
          'user-50000000-0000-4000-8000-0000000f0009', 1, 0, 'x') $$,
  '23514', null, 'a Workspace chapter names its workspace');
select throws_ok($$ update public.chapters
    set document_id = null, document_revision_id = null,
        workspace_level_of = workspace_id, section_key = 'user-' || id::text
  where id = '40000000-0000-4000-8000-0000000f0001' $$,
  '23514', null, 'a published chapter cannot leave its revision');
select throws_ok($$ update public.chapters
    set document_id = '20000000-0000-4000-8000-0000000f0001',
        document_revision_id = '30000000-0000-4000-8000-0000000f0001',
        workspace_level_of = null
  where id = pg_temp.w(1) $$,
  '23514', null, 'a Workspace chapter cannot enter a published revision');

-- The tree row
insert into public.workspace_chapter_trees (workspace_id)
values ('10000000-0000-4000-8000-0000000f0001');

-- Questions on it
insert into public.questions (id, workspace_id, chapter_id, question_type, origin, created_by)
values ('60000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        pg_temp.w(2), 'SHORT_ANSWER', 'manual', '00000000-0000-4000-8000-0000000f0001');
insert into public.question_revisions (id, workspace_id, question_id, version, stem,
                                       accepted_answers, created_by)
values ('70000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '60000000-0000-4000-8000-0000000f0001', 1, 'stem', array['a'],
        '00000000-0000-4000-8000-0000000f0001');
update public.questions
   set active_revision_id = '70000000-0000-4000-8000-0000000f0001',
       publication_status = 'CONFIRMED'
 where id = '60000000-0000-4000-8000-0000000f0001';
select throws_ok($$ delete from public.chapters where id = pg_temp.w(2) $$, '23503', null,
  'questions must leave first, as on any chapter');

-- Fork ----------------------------------------------------------------------------------------
insert into public.workspace_share_links (id, workspace_id, token_digest, created_by, allow_fork)
values ('80000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        sha256('wc'::bytea), '00000000-0000-4000-8000-0000000f0001', true);
insert into public.workspace_forks
  (id, source_workspace_id, source_share_link_id, forked_by, name, source_snapshot_manifest,
   origin_attribution)
values ('90000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
        '80000000-0000-4000-8000-0000000f0001', '00000000-0000-4000-8000-0000000f0002', 'copy',
        jsonb_build_object(
          'version', 3, 'id_salt', 'a0000000-0000-4000-8000-0000000f0001',
          'target_workspace_id', 'b0000000-0000-4000-8000-0000000f0001',
          'documents', jsonb_build_array(jsonb_build_object(
            'document_id', '20000000-0000-4000-8000-0000000f0001',
            'revision_id', '30000000-0000-4000-8000-0000000f0001')),
          'questions', jsonb_build_array(jsonb_build_object(
            'question_id', '60000000-0000-4000-8000-0000000f0001',
            'revision_id', '70000000-0000-4000-8000-0000000f0001',
            'sources', '[]'::jsonb))),
        '{}'::jsonb);
select is(public.worker_fork_commit('90000000-0000-4000-8000-0000000f0001'), 'completed',
  'the fork commits');
select is((select count(*) from public.chapters
            where workspace_id = 'b0000000-0000-4000-8000-0000000f0001'
              and document_revision_id is null), 2::bigint,
  'the copy has the whole Workspace chapter tree');
select is((select title from public.chapters
            where id = public.fork_remap_id('a0000000-0000-4000-8000-0000000f0001', pg_temp.w(1))),
  'w1 renamed', 'under remapped ids');
select is((select parent_id from public.chapters
            where id = public.fork_remap_id('a0000000-0000-4000-8000-0000000f0001', pg_temp.w(2))),
  public.fork_remap_id('a0000000-0000-4000-8000-0000000f0001', pg_temp.w(1)),
  'parents are remapped');
select is((select chapter_id from public.questions
            where workspace_id = 'b0000000-0000-4000-8000-0000000f0001'),
  public.fork_remap_id('a0000000-0000-4000-8000-0000000f0001', pg_temp.w(2)),
  'the copied question stays on its Workspace chapter');
select is((select version from public.workspace_chapter_trees
            where workspace_id = 'b0000000-0000-4000-8000-0000000f0001'), 0::bigint,
  'the copy starts its own version');
update public.chapters set title = 'renamed in the source' where id = pg_temp.w(1);
select is((select title from public.chapters
            where id = public.fork_remap_id('a0000000-0000-4000-8000-0000000f0001', pg_temp.w(1))),
  'w1 renamed', 'the copy is independent');

-- A workspace takes its chapters with it, also under questions and published revisions.
select lives_ok($$ delete from public.workspaces where id = 'b0000000-0000-4000-8000-0000000f0001' $$,
  'a hard delete cascades through Workspace chapters, questions and book chapters');
select is((select count(*) from public.workspace_chapter_trees
            where workspace_id = 'b0000000-0000-4000-8000-0000000f0001'), 0::bigint,
  'and the tree row');

select * from finish();
rollback;
