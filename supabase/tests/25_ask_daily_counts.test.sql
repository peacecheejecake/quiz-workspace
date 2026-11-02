-- ASK-B follow-up (20261102170000_ask_daily_counts.sql): every accepted answer counts for its
-- user's Asia/Seoul day, and the count survives deleting the conversation.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

select has_table('public', 'ask_daily_counts', 'ask_daily_counts exists');
select has_trigger('public', 'ask_messages', 'ask_messages_count_daily',
  'assistant messages are counted');
select table_privs_are('public', 'ask_daily_counts', 'quiz_api', array['SELECT'],
  'quiz_api only reads the counts');
select ok(not has_function_privilege('quiz_api', 'public.ask_messages_count_daily()', 'execute'),
  'the trigger function is not callable');

grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000a6001', 'ask-daily@example.test');
insert into public.workspaces (id, name, owner_id)
values ('10000000-0000-4000-8000-0000000a6001', 'ask daily', '00000000-0000-4000-8000-0000000a6001');
insert into public.workspace_memberships (workspace_id, user_id, role)
values ('10000000-0000-4000-8000-0000000a6001', '00000000-0000-4000-8000-0000000a6001', 'owner');

set local role quiz_api;
insert into public.ask_conversations (id, workspace_id, user_id)
values ('20000000-0000-4000-8000-0000000a6001', '10000000-0000-4000-8000-0000000a6001',
        '00000000-0000-4000-8000-0000000a6001');
insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, status, text)
values ('30000000-0000-4000-8000-0000000a6001', '20000000-0000-4000-8000-0000000a6001',
        '10000000-0000-4000-8000-0000000a6001', '00000000-0000-4000-8000-0000000a6001', 'user',
        'succeeded', 'q');
insert into public.ask_messages (id, conversation_id, workspace_id, user_id, role, status,
                                 question_message_id)
values ('30000000-0000-4000-8000-0000000a6002', '20000000-0000-4000-8000-0000000a6001',
        '10000000-0000-4000-8000-0000000a6001', '00000000-0000-4000-8000-0000000a6001',
        'assistant', 'queued', '30000000-0000-4000-8000-0000000a6001');
select is((select answers from public.ask_daily_counts
            where user_id = '00000000-0000-4000-8000-0000000a6001'
              and day = (now() at time zone 'Asia/Seoul')::date), 1,
  'an answer counts once; a question message does not');
select throws_ok($$
  insert into public.ask_daily_counts (user_id, day, answers)
  values ('00000000-0000-4000-8000-0000000a6001', current_date - 1, 0) $$,
  '42501', null, 'quiz_api cannot write counts');
delete from public.ask_conversations where id = '20000000-0000-4000-8000-0000000a6001';
select is((select count(*)::int from public.ask_messages
            where conversation_id = '20000000-0000-4000-8000-0000000a6001'), 0,
  'the conversation is gone');
select is((select answers from public.ask_daily_counts
            where user_id = '00000000-0000-4000-8000-0000000a6001'), 1,
  'its answer still counts');
reset role;

select * from finish();
rollback;
