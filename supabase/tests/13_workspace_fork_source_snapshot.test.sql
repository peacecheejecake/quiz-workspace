-- S3a review fix (20261018200000): worker_fork_commit copies the question sources pinned in the
-- manifest at request time, not the (mutable) question_sources rows at commit time; manifests
-- without `sources` keep reading the table (12_workspace_forks covers that path).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000f101', 's3a-src-owner@example.test'),
  ('00000000-0000-4000-8000-00000000f102', 's3a-src-recipient@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000000f101', 's3a src', '00000000-0000-4000-8000-00000000f101');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101', 'Book',
   'book.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-00000000f101/documents/20000000-0000-4000-8000-00000000f101/revisions/30000000-0000-4000-8000-00000000f101/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key, content_hash)
values
  ('30000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101',
   '20000000-0000-4000-8000-00000000f101', 1,
   'workspaces/10000000-0000-4000-8000-00000000f101/documents/20000000-0000-4000-8000-00000000f101/revisions/30000000-0000-4000-8000-00000000f101/source.pdf',
   repeat('1', 64));
update public.document_revisions set status = 'published', published_at = now()
 where id = '30000000-0000-4000-8000-00000000f101';
update public.documents set active_revision_id = '30000000-0000-4000-8000-00000000f101',
       status = 'ready'
 where id = '20000000-0000-4000-8000-00000000f101';
insert into public.questions (id, workspace_id, question_type) values
  ('50000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101', 'ESSAY');
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('60000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101',
   '50000000-0000-4000-8000-00000000f101', 1, 'q');
update public.questions set active_revision_id = '60000000-0000-4000-8000-00000000f101',
       publication_status = 'CONFIRMED'
 where id = '50000000-0000-4000-8000-00000000f101';
-- The source as it is now (and as the API pins it below) ...
insert into public.question_sources
  (id, workspace_id, question_id, document_id, document_revision_id, page_start, page_end,
   block_ids, locations)
values
  ('70000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101',
   '50000000-0000-4000-8000-00000000f101', '20000000-0000-4000-8000-00000000f101',
   '30000000-0000-4000-8000-00000000f101', 7, 7, '{b-old}', '[{"page": 7}]');
insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, allow_fork)
values ('80000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101',
        '00000000-0000-4000-8000-00000000f101', sha256('\xf101'::bytea), true);
insert into public.workspace_forks
  (id, source_workspace_id, source_share_link_id, forked_by, name, source_snapshot_manifest,
   origin_attribution)
values (
  '90000000-0000-4000-8000-00000000f101', '10000000-0000-4000-8000-00000000f101',
  '80000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000f102', 'fork',
  jsonb_build_object(
    'version', 2, 'id_salt', gen_random_uuid(),
    'target_workspace_id', 'a0000000-0000-4000-8000-00000000f101',
    'documents', jsonb_build_array(jsonb_build_object(
      'document_id', '20000000-0000-4000-8000-00000000f101',
      'revision_id', '30000000-0000-4000-8000-00000000f101')),
    'questions', jsonb_build_array(jsonb_build_object(
      'question_id', '50000000-0000-4000-8000-00000000f101',
      'revision_id', '60000000-0000-4000-8000-00000000f101',
      'sources', jsonb_build_array(
        jsonb_build_object(
          'id', '70000000-0000-4000-8000-00000000f101',
          'document_id', '20000000-0000-4000-8000-00000000f101',
          'document_revision_id', '30000000-0000-4000-8000-00000000f101',
          'page_start', 7, 'page_end', 7, 'block_ids', jsonb_build_array('b-old'),
          'locations', '[{"page": 7}]'::jsonb),
        -- A source in a document that is not part of the snapshot is dropped.
        jsonb_build_object(
          'id', '70000000-0000-4000-8000-00000000f109',
          'document_id', '20000000-0000-4000-8000-00000000f109',
          'document_revision_id', null, 'page_start', null, 'page_end', null,
          'block_ids', '[]'::jsonb, 'locations', '[]'::jsonb))))),
  '{}'::jsonb);

-- ... then the owner edits the question's sources before the worker commits.
delete from public.question_sources where question_id = '50000000-0000-4000-8000-00000000f101';
insert into public.question_sources
  (workspace_id, question_id, document_id, page_start, page_end, block_ids)
values
  ('10000000-0000-4000-8000-00000000f101', '50000000-0000-4000-8000-00000000f101',
   '20000000-0000-4000-8000-00000000f101', 9, 9, '{b-new}'),
  ('10000000-0000-4000-8000-00000000f101', '50000000-0000-4000-8000-00000000f101',
   '20000000-0000-4000-8000-00000000f101', 10, 10, '{b-new2}');

grant quiz_worker to postgres;
grant usage on schema extensions to quiz_worker;
set local role quiz_worker;
select is(public.worker_fork_commit('90000000-0000-4000-8000-00000000f101'), 'completed',
  'the fork commits');
reset role;

select is(
  (select count(*)::int from public.question_sources
    where workspace_id = 'a0000000-0000-4000-8000-00000000f101'),
  1, 'only the pinned source in a copied document is copied');
select is(
  (select (s.page_start, s.page_end, s.block_ids, s.locations)::text
     from public.question_sources s
    where s.workspace_id = 'a0000000-0000-4000-8000-00000000f101'),
  '(7,7,{b-old},"[{""page"": 7}]")', 'the copy has the source pinned at request time');
select is(
  (select (s.document_id = d.id, s.document_revision_id = d.active_revision_id,
           s.id <> '70000000-0000-4000-8000-00000000f101')::text
     from public.question_sources s
     join public.documents d on d.workspace_id = s.workspace_id
    where s.workspace_id = 'a0000000-0000-4000-8000-00000000f101'),
  '(t,t,t)', 'the pinned source is remapped to the copied document, revision and a new id');
select is(
  (select count(*)::int from public.question_sources
    where workspace_id = '10000000-0000-4000-8000-00000000f101'),
  2, 'the source keeps its edited sources');

select * from finish();
rollback;
