-- UX10-QVIEW: reset epochs preserve immutable attempts and remain private to the API role.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);
select has_table('public', 'practice_reset_epochs', 'personal reset epochs exist');
select columns_are('public', 'practice_reset_epochs',
  array['user_id', 'question_id', 'epoch', 'reset_at'], 'epoch boundary has the expected fields');
select col_default_is('public', 'practice_reset_epochs', 'epoch', 0::bigint, 'epoch starts at zero');
select has_column('public', 'practice_sessions', 'reset_epoch', 'sessions pin their epoch');
select ok((select relrowsecurity from pg_class where oid = 'public.practice_reset_epochs'::regclass),
  'row level security is enabled');
select ok(not has_table_privilege('anon', 'public.practice_reset_epochs', 'SELECT'),
  'anonymous clients cannot read reset epochs');
select ok(not has_table_privilege('authenticated', 'public.practice_reset_epochs', 'SELECT'),
  'browser users cannot read reset epochs directly');
select ok(has_table_privilege('quiz_api', 'public.practice_reset_epochs', 'SELECT, INSERT, UPDATE')
  and not has_table_privilege('quiz_api', 'public.practice_reset_epochs', 'DELETE'),
  'API can advance epochs but cannot delete them');
-- Two users retain separate boundaries; advancing one never changes immutable attempts.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000f0001', 'reset-u@example.test'),
  ('00000000-0000-4000-8000-0000000f0002', 'reset-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000f0001', 'reset test', '00000000-0000-4000-8000-0000000f0001');
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('20000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001', 'SHORT_ANSWER', 1);
insert into public.question_revisions (id, workspace_id, question_id, version, stem) values
  ('30000000-0000-4000-8000-0000000f0001', '10000000-0000-4000-8000-0000000f0001',
   '20000000-0000-4000-8000-0000000f0001', 1, 'Synthetic question');
insert into public.practice_sessions (id, workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at)
select ('40000000-0000-4000-8000-0000000f000' || n)::uuid,
  '10000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001',
  '30000000-0000-4000-8000-0000000f0001', ('00000000-0000-4000-8000-0000000f000' || n)::uuid,
  'graded', now(), now() from generate_series(1, 2) as n;
insert into public.question_attempts (workspace_id, question_id, question_revision_id,
  practice_session_id, user_id, submitted_answer, result, grading_method, submitted_at, graded_at)
select workspace_id, question_id, question_revision_id, id, user_id, '{}'::jsonb, 'correct', 'auto', now(), now()
from public.practice_sessions where id::text like '40000000-0000-4000-8000-0000000f000_';
insert into public.practice_reset_epochs (user_id, question_id, epoch, reset_at) values
  ('00000000-0000-4000-8000-0000000f0001', '20000000-0000-4000-8000-0000000f0001', 1, now());
select is((select count(*) from public.question_attempts where question_id = '20000000-0000-4000-8000-0000000f0001'),
  2::bigint, 'both immutable attempts remain');
select is((select count(*) from public.practice_sessions s where s.user_id = '00000000-0000-4000-8000-0000000f0001'
  and not exists (select 1 from public.practice_reset_epochs e where e.user_id = s.user_id
    and e.question_id = s.question_id and e.epoch > s.reset_epoch)), 0::bigint, 'old epoch is hidden');
select is((select count(*) from public.practice_sessions s where s.user_id = '00000000-0000-4000-8000-0000000f0002'
  and not exists (select 1 from public.practice_reset_epochs e where e.user_id = s.user_id
    and e.question_id = s.question_id and e.epoch > s.reset_epoch)), 1::bigint, 'other user remains visible');
select * from finish();
rollback;
