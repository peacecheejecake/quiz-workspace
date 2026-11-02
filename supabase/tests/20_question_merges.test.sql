-- UX7-DEDUP (20261101120000_question_merges.sql): duplicate -> kept links, their grants and RLS,
-- link integrity (same workspace, no self link, one active link per duplicate, no chains), the
-- unarchive trigger and the merged study-state view.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(34);

-- Shape, grants, RLS ---------------------------------------------------------------------------
select has_table('public', 'question_merges', 'question_merges exists');
select columns_are('public', 'question_merges',
  array['id', 'workspace_id', 'duplicate_question_id', 'kept_question_id', 'created_by',
        'created_at', 'ended_at', 'ended_by', 'end_reason']);
select has_view('public', 'question_merged_user_states', 'the merged state view exists');
select ok((select relrowsecurity from pg_class where oid = 'public.question_merges'::regclass),
  'RLS is enabled on question_merges');
select ok((select 'security_invoker=true' = any(reloptions) from pg_class
            where oid = 'public.question_merged_user_states'::regclass),
  'the view runs with the caller''s privileges (RLS of the base tables applies)');
select table_privs_are('public', 'question_merges', 'quiz_api', array['SELECT', 'INSERT'],
  'quiz_api reads and inserts links (no table-wide UPDATE, no DELETE)');
select ok(has_column_privilege('quiz_api', 'public.question_merges', 'ended_at', 'update')
          and has_column_privilege('quiz_api', 'public.question_merges', 'end_reason', 'update')
          and not has_column_privilege('quiz_api', 'public.question_merges', 'kept_question_id',
                                       'update')
          and not has_column_privilege('quiz_api', 'public.question_merges',
                                       'duplicate_question_id', 'update'),
  'quiz_api can only end a link, never re-point it');
select table_privs_are('public', 'question_merged_user_states', 'quiz_api', array['SELECT'],
  'quiz_api reads the view');
select table_privs_are('public', t, r, array[]::text[],
  format('%s has no privileges on %s', r, t))
  from unnest(array['quiz_worker', 'anon', 'authenticated']) as r,
       unnest(array['question_merges', 'question_merged_user_states']) as t;
select ok(not has_function_privilege('quiz_api', 'public.question_merges_check_link()', 'execute')
          and not has_function_privilege('quiz_api', 'public.question_merges_end_on_restore()',
                                         'execute'),
  'trigger functions are not callable');
select has_index('public', 'question_merges', 'question_merges_active_duplicate_key',
  'one active link per duplicate');

-- Fixtures: workspace w1 with questions k (kept), d (duplicate), e (second duplicate), x (kept of
-- an older merge); workspace w2 with question o. User u has state on k and d. ------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000d0001', 'dedup-u@example.test'),
  ('00000000-0000-4000-8000-0000000d0002', 'dedup-v@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-0000000d0001', 'dedup w1', '00000000-0000-4000-8000-0000000d0001'),
  ('10000000-0000-4000-8000-0000000d0002', 'dedup w2', '00000000-0000-4000-8000-0000000d0001');
insert into public.questions (id, workspace_id, question_type, sort_order) values
  ('20000000-0000-4000-8000-0000000d000a', '10000000-0000-4000-8000-0000000d0001', 'SHORT_ANSWER', 1),
  ('20000000-0000-4000-8000-0000000d000b', '10000000-0000-4000-8000-0000000d0001', 'SHORT_ANSWER', 2),
  ('20000000-0000-4000-8000-0000000d000c', '10000000-0000-4000-8000-0000000d0001', 'SHORT_ANSWER', 3),
  ('20000000-0000-4000-8000-0000000d000d', '10000000-0000-4000-8000-0000000d0001', 'SHORT_ANSWER', 4),
  ('20000000-0000-4000-8000-0000000d000e', '10000000-0000-4000-8000-0000000d0002', 'SHORT_ANSWER', 1);
insert into public.question_revisions (id, workspace_id, question_id, version, stem)
select ('30000000-0000-4000-8000-0000000d000' || x)::uuid, w::uuid,
       ('20000000-0000-4000-8000-0000000d000' || x)::uuid, 1, 'Same stem'
  from (values ('a', '10000000-0000-4000-8000-0000000d0001'),
               ('b', '10000000-0000-4000-8000-0000000d0001'),
               ('c', '10000000-0000-4000-8000-0000000d0001'),
               ('d', '10000000-0000-4000-8000-0000000d0001'),
               ('e', '10000000-0000-4000-8000-0000000d0002')) as v(x, w);
update public.questions
   set active_revision_id = ('30000000-0000-4000-8000-0000000d000' || right(id::text, 1))::uuid,
       publication_status = 'CONFIRMED'
 where id::text like '20000000-0000-4000-8000-0000000d000_';
-- a = kept, b and c = duplicates (archived), d = an unrelated question, e = other workspace.
update public.questions set publication_status = 'ARCHIVED'
 where id in ('20000000-0000-4000-8000-0000000d000b', '20000000-0000-4000-8000-0000000d000c');

-- Graded attempts: u answered a correctly at 09:00 and b incorrectly at 10:00 (later).
insert into public.practice_sessions
  (id, workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at)
values
  ('40000000-0000-4000-8000-0000000d000a', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000a', '30000000-0000-4000-8000-0000000d000a',
   '00000000-0000-4000-8000-0000000d0001', 'graded', '2026-10-01T09:00Z', '2026-10-01T09:00Z'),
  ('40000000-0000-4000-8000-0000000d000b', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000b', '30000000-0000-4000-8000-0000000d000b',
   '00000000-0000-4000-8000-0000000d0001', 'graded', '2026-10-01T10:00Z', '2026-10-01T10:00Z');
insert into public.question_attempts
  (id, workspace_id, question_id, question_revision_id, practice_session_id, user_id,
   submitted_answer, result, grading_method, submitted_at, graded_at)
values
  ('50000000-0000-4000-8000-0000000d000a', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000a', '30000000-0000-4000-8000-0000000d000a',
   '40000000-0000-4000-8000-0000000d000a', '00000000-0000-4000-8000-0000000d0001', '{}',
   'correct', 'auto', '2026-10-01T09:00Z', '2026-10-01T09:00Z'),
  ('50000000-0000-4000-8000-0000000d000b', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000b', '30000000-0000-4000-8000-0000000d000b',
   '40000000-0000-4000-8000-0000000d000b', '00000000-0000-4000-8000-0000000d0001', '{}',
   'incorrect', 'auto', '2026-10-01T10:00Z', '2026-10-01T10:00Z');
insert into public.question_user_states
  (user_id, question_id, workspace_id, first_viewed_at, last_viewed_at, last_graded_result,
   last_graded_attempt_id, is_favorite, needs_retry)
values
  ('00000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000a',
   '10000000-0000-4000-8000-0000000d0001', '2026-10-01T08:00Z', '2026-10-01T09:00Z', 'correct',
   '50000000-0000-4000-8000-0000000d000a', false, false),
  ('00000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000b',
   '10000000-0000-4000-8000-0000000d0001', '2026-09-30T08:00Z', '2026-10-01T10:00Z', 'incorrect',
   '50000000-0000-4000-8000-0000000d000b', true, false),
  ('00000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000c',
   '10000000-0000-4000-8000-0000000d0001', null, null, null, null, false, true);

-- Before any merge the view is the plain state, one row per question.
select is((select count(*)::int from public.question_merged_user_states
            where user_id = '00000000-0000-4000-8000-0000000d0001'),
  3, 'unmerged: one row per stateful question');

-- Link integrity -------------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
     values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000a',
             '20000000-0000-4000-8000-0000000d000a') $$,
  '23514', null, 'a question cannot be merged into itself');
select throws_ok(
  $$ insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
     values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000b',
             '20000000-0000-4000-8000-0000000d000e') $$,
  '23503', null, 'both ends must be questions of the link''s workspace');

insert into public.question_merges (id, workspace_id, duplicate_question_id, kept_question_id,
                                    created_by)
values
  ('60000000-0000-4000-8000-0000000d000b', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000b', '20000000-0000-4000-8000-0000000d000a',
   '00000000-0000-4000-8000-0000000d0001'),
  ('60000000-0000-4000-8000-0000000d000c', '10000000-0000-4000-8000-0000000d0001',
   '20000000-0000-4000-8000-0000000d000c', '20000000-0000-4000-8000-0000000d000a',
   '00000000-0000-4000-8000-0000000d0001');

select throws_ok(
  $$ insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
     values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000b',
             '20000000-0000-4000-8000-0000000d000d') $$,
  '23505', null, 'a duplicate has one active link');
select throws_ok(
  $$ insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
     values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000d',
             '20000000-0000-4000-8000-0000000d000b') $$,
  '23514', null, 'no chain: an active duplicate cannot be a kept question');
select throws_ok(
  $$ insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
     values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000a',
             '20000000-0000-4000-8000-0000000d000d') $$,
  '23514', null, 'no chain: a kept question with active duplicates cannot become a duplicate');

-- Merged state ---------------------------------------------------------------------------------
select results_eq(
  $$ select question_id, first_viewed_at, last_viewed_at, last_graded_result,
            last_graded_attempt_id, is_favorite, needs_retry, merged_states::int
       from public.question_merged_user_states
      where user_id = '00000000-0000-4000-8000-0000000d0001'
        and workspace_id = '10000000-0000-4000-8000-0000000d0001' $$,
  $$ values ('20000000-0000-4000-8000-0000000d000a'::uuid, '2026-09-30T08:00Z'::timestamptz,
             '2026-10-01T10:00Z'::timestamptz, 'incorrect'::text,
             '50000000-0000-4000-8000-0000000d000b'::uuid, true, true, 2) $$,
  'the kept question folds its duplicates: earliest view, latest grade, OR of the flags');
select is((select count(*)::int from public.question_merged_user_states
            where user_id = '00000000-0000-4000-8000-0000000d0002'),
  0, 'another user sees none of these states');
select is((select count(*)::int from public.question_attempts
            where workspace_id = '10000000-0000-4000-8000-0000000d0001'),
  2, 'attempts are untouched by merging');

-- quiz_api can end a link but not re-point or delete one. Test-only (rolled back), as in
-- 02_security: postgres may switch to quiz_api, which may run the pgTAP assertions.
grant quiz_api to postgres;
grant usage on schema extensions to quiz_api;
set local role quiz_api;
select throws_ok(
  $$ update public.question_merges set kept_question_id = '20000000-0000-4000-8000-0000000d000d'
      where id = '60000000-0000-4000-8000-0000000d000b' $$,
  '42501', null, 'quiz_api cannot re-point a link');
select throws_ok(
  $$ delete from public.question_merges where id = '60000000-0000-4000-8000-0000000d000b' $$,
  '42501', null, 'quiz_api cannot delete a link');
select is((select count(*)::int from public.question_merged_user_states
            where user_id = '00000000-0000-4000-8000-0000000d0001'
              and workspace_id = '10000000-0000-4000-8000-0000000d0001'),
  1, 'quiz_api reads the merged view');

-- Unarchive = unmerge (trigger, as quiz_api's PATCH would run it).
update public.questions set publication_status = 'CONFIRMED'
 where id = '20000000-0000-4000-8000-0000000d000b';
reset role;
select is((select end_reason from public.question_merges
            where id = '60000000-0000-4000-8000-0000000d000b'),
  'unarchived', 'unarchiving a duplicate ends its link');
select ok((select ended_at is not null and ended_by is null from public.question_merges
            where id = '60000000-0000-4000-8000-0000000d000b'),
  'the trigger stamps ended_at');
select is((select end_reason from public.question_merges
            where id = '60000000-0000-4000-8000-0000000d000c'),
  null, 'the other duplicate stays merged');
select results_eq(
  $$ select question_id, last_graded_result, is_favorite, needs_retry
       from public.question_merged_user_states
      where user_id = '00000000-0000-4000-8000-0000000d0001'
        and workspace_id = '10000000-0000-4000-8000-0000000d0001'
      order by question_id $$,
  $$ values ('20000000-0000-4000-8000-0000000d000a'::uuid, 'correct'::text, false, true),
            ('20000000-0000-4000-8000-0000000d000b'::uuid, 'incorrect'::text, true, false) $$,
  'after unmerging, each question has its own records again (c still folds into a)');

-- Re-merging after an unmerge is a new link (history kept); ending a link allows re-pointing.
insert into public.question_merges (workspace_id, duplicate_question_id, kept_question_id)
values ('10000000-0000-4000-8000-0000000d0001', '20000000-0000-4000-8000-0000000d000b',
        '20000000-0000-4000-8000-0000000d000a');
select is((select count(*)::int from public.question_merges
            where duplicate_question_id = '20000000-0000-4000-8000-0000000d000b'),
  2, 'links are history: the ended link stays next to the new one');
select throws_ok(
  $$ update public.question_merges set ended_at = now()
      where id = '60000000-0000-4000-8000-0000000d000c' $$,
  '23514', null, 'an ended link needs its reason');

select * from finish();
rollback;
