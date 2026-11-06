-- UX12 EXTRACT-9 (20261106160000): stem_tables columns, their shape and size constraint, and Fork
-- carrying the cells. Registration of a draft's cells is in 15_question_import_registration.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

select col_type_is('public', 'question_revisions', 'stem_tables', 'jsonb');
select col_is_null('public', 'question_revisions', 'stem_tables');
select col_type_is('public', 'mock_exam_question_revisions', 'stem_tables', 'jsonb');
select col_is_null('public', 'mock_exam_question_revisions', 'stem_tables');
select ok(has_function_privilege('quiz_api', 'public.stem_tables_valid(jsonb)', 'execute')
  and has_function_privilege('quiz_worker', 'public.stem_tables_valid(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.stem_tables_valid(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.stem_tables_valid(jsonb)', 'execute'),
  'the writing roles run the check, nobody else');

select ok(public.stem_tables_valid(
  '[{"rows": [["a"]], "header_rows": 1, "spans": [{"row": 0, "col": 0, "row_span": 1, "col_span": 2}]}, null]'),
  'an entry with spans and a null entry pass');
select ok(public.stem_tables_valid('[{"rows": [["a"]], "header_rows": 0}]'),
  'spans are optional');
select ok(not public.stem_tables_valid('[]'), 'an empty list is refused: no cells is null');
select ok(not public.stem_tables_valid('{"rows": [["a"]], "header_rows": 0}'), 'not a list');
select ok(not public.stem_tables_valid('[{"rows": [], "header_rows": 0}]'), 'no rows');
select ok(not public.stem_tables_valid('[{"rows": [["a"]]}]'), 'no header_rows');
select ok(not public.stem_tables_valid('[{"rows": [["a"]], "header_rows": 0, "spans": 3}]'),
  'spans of another type');
select ok(not public.stem_tables_valid(
  to_jsonb(array_fill('null'::jsonb, array[51]))), 'too many entries');
select ok(not public.stem_tables_valid(
  jsonb_build_array(jsonb_build_object('rows', jsonb_build_array(jsonb_build_array(repeat('x', 200001))),
                                       'header_rows', 0))), 'too many bytes');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000f301', 'stem-tables-owner@example.test'),
  ('00000000-0000-4000-8000-00000000f302', 'stem-tables-recipient@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000000f301', 'stem tables', '00000000-0000-4000-8000-00000000f301');
insert into public.questions (id, workspace_id, question_type) values
  ('50000000-0000-4000-8000-00000000f301', '10000000-0000-4000-8000-00000000f301', 'ESSAY');
insert into public.question_revisions (id, workspace_id, question_id, version, stem, stem_tables)
values
  ('60000000-0000-4000-8000-00000000f301', '10000000-0000-4000-8000-00000000f301',
   '50000000-0000-4000-8000-00000000f301', 1, E'| a | a |\n| --- | --- |\n| 1 | 2 |',
   '[{"rows": [["a", "a"], ["1", "2"]], "header_rows": 1,
      "spans": [{"row": 0, "col": 0, "row_span": 1, "col_span": 2}]}]');
update public.questions set active_revision_id = '60000000-0000-4000-8000-00000000f301',
       publication_status = 'CONFIRMED'
 where id = '50000000-0000-4000-8000-00000000f301';
insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, allow_fork)
values ('80000000-0000-4000-8000-00000000f301', '10000000-0000-4000-8000-00000000f301',
        '00000000-0000-4000-8000-00000000f301', sha256('\xf301'::bytea), true);
insert into public.workspace_forks
  (id, source_workspace_id, source_share_link_id, forked_by, name, source_snapshot_manifest,
   origin_attribution)
values (
  '90000000-0000-4000-8000-00000000f301', '10000000-0000-4000-8000-00000000f301',
  '80000000-0000-4000-8000-00000000f301', '00000000-0000-4000-8000-00000000f302', 'fork',
  jsonb_build_object(
    'version', 2, 'id_salt', gen_random_uuid(),
    'target_workspace_id', 'a0000000-0000-4000-8000-00000000f301',
    'documents', '[]'::jsonb,
    'questions', jsonb_build_array(jsonb_build_object(
      'question_id', '50000000-0000-4000-8000-00000000f301',
      'revision_id', '60000000-0000-4000-8000-00000000f301',
      'sources', '[]'::jsonb))),
  '{}'::jsonb);

grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f301'), 'completed',
  'the fork commits');
reset role;
select is(
  (select stem_tables from public.question_revisions
    where workspace_id = 'a0000000-0000-4000-8000-00000000f301'),
  (select stem_tables from public.question_revisions
    where id = '60000000-0000-4000-8000-00000000f301'),
  'the copy carries the cells');

select * from finish();
rollback;
