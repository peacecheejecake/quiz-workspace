-- M3.2a review fixes (20261017210000): NULL-safe provenance CHECK; the locking content guard still
-- freezes published revisions and works for both app roles. The two-session race itself is
-- covered by tests/integration/documents/test_revision_content_lock.py (pgTAP has one session).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000032b001', 'm32a-fix@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000032b001', 'm32a fix ws', '00000000-0000-4000-8000-00000032b001');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values
  ('20000000-0000-4000-8000-00000032b001', '10000000-0000-4000-8000-00000032b001', 'Fix',
   'fix.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-00000032b001/documents/20000000-0000-4000-8000-00000032b001/revisions/30000000-0000-4000-8000-00000032b001/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key)
values
  ('30000000-0000-4000-8000-00000032b001', '10000000-0000-4000-8000-00000032b001',
   '20000000-0000-4000-8000-00000032b001', 1,
   'workspaces/10000000-0000-4000-8000-00000032b001/documents/20000000-0000-4000-8000-00000032b001/revisions/30000000-0000-4000-8000-00000032b001/source.pdf'),
  ('30000000-0000-4000-8000-00000032b002', '10000000-0000-4000-8000-00000032b001',
   '20000000-0000-4000-8000-00000032b001', 2,
   'workspaces/10000000-0000-4000-8000-00000032b001/documents/20000000-0000-4000-8000-00000032b001/revisions/30000000-0000-4000-8000-00000032b001/source.pdf');

create function pg_temp.block(provenance text, block_id text default 'b-x') returns text
language sql as $$
  select format(
    'insert into public.content_blocks (workspace_id, document_id, document_revision_id, '
    'block_id, ordinal, block_type, page, provenance) values '
    '(%L, %L, %L, %L, (select count(*) from public.content_blocks), %L, 1, %L::jsonb)',
    '10000000-0000-4000-8000-00000032b001', '20000000-0000-4000-8000-00000032b001',
    '30000000-0000-4000-8000-00000032b001', block_id, 'text', provenance)
$$;
grant execute on function pg_temp.block(text, text) to quiz_api, quiz_worker;

-- Provenance shape (NULL-safe) ---------------------------------------------------------------------
select throws_ok(pg_temp.block('{}'), '23514', null, 'provenance without locations is rejected');
select throws_ok(pg_temp.block('{"source_block_ids": ["p-1"]}'), '23514', null,
  'provenance with other keys but no locations is rejected');
select throws_ok(pg_temp.block('{"locations": null}'), '23514', null,
  'null locations are rejected');
select throws_ok(pg_temp.block('{"locations": {"page": 1}}'), '23514', null,
  'object locations are rejected (no error from jsonb_array_length)');
select throws_ok(pg_temp.block('{"locations": "page 1"}'), '23514', null,
  'string locations are rejected');
select throws_ok(pg_temp.block('{"locations": []}'), '23514', null,
  'empty locations are rejected');
select throws_ok(pg_temp.block('[{"locations": [{"page": 1}]}]'), '23514', null,
  'a non-object provenance is rejected');
select throws_ok(pg_temp.block('"x"'), '23514', null, 'a scalar provenance is rejected');
select lives_ok(pg_temp.block('{"locations": [{"page": 1}]}', 'b-ok'),
  'a provenance with at least one location is accepted');
select is(
  (select convalidated from pg_constraint
    where conname = 'content_blocks_provenance_shape'
      and conrelid = 'public.content_blocks'::regclass),
  true, 'the replaced provenance CHECK is validated');

-- Locking guard: behaviour unchanged ---------------------------------------------------------------
grant quiz_api, quiz_worker to postgres;
grant usage on schema extensions to quiz_api, quiz_worker;

set local role quiz_worker;
select lives_ok(pg_temp.block('{"locations": [{"page": 1}]}', 'b-worker'),
  'quiz_worker writes draft content (FOR SHARE on the revision is allowed)');
reset role;
set local role quiz_api;
select lives_ok(
  $$ update public.content_blocks set text = 'corrected', edited = true
      where block_id = 'b-worker' $$,
  'quiz_api edits draft content');
reset role;

update public.document_revisions set status = 'published', published_at = now()
 where id = '30000000-0000-4000-8000-00000032b001';

set local role quiz_api;
select throws_ok(pg_temp.block('{"locations": [{"page": 1}]}', 'b-late'), '23514', null,
  'content cannot be added to a published revision');
select throws_ok(
  $$ update public.content_blocks set document_revision_id = '30000000-0000-4000-8000-00000032b002'
      where block_id = 'b-ok' $$,
  '23514', null, 'content cannot be moved out of a published revision');
reset role;
set local role quiz_worker;
select throws_ok(
  $$ delete from public.content_blocks where block_id = 'b-worker' $$,
  '23514', null, 'content of a published revision cannot be deleted');
reset role;

select lives_ok(
  $$ delete from public.workspaces where id = '10000000-0000-4000-8000-00000032b001' $$,
  'a workspace hard delete still cascades through published content');

select * from finish();
rollback;
