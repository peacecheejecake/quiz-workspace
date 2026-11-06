-- UX12 MOCKUX-7 (20261106180000): `resume_dismissed_at` takes a run out of the `이어 풀기` list and
-- is the one more thing quiz_api may change on a run. item_ids and the rest stay immutable.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

select col_type_is('public', 'practice_runs', 'resume_dismissed_at', 'timestamp with time zone',
  'practice_runs.resume_dismissed_at is a timestamp');
select col_is_null('public', 'practice_runs', 'resume_dismissed_at',
  'practice_runs.resume_dismissed_at is nullable');
select ok(has_column_privilege('quiz_api', 'public.practice_runs', 'resume_dismissed_at', 'update')
  and not has_column_privilege('anon', 'public.practice_runs', 'resume_dismissed_at', 'update')
  and not has_column_privilege('authenticated', 'public.practice_runs', 'resume_dismissed_at', 'update'),
  'quiz_api alone may set resume_dismissed_at');

insert into auth.users (id, email)
 values ('00000000-0000-4000-8000-000000120001', 'resume@example.test');
insert into public.workspaces (id, name, owner_id)
 values ('10000000-0000-4000-8000-000000120001', 'w', '00000000-0000-4000-8000-000000120001');
insert into public.practice_runs (id, workspace_id, user_id, source, range, random_order, seed, item_ids)
 values ('a0000000-0000-4000-8000-000000120001', '10000000-0000-4000-8000-000000120001',
         '00000000-0000-4000-8000-000000120001', 'bank', '{}', false, 1,
         array['20000000-0000-4000-8000-000000120001']::uuid[]);

set local role quiz_api;
select lives_ok(
  $$ update public.practice_runs set resume_dismissed_at = now()
     where id = 'a0000000-0000-4000-8000-000000120001' $$,
  'quiz_api dismisses a run');
reset role;
select throws_ok(
  $$ update public.practice_runs set seed = 2, resume_dismissed_at = now()
     where id = 'a0000000-0000-4000-8000-000000120001' $$,
  '23514', null, 'the run itself stays immutable');

select * from finish();
rollback;
