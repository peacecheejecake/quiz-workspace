-- CHAPTER-MAP (20261023130000): import drafts carry the reviewer's chapter choice; a chapter is
-- stored only as a manual choice and a deleted chapter clears it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c1001', 'cmap-owner@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000c1001', 'cmap ws', '00000000-0000-4000-8000-0000000c1001');
insert into public.documents (id, workspace_id, title, filename, size_bytes, sha256,
                              source_object_key, created_by, document_type)
values ('20000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001', 'Book',
        'b.pdf', 10, repeat('a', 64),
        'workspaces/10000000-0000-4000-8000-0000000c1001/documents/20000000-0000-4000-8000-0000000c1001/revisions/30000000-0000-4000-8000-0000000c1001/source.pdf',
        '00000000-0000-4000-8000-0000000c1001', 'book');
insert into public.document_revisions (id, workspace_id, document_id, revision_number,
                                       source_object_key, created_by)
values ('30000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001',
        '20000000-0000-4000-8000-0000000c1001', 1,
        'workspaces/10000000-0000-4000-8000-0000000c1001/documents/20000000-0000-4000-8000-0000000c1001/revisions/30000000-0000-4000-8000-0000000c1001/source.pdf',
        '00000000-0000-4000-8000-0000000c1001');
insert into public.chapters (id, workspace_id, document_id, document_revision_id, section_key,
                             level, title)
values ('40000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001',
        '20000000-0000-4000-8000-0000000c1001', '30000000-0000-4000-8000-0000000c1001',
        'sec-ch1', 1, '1장 물의 순환');
insert into public.question_import_runs (id, workspace_id, created_by) values
  ('50000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001',
   '00000000-0000-4000-8000-0000000c1001');
insert into public.question_drafts (id, workspace_id, source_type, import_run_id, position,
                                    question_type, payload)
values ('60000000-0000-4000-8000-0000000c1001', '10000000-0000-4000-8000-0000000c1001', 'import',
        '50000000-0000-4000-8000-0000000c1001', 0, 'ESSAY', '{}');

select col_default_is('public', 'question_drafts', 'chapter_manual', 'false',
  'a draft''s chapter is the suggestion by default');
select is((select chapter_id from public.question_drafts
            where id = '60000000-0000-4000-8000-0000000c1001'), null, 'no stored chapter');
select throws_ok(
  $$ update public.question_drafts set chapter_id = '40000000-0000-4000-8000-0000000c1001'
      where id = '60000000-0000-4000-8000-0000000c1001' $$,
  '23514', null, 'a stored chapter is a manual choice');
update public.question_drafts
   set chapter_id = '40000000-0000-4000-8000-0000000c1001', chapter_manual = true
 where id = '60000000-0000-4000-8000-0000000c1001';
delete from public.chapters where id = '40000000-0000-4000-8000-0000000c1001';
select results_eq(
  $$ select chapter_id, chapter_manual from public.question_drafts
      where id = '60000000-0000-4000-8000-0000000c1001' $$,
  $$ values (null::uuid, true) $$,
  'a deleted chapter leaves the manual choice "no chapter"');
select ok(not has_column_privilege('quiz_worker', 'public.question_drafts', 'chapter_id',
                                   'update'), 'quiz_worker cannot change a draft''s chapter');

select * from finish();
rollback;
