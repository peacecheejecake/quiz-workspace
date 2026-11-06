-- CHMAN-01 (20261106150000_chapter_edit.sql): the chapter_edit path through the published
-- revision guard, draft sync, and the bumps of chapter_tree_version.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(49);

-- Privileges -----------------------------------------------------------------------------------
select ok(has_function_privilege('quiz_api', f, 'execute'), 'quiz_api can execute ' || f)
  from unnest(array[
    'public.chapter_edit_create(uuid, uuid, uuid, uuid, text)',
    'public.chapter_edit_rename(uuid, uuid, uuid, text)',
    'public.chapter_edit_delete(uuid, uuid, uuid)',
    'public.chapter_edit_tree(uuid, uuid, jsonb)',
    'public.chapter_edit_finish(uuid, uuid, text)',
    'public.chapter_edit_sync_draft(uuid, uuid, uuid, text)']) f;
select ok(not has_function_privilege(r, 'public.chapter_edit_tree(uuid, uuid, jsonb)', 'execute'),
  r || ' cannot edit the tree')
  from unnest(array['quiz_worker', 'authenticated', 'anon']) r;
select ok(not has_function_privilege('quiz_api', 'public.chapter_edit_revision(uuid, uuid)',
  'execute'), 'the document lock helper is internal');
select is((select proconfig from pg_proc
            where oid = 'public.chapter_edit_tree(uuid, uuid, jsonb)'::regprocedure),
  array['search_path=""'], 'SECURITY DEFINER with an empty search_path (no custom function SET)');
select ok(not has_table_privilege('quiz_api', 'public.document_revisions', 'delete'),
  'no new table grant for the path');

-- Fixtures: book 01 (rev 1 published, rev 2 draft) and paper 02 in one workspace. Rev 1 has
-- a > a1 > a2 and b; blocks on a1 and a2.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000e0001', 'ce-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000e0001', 'ce', '00000000-0000-4000-8000-0000000e0001');
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
select ('20000000-0000-4000-8000-0000000e00' || d)::uuid, '10000000-0000-4000-8000-0000000e0001',
       'D' || d, d || '.pdf', 10, repeat('b', 64),
       format('workspaces/%s/documents/%s/revisions/%s/source.pdf',
              '10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e00' || d,
              '30000000-0000-4000-8000-0000000e00' || d),
       '00000000-0000-4000-8000-0000000e0001', t
  from (values ('01', 'book'), ('02', 'question_paper')) v(d, t);
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by, content_hash)
select ('30000000-0000-4000-8000-0000000e00' || right(id::text, 2))::uuid, workspace_id, id, 1,
       source_object_key, created_by, repeat('a', 64)
  from public.documents where workspace_id = '10000000-0000-4000-8000-0000000e0001';
insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                             section_key, level, sort_order, title)
select ('40000000-0000-4000-8000-0000000e000' || n)::uuid,
       '10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e0001',
       '30000000-0000-4000-8000-0000000e0001',
       case when p is null then null else ('40000000-0000-4000-8000-0000000e000' || p)::uuid end,
       k, l, s, k
  from (values (1, null, 'a', 1, 0), (2, 1, 'a1', 2, 1), (3, 2, 'a2', 3, 2), (4, null, 'b', 1, 3))
    v(n, p, k, l, s);
insert into public.content_blocks (workspace_id, document_id, document_revision_id, block_id,
                                   ordinal, chapter_id, block_type, text, page, provenance)
select '10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e0001',
       '30000000-0000-4000-8000-0000000e0001', 'b' || n, n,
       ('40000000-0000-4000-8000-0000000e000' || n)::uuid, 'text', 'x', 1,
       '{"locations": [{"page": 1}]}'
  from generate_series(2, 3) n;
update public.document_revisions set status = 'published', published_at = now()
 where workspace_id = '10000000-0000-4000-8000-0000000e0001';
update public.documents set active_revision_id =
  ('30000000-0000-4000-8000-0000000e00' || right(id::text, 2))::uuid, status = 'ready'
 where workspace_id = '10000000-0000-4000-8000-0000000e0001';
select is((select chapter_tree_version from public.documents
            where id = '20000000-0000-4000-8000-0000000e0001'), 1::bigint,
  'the first active revision bumps the version');

-- Draft rev 2: a copy of rev 1 plus a corrected title on a and a chapter x with a block.
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       parent_revision_id, source_object_key, created_by)
select '30000000-0000-4000-8000-0000000e0003', workspace_id, document_id, 2, id, source_object_key,
       created_by
  from public.document_revisions where id = '30000000-0000-4000-8000-0000000e0001';
insert into public.chapters (id, workspace_id, document_id, document_revision_id, parent_id,
                             section_key, level, sort_order, title)
select ('41000000-0000-4000-8000-0000000e000' || n)::uuid,
       '10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e0001',
       '30000000-0000-4000-8000-0000000e0003',
       case when p is null then null else ('41000000-0000-4000-8000-0000000e000' || p)::uuid end,
       k, l, s, t
  from (values (1, null, 'a', 1, 0, 'a corrected'), (2, 1, 'a1', 2, 1, 'a1'), (3, 2, 'a2', 3, 2, 'a2'),
               (4, null, 'b', 1, 3, 'b')) v(n, p, k, l, s, t);
insert into public.content_blocks (workspace_id, document_id, document_revision_id, block_id,
                                   ordinal, chapter_id, block_type, text, page, provenance)
select '10000000-0000-4000-8000-0000000e0001', '20000000-0000-4000-8000-0000000e0001',
       '30000000-0000-4000-8000-0000000e0003', 'b' || n, n,
       ('41000000-0000-4000-8000-0000000e000' || n)::uuid, 'text', 'x', 1,
       '{"locations": [{"page": 1}]}'
  from generate_series(2, 3) n;

grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;

-- The guard outside the path -------------------------------------------------------------------
set local role quiz_api;
select throws_ok($$ update public.chapters set title = 'no'
                     where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'quiz_api cannot write a published chapter directly');
set local quiz.chapter_edit = 'on';
select throws_ok($$ update public.chapters set title = 'no'
                     where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'quiz_api cannot open the path with set_config');
select throws_ok($$ update public.document_revisions set content_hash = repeat('c', 64)
                     where id = '30000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'quiz_api cannot rewrite a published hash');
set local quiz.chapter_edit = '';
reset role;

-- The owner role inside the path may only touch the listed columns.
set local quiz.chapter_edit = 'on';
select throws_ok($$ update public.chapters set page = 2
                     where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the path does not reach chapters.page');
select throws_ok($$ update public.chapters set section_key = 'z'
                     where id = '40000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the path does not reach section_key');
select throws_ok($$ update public.content_blocks set text = 'no'
                     where document_revision_id = '30000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the path does not reach block text');
select throws_ok($$ delete from public.content_blocks
                     where document_revision_id = '30000000-0000-4000-8000-0000000e0001' $$,
  '23514', null, 'the path does not delete blocks');
select throws_ok($$ insert into public.chapters (workspace_id, document_id, document_revision_id,
                      section_key, level, title)
                    values ('10000000-0000-4000-8000-0000000e0001',
                      '20000000-0000-4000-8000-0000000e0001',
                      '30000000-0000-4000-8000-0000000e0001', 'parser-key', 1, 'x') $$,
  '23514', null, 'the path inserts user-<uuid> chapters only');
set local quiz.chapter_edit = '';

-- Editing --------------------------------------------------------------------------------------
-- Tree under test after the steps below: a > a2 (a1 deleted), b > new.
set local role quiz_api;
select lives_ok($$ select public.chapter_edit_create('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '42000000-0000-4000-8000-0000000e0001',
    '40000000-0000-4000-8000-0000000e0004', 'new') $$, 'quiz_api creates through the path');
select lives_ok($$ select public.chapter_edit_tree('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001',
    '[{"id": "40000000-0000-4000-8000-0000000e0001", "parent_id": null, "level": 1, "sort_order": 0},
      {"id": "40000000-0000-4000-8000-0000000e0002", "parent_id": "40000000-0000-4000-8000-0000000e0001", "level": 2, "sort_order": 1},
      {"id": "40000000-0000-4000-8000-0000000e0003", "parent_id": "40000000-0000-4000-8000-0000000e0002", "level": 3, "sort_order": 2},
      {"id": "40000000-0000-4000-8000-0000000e0004", "parent_id": null, "level": 1, "sort_order": 3},
      {"id": "42000000-0000-4000-8000-0000000e0001", "parent_id": "40000000-0000-4000-8000-0000000e0004", "level": 2, "sort_order": 4}]') $$,
  'quiz_api writes the whole tree');
select lives_ok($$ select public.chapter_edit_rename('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0004', 'b renamed') $$,
  'quiz_api renames');
select throws_ok($$ select public.chapter_edit_tree('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001',
    '[{"id": "40000000-0000-4000-8000-0000000e0001", "parent_id": "40000000-0000-4000-8000-0000000e0002", "level": 1, "sort_order": 0}]') $$,
  '23514', null, 'a partial or cyclic tree is refused');
select throws_ok($$ select public.chapter_edit_rename('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0002', '40000000-0000-4000-8000-0000000e0004', 'x') $$,
  'P0002', null, 'a question paper has no editable tree');
select lives_ok($$ select public.chapter_edit_delete('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0002') $$,
  'quiz_api deletes');
reset role;

select is((select section_key from public.chapters
            where id = '42000000-0000-4000-8000-0000000e0001'),
  'user-42000000-0000-4000-8000-0000000e0001', 'a user chapter gets a user-<uuid> key');
select is((select parent_id from public.chapters
            where id = '40000000-0000-4000-8000-0000000e0003'),
  '40000000-0000-4000-8000-0000000e0001'::uuid, 'the child goes to the deleted chapter''s parent');
select is((select chapter_id from public.content_blocks
            where document_revision_id = '30000000-0000-4000-8000-0000000e0001' and block_id = 'b2'),
  '40000000-0000-4000-8000-0000000e0001'::uuid, 'its blocks go to the parent');
select is((select count(*) from public.question_chapter_changes c
            join public.questions q on q.id = c.question_id
            where q.workspace_id = '10000000-0000-4000-8000-0000000e0001'), 0::bigint,
  'nothing in the history yet');
select is((select public.chapter_edit_finish('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', repeat('d', 64))), 2::bigint,
  'finish returns the next version');
select is((select content_hash from public.document_revisions
            where id = '30000000-0000-4000-8000-0000000e0001'), repeat('d', 64),
  'finish stores the hash of the published revision');

-- Draft sync -----------------------------------------------------------------------------------
select lives_ok($$ select public.chapter_edit_tree('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001',
    '[{"id": "40000000-0000-4000-8000-0000000e0001", "parent_id": null, "level": 1, "sort_order": 0},
      {"id": "40000000-0000-4000-8000-0000000e0003", "parent_id": "40000000-0000-4000-8000-0000000e0001", "level": 2, "sort_order": 1},
      {"id": "40000000-0000-4000-8000-0000000e0004", "parent_id": null, "level": 1, "sort_order": 2},
      {"id": "42000000-0000-4000-8000-0000000e0001", "parent_id": "40000000-0000-4000-8000-0000000e0004", "level": 2, "sort_order": 3}]') $$,
  'levels are normalized after the delete');
select lives_ok($$ select public.chapter_edit_sync_draft('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '30000000-0000-4000-8000-0000000e0003', 'b') $$,
  'the draft syncs');
select results_eq(
  $$ select d.section_key, d.level::int, d.sort_order, d.title, p.section_key
       from public.chapters d left join public.chapters p on p.id = d.parent_id
      where d.document_revision_id = '30000000-0000-4000-8000-0000000e0003'
      order by d.sort_order $$,
  $$ values ('a'::text, 1, 0, 'a corrected'::text, null::text), ('a2', 2, 1, 'a2', 'a'),
            ('b', 1, 2, 'b renamed', null),
            ('user-42000000-0000-4000-8000-0000000e0001', 2, 3, 'new', 'b') $$,
  'the draft takes the tree, keeps its corrected title and takes the one rename');
select is((select chapter_id from public.content_blocks
            where document_revision_id = '30000000-0000-4000-8000-0000000e0003' and block_id = 'b2'),
  '41000000-0000-4000-8000-0000000e0001'::uuid,
  'the draft block of the deleted chapter goes to the surviving ancestor');
select lives_ok($$ select public.chapter_edit_sync_draft('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '30000000-0000-4000-8000-0000000e0003', null) $$,
  'the sync is idempotent');
select throws_ok($$ select public.chapter_edit_sync_draft('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '30000000-0000-4000-8000-0000000e0001', null) $$,
  'P0002', null, 'a published revision is not a draft');
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       parent_revision_id, source_object_key, created_by)
select '30000000-0000-4000-8000-0000000e0004', workspace_id, document_id, 2, id, source_object_key,
       created_by
  from public.document_revisions where id = '30000000-0000-4000-8000-0000000e0002';
select lives_ok($$ select public.chapter_edit_sync_draft('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0002', '30000000-0000-4000-8000-0000000e0004', null) $$,
  'a question paper''s restored draft syncs too');

-- History and publish --------------------------------------------------------------------------
insert into public.questions (id, workspace_id, chapter_id, question_type, origin, created_by)
values ('50000000-0000-4000-8000-0000000e0001', '10000000-0000-4000-8000-0000000e0001',
        '42000000-0000-4000-8000-0000000e0001', 'ESSAY', 'manual',
        '00000000-0000-4000-8000-0000000e0001');
select lives_ok($$ insert into public.question_chapter_changes (workspace_id, question_id, source)
    values ('10000000-0000-4000-8000-0000000e0001', '50000000-0000-4000-8000-0000000e0001',
            'chapter_edit') $$, 'chapter_edit is a history source');
select lives_ok($$ update public.questions set chapter_id = null
    where id = '50000000-0000-4000-8000-0000000e0001' $$, 'the question can leave');
select lives_ok($$ insert into public.question_chapter_changes (workspace_id, question_id,
      from_chapter_id, source)
    values ('10000000-0000-4000-8000-0000000e0001', '50000000-0000-4000-8000-0000000e0001',
            '40000000-0000-4000-8000-0000000e0003', 'chapter_edit') $$, 'with a from chapter');
select lives_ok($$ select public.chapter_edit_delete('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '40000000-0000-4000-8000-0000000e0003') $$,
  'the chapter of an append-only history row can be deleted');
select is((select count(*) from public.question_chapter_changes c
            where c.question_id = '50000000-0000-4000-8000-0000000e0001'
              and c.from_chapter_id is null), 2::bigint, 'history stays, without the deleted id');
select lives_ok($$ update public.questions
    set chapter_id = (select id from public.chapters
                       where document_revision_id = '30000000-0000-4000-8000-0000000e0001'
                         and section_key like 'user-%')
    where id = '50000000-0000-4000-8000-0000000e0001' $$, 'the question returns');
select lives_ok($$ select public.chapter_edit_sync_draft('10000000-0000-4000-8000-0000000e0001',
    '20000000-0000-4000-8000-0000000e0001', '30000000-0000-4000-8000-0000000e0003', null) $$,
  'the draft follows the second delete');
update public.document_revisions set status = 'published', published_at = now(),
       content_hash = repeat('e', 64)
 where id = '30000000-0000-4000-8000-0000000e0003';
update public.documents set active_revision_id = '30000000-0000-4000-8000-0000000e0003'
 where id = '20000000-0000-4000-8000-0000000e0001';
select is((select c.section_key from public.questions q
             join public.chapters c on c.id = q.chapter_id
            where q.id = '50000000-0000-4000-8000-0000000e0001'),
  'user-42000000-0000-4000-8000-0000000e0001',
  'publishing the synced draft keeps a question on its user chapter');
select is((select chapter_tree_version from public.documents
            where id = '20000000-0000-4000-8000-0000000e0001'), 3::bigint,
  'a new active revision bumps the version');

select * from finish();
rollback;
