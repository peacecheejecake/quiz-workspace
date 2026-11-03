-- ASK-B (20261104100000_ask.sql): AI question conversations, append-only messages, pinned
-- sources without text, one running answer per user, usage that outlives its conversation, the
-- worker's membership re-check, and conversations that go with a soft-deleted workspace.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

select has_table('public', 'ask_conversations', 'ask_conversations exists');
select has_table('public', 'ask_messages', 'ask_messages exists');
select has_table('public', 'ask_message_sources', 'ask_message_sources exists');
select has_table('public', 'ask_message_feedback', 'ask_message_feedback exists');
select has_table('public', 'llm_feature_usage', 'llm_feature_usage exists');
select is_empty(
  $$ select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'ask_message_sources'
        and column_name in ('text', 'excerpt', 'quote', 'body', 'content') $$,
  'pinned sources hold no passage text');
select fk_ok('public', 'ask_messages', array['workspace_id', 'user_id', 'conversation_id'],
             'public', 'ask_conversations', array['workspace_id', 'user_id', 'id'],
  'a message belongs to a conversation of its own user and workspace');
select index_is_unique('public', 'ask_messages', 'ask_messages_one_running_per_user');
select has_trigger('public', 'ask_messages', 'ask_messages_append_only', 'messages are append-only');
select has_trigger('public', 'workspaces', 'workspaces_drop_ask_conversations',
  'a soft-deleted workspace drops its conversations');
select table_privs_are('public', t, r, array[]::text[], format('%s has no privileges on %s', r, t))
from unnest(array['ask_conversations', 'ask_messages', 'ask_message_sources',
                  'ask_message_feedback', 'llm_feature_usage']) as t,
     unnest(array['anon', 'authenticated']) as r;
select ok(not has_function_privilege('quiz_api', 'public.worker_ask_member_active(uuid, uuid, boolean)',
                                     'execute'), 'quiz_api cannot call the worker re-check');
select ok(has_function_privilege('quiz_worker', 'public.worker_ask_member_active(uuid, uuid, boolean)',
                                 'execute'), 'quiz_worker calls the worker re-check');
select ok(not has_function_privilege('quiz_api', 'public.ask_messages_append_only()', 'execute'),
  'the trigger function is not callable');

-- Fixtures (superuser; rolled back) ------------------------------------------------------------
grant quiz_api to postgres;
grant quiz_worker to postgres;
grant usage on schema extensions to quiz_api, quiz_worker;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a5001', 'ask-u@example.test'),
  ('00000000-0000-4000-8000-0000000a5002', 'ask-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000a5001', 'ask w1', '00000000-0000-4000-8000-0000000a5001'),
  ('10000000-0000-4000-8000-0000000a5002', 'ask w2', '00000000-0000-4000-8000-0000000a5001');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5001', 'owner'),
  ('10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5002', 'viewer'),
  ('10000000-0000-4000-8000-0000000a5002', '00000000-0000-4000-8000-0000000a5001', 'owner');

set local role quiz_api;
select lives_ok($$
  insert into public.ask_conversations (id, workspace_id, user_id, title)
  values ('20000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5001',
          '00000000-0000-4000-8000-0000000a5002', 'q1'),
         ('20000000-0000-4000-8000-0000000a5002', '10000000-0000-4000-8000-0000000a5002',
          '00000000-0000-4000-8000-0000000a5001', 'q2') $$,
  'quiz_api creates conversations');
select throws_ok($$
  insert into public.ask_conversations (workspace_id, user_id, attachment_kind, attachment_view,
                                        attachment_label)
  values ('10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5002',
          'question', 'manage', 'x') $$,
  '23514', null, 'a bank question cannot be attached in the manage view');
select lives_ok($$
  insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, status, text)
  values ('30000000-0000-4000-8000-0000000a5001', '20000000-0000-4000-8000-0000000a5001',
          '10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5002', 'user',
          'succeeded', 'question?');
  insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, status,
                                   question_message_id)
  values ('30000000-0000-4000-8000-0000000a5002', '20000000-0000-4000-8000-0000000a5001',
          '10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5002',
          'assistant', 'queued', '30000000-0000-4000-8000-0000000a5001') $$,
  'quiz_api inserts a question and its queued answer');
select throws_ok($$
  insert into public.ask_messages (conversation_id, workspace_id, user_id, role, status, text)
  values ('20000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5002',
          '00000000-0000-4000-8000-0000000a5002', 'user', 'succeeded', 'x') $$,
  '23503', null, 'a message cannot claim another workspace than its conversation');
select throws_ok($$
  insert into public.ask_messages (conversation_id, workspace_id, user_id, role, status,
                                   question_message_id)
  values ('20000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5001',
          '00000000-0000-4000-8000-0000000a5002', 'assistant', 'queued',
          '30000000-0000-4000-8000-0000000a5001') $$,
  '23505', null, 'one queued or running answer per user');
select throws_ok($$
  insert into public.ask_messages (conversation_id, workspace_id, user_id, role, status,
                                   question_message_id, text, finished_at)
  values ('20000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5001',
          '00000000-0000-4000-8000-0000000a5002', 'assistant', 'succeeded',
          '30000000-0000-4000-8000-0000000a5001', 'made up', now()) $$,
  '42501', null, 'quiz_api cannot insert a finished answer');
reset role;
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key)
values ('40000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5001', 'B',
        'b.pdf', 10, repeat('a', 64),
        'workspaces/10000000-0000-4000-8000-0000000a5001/documents/40000000-0000-4000-8000-0000000a5001/revisions/41000000-0000-4000-8000-0000000a5001/source.pdf');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key, content_hash)
values ('41000000-0000-4000-8000-0000000a5001', '10000000-0000-4000-8000-0000000a5001',
        '40000000-0000-4000-8000-0000000a5001', 1,
        'workspaces/10000000-0000-4000-8000-0000000a5001/documents/40000000-0000-4000-8000-0000000a5001/revisions/41000000-0000-4000-8000-0000000a5001/source.pdf', repeat('b', 64));
set local role quiz_api;
select lives_ok($$
  insert into public.ask_message_sources (message_id, tag, rank, workspace_id, document_id,
                                          revision_id, block_ids, page_from, page_to, chunk_id,
                                          score, score_type)
  values ('30000000-0000-4000-8000-0000000a5002', 1, 1, '10000000-0000-4000-8000-0000000a5001',
          '40000000-0000-4000-8000-0000000a5001', '41000000-0000-4000-8000-0000000a5001',
          array['b1'], 2, 2, 'c1', 0.5, 'rrf') $$,
  'quiz_api pins a source reference');
select throws_ok($$
  insert into public.ask_message_sources (message_id, tag, rank, workspace_id, document_id,
                                          revision_id, block_ids, page_from, page_to, chunk_id,
                                          score, score_type, cited, number)
  values ('30000000-0000-4000-8000-0000000a5002', 2, 2, '10000000-0000-4000-8000-0000000a5001',
          '40000000-0000-4000-8000-0000000a5001', '41000000-0000-4000-8000-0000000a5001',
          array['b1'], 2, 2, 'c1', 0.5, 'rrf', true, 1) $$,
  '42501', null, 'only the worker marks a source cited');
reset role;

-- Worker: re-check, finish, usage -------------------------------------------------------------
set local role quiz_worker;
select ok(public.worker_ask_member_active('10000000-0000-4000-8000-0000000a5001',
                                          '00000000-0000-4000-8000-0000000a5002', true),
  'a viewer of an active workspace may still be answered');
select ok(not public.worker_ask_member_active('10000000-0000-4000-8000-0000000a5002',
                                              '00000000-0000-4000-8000-0000000a5002'),
  'a non-member may not');
select lives_ok($$
  update public.ask_message_sources set cited = true, number = 1
   where message_id = '30000000-0000-4000-8000-0000000a5002' and tag = 1;
  update public.ask_messages
     set status = 'succeeded', text = 'answer [1]', finished_at = now(), model = 'fake'
   where id = '30000000-0000-4000-8000-0000000a5002';
  insert into public.llm_feature_usage (feature, user_id, workspace_id, message_id, model,
                                        input_tokens, output_tokens, status)
  values ('ask', '00000000-0000-4000-8000-0000000a5002', '10000000-0000-4000-8000-0000000a5001',
          '30000000-0000-4000-8000-0000000a5002', 'fake', 10, 5, 'succeeded') $$,
  'quiz_worker finishes an answer, marks its citation and records usage');
reset role;

-- Append-only ---------------------------------------------------------------------------------
select throws_ok($$
  update public.ask_messages set text = 'changed' where id = '30000000-0000-4000-8000-0000000a5002' $$,
  '55000', null, 'a finished answer never changes (even for the superuser)');
select throws_ok($$
  delete from public.ask_messages where id = '30000000-0000-4000-8000-0000000a5002' $$,
  '55000', null, 'a message is never deleted on its own');
set local role quiz_api;
select is((select count(*)::int from public.ask_messages
            where id = '30000000-0000-4000-8000-0000000a5002' and status = 'stopped'), 0,
  'precondition: the answer is not stopped');
update public.ask_messages set status = 'stopped', finished_at = now()
 where id = '30000000-0000-4000-8000-0000000a5002';
select is((select status from public.ask_messages
            where id = '30000000-0000-4000-8000-0000000a5002'), 'succeeded',
  'quiz_api cannot stop a finished answer (policy hides it)');
reset role;

-- Cancel: a queued answer becomes stopped once, then it is final.
set local role quiz_api;
insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, status,
                                 question_message_id)
values ('30000000-0000-4000-8000-0000000a5003', '20000000-0000-4000-8000-0000000a5001',
        '10000000-0000-4000-8000-0000000a5001', '00000000-0000-4000-8000-0000000a5002',
        'assistant', 'queued', '30000000-0000-4000-8000-0000000a5001');
select lives_ok($$
  update public.ask_messages set status = 'stopped', finished_at = now()
   where id = '30000000-0000-4000-8000-0000000a5003' $$,
  'quiz_api stops a queued answer');
reset role;
select is((select status from public.ask_messages
            where id = '30000000-0000-4000-8000-0000000a5003'), 'stopped', 'the answer is stopped');
select throws_ok($$
  update public.ask_messages set text = 'late delta'
   where id = '30000000-0000-4000-8000-0000000a5003' $$,
  '55000', null, 'a stopped answer is final');

-- Feedback, delete cascade, usage kept ------------------------------------------------------
set local role quiz_api;
select lives_ok($$
  insert into public.ask_message_feedback (message_id, user_id, reason)
  values ('30000000-0000-4000-8000-0000000a5002', '00000000-0000-4000-8000-0000000a5002',
          'made_up') $$,
  'quiz_api stores a feedback reason');
select throws_ok($$
  insert into public.ask_message_feedback (message_id, user_id, reason)
  values ('30000000-0000-4000-8000-0000000a5003', '00000000-0000-4000-8000-0000000a5002',
          'free text') $$,
  '23514', null, 'feedback is a reason code only');
select lives_ok($$
  delete from public.ask_conversations where id = '20000000-0000-4000-8000-0000000a5001' $$,
  'deleting a conversation cascades past the append-only messages');
reset role;
select is((select count(*)::int from public.ask_messages
            where conversation_id = '20000000-0000-4000-8000-0000000a5001'), 0,
  'its messages are gone');
select is((select count(*)::int from public.ask_message_sources
            where message_id = '30000000-0000-4000-8000-0000000a5002'), 0,
  'its sources are gone');
select is((select count(*)::int from public.llm_feature_usage
            where user_id = '00000000-0000-4000-8000-0000000a5002' and message_id is null), 1,
  'its usage stays, unlinked');

-- Workspace soft delete drops conversations --------------------------------------------------
update public.workspaces set status = 'deleted', deleted_at = now()
 where id = '10000000-0000-4000-8000-0000000a5002';
select is((select count(*)::int from public.ask_conversations
            where workspace_id = '10000000-0000-4000-8000-0000000a5002'), 0,
  'a soft-deleted workspace has no conversations');

select * from finish();
rollback;
