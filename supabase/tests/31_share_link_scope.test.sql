-- UX12-SHARE (20261106140000): per-link scope flags. Defaults keep existing links as they are, the
-- API role can write them, and a fork copies notes, AI explanations and summaries only when the
-- flag was pinned on in the manifest and is still on at commit. Personal records are never copied,
-- whatever include_owner_records says.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

-- Shape, defaults, privileges -------------------------------------------------------------------
select col_not_null('public', 'workspace_share_links', c, format('%s is not null', c))
from unnest(array['include_notes', 'include_ai_explanations', 'include_summary',
                  'include_owner_records']) as c;
select col_default_is('public', 'workspace_share_links', c, 'true',
  format('%s is on by default, so existing links do not change', c))
from unnest(array['include_notes', 'include_ai_explanations', 'include_summary']) as c;
select col_default_is('public', 'workspace_share_links', 'include_owner_records', 'false',
  'owner records stay private unless the owner opts in');
select ok(
  has_column_privilege('quiz_api', 'public.workspace_share_links', c, 'SELECT')
  and has_column_privilege('quiz_api', 'public.workspace_share_links', c, 'INSERT')
  and has_column_privilege('quiz_api', 'public.workspace_share_links', c, 'UPDATE'),
  format('quiz_api reads and writes %s', c))
from unnest(array['include_notes', 'include_ai_explanations', 'include_summary',
                  'include_owner_records']) as c;
select ok(
  not has_table_privilege(r, 'public.workspace_share_links', 'SELECT'),
  format('%s cannot read share links', r))
from unnest(array['anon', 'authenticated']) as r;
select ok(
  (select prosecdef from pg_proc
    where oid = 'public.fork_item_included(public.workspace_forks, text)'::regprocedure)
  and not has_function_privilege(
        'quiz_worker', 'public.fork_item_included(public.workspace_forks, text)', 'EXECUTE')
  and not has_function_privilege(
        'quiz_api', 'public.fork_item_included(public.workspace_forks, text)', 'EXECUTE')
  and not has_function_privilege(
        'authenticated', 'public.fork_item_included(public.workspace_forks, text)', 'EXECUTE'),
  'the flag check runs only inside the commit and its triggers');

-- Fixtures (rolled back) ------------------------------------------------------------------------
-- A source workspace with one published document that has a summary (opted in), one chapter note
-- citing the one CONFIRMED question, one AI explanation, and the owner's attempt, study state and
-- highlight.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a501', 'scope-owner@example.test'),
  ('00000000-0000-4000-8000-00000000a502', 'scope-forker@example.test');
insert into public.workspaces (id, name, owner_id) values
  ('10000000-0000-4000-8000-00000000a501', 'scope', '00000000-0000-4000-8000-00000000a501');
insert into public.workspace_memberships (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-00000000a501', '00000000-0000-4000-8000-00000000a501', 'owner');
insert into public.documents
  (id, workspace_id, title, filename, size_bytes, sha256, source_object_key, summary_enabled_at,
   summary_enabled_by)
values
  ('20000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501', 'Book',
   'book.pdf', 10, repeat('a', 64),
   'workspaces/10000000-0000-4000-8000-00000000a501/documents/20000000-0000-4000-8000-00000000a501/revisions/30000000-0000-4000-8000-00000000a501/source.pdf',
   now(), '00000000-0000-4000-8000-00000000a501');
insert into public.document_revisions
  (id, workspace_id, document_id, revision_number, source_object_key, content_hash)
values
  ('30000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '20000000-0000-4000-8000-00000000a501', 1,
   'workspaces/10000000-0000-4000-8000-00000000a501/documents/20000000-0000-4000-8000-00000000a501/revisions/30000000-0000-4000-8000-00000000a501/source.pdf',
   repeat('1', 64));
insert into public.chapters
  (id, workspace_id, document_id, document_revision_id, section_key, level, title)
values
  ('40000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '20000000-0000-4000-8000-00000000a501', '30000000-0000-4000-8000-00000000a501', 'c1', 1, 'C');
update public.document_revisions set status = 'published', published_at = now()
 where id = '30000000-0000-4000-8000-00000000a501';
update public.documents
   set active_revision_id = '30000000-0000-4000-8000-00000000a501', status = 'ready'
 where id = '20000000-0000-4000-8000-00000000a501';
insert into public.questions (id, workspace_id, chapter_id, question_type, sort_order) values
  ('50000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '40000000-0000-4000-8000-00000000a501', 'MCQ', 1);
insert into public.question_revisions
  (id, workspace_id, question_id, version, stem, options, correct_option_ids, explanation)
values
  ('60000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '50000000-0000-4000-8000-00000000a501', 1, 'q1',
   '[{"id": "o1", "text": "A"}, {"id": "o2", "text": "B"}]', '{o1}', 'because A');
update public.questions
   set active_revision_id = '60000000-0000-4000-8000-00000000a501',
       publication_status = 'CONFIRMED'
 where id = '50000000-0000-4000-8000-00000000a501';

insert into public.document_summary_runs
  (id, workspace_id, document_id, document_revision_id, status, trigger, finished_at)
values
  ('70000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '20000000-0000-4000-8000-00000000a501', '30000000-0000-4000-8000-00000000a501', 'succeeded',
   'manual', now());
insert into public.document_summary_units
  (id, workspace_id, document_id, scope, section_key, input_hash, prompt_version, model, body)
values
  ('71000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '20000000-0000-4000-8000-00000000a501', 'document', 'document', repeat('b', 64), 'p', 'm', '{}');
insert into public.document_summary_run_units (workspace_id, run_id, unit_id, position) values
  ('10000000-0000-4000-8000-00000000a501', '70000000-0000-4000-8000-00000000a501',
   '71000000-0000-4000-8000-00000000a501', 0);

insert into public.chapter_notes
  (id, workspace_id, document_id, document_revision_id, section_key, input_fingerprint, body_hash,
   question_refs)
values
  ('72000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '20000000-0000-4000-8000-00000000a501', '30000000-0000-4000-8000-00000000a501', 'c1',
   repeat('0', 64), repeat('b', 64),
   '[{"tag": "Q1", "question_id": "50000000-0000-4000-8000-00000000a501",
      "question_revision_id": "60000000-0000-4000-8000-00000000a501", "label": "1장 1번"}]');
update public.chapter_notes set status = 'succeeded', version = 1, finished_at = now(),
       body = '{"sections": []}'
 where id = '72000000-0000-4000-8000-00000000a501';

insert into public.question_ai_explanations
  (id, workspace_id, question_id, question_revision_id, status, prompt_version, model, body,
   finished_at)
values
  ('73000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '50000000-0000-4000-8000-00000000a501', '60000000-0000-4000-8000-00000000a501', 'succeeded',
   'p', 'm', '{}', now());

insert into public.question_user_states (user_id, workspace_id, question_id, is_favorite)
values ('00000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
        '50000000-0000-4000-8000-00000000a501', true);
insert into public.practice_sessions
  (id, workspace_id, question_id, question_revision_id, user_id, state, submitted_at, graded_at)
values
  ('74000000-0000-4000-8000-00000000a501', '10000000-0000-4000-8000-00000000a501',
   '50000000-0000-4000-8000-00000000a501', '60000000-0000-4000-8000-00000000a501',
   '00000000-0000-4000-8000-00000000a501', 'graded', now(), now());
insert into public.question_attempts
  (workspace_id, question_id, question_revision_id, practice_session_id, user_id,
   submitted_answer, result, grading_method, submitted_at, graded_at)
values
  ('10000000-0000-4000-8000-00000000a501', '50000000-0000-4000-8000-00000000a501',
   '60000000-0000-4000-8000-00000000a501', '74000000-0000-4000-8000-00000000a501',
   '00000000-0000-4000-8000-00000000a501', '{}', 'correct', 'auto', now(), now());
insert into public.user_highlights
  (workspace_id, user_id, target_kind, question_id, question_revision_id, anchor, quote, color)
values
  ('10000000-0000-4000-8000-00000000a501', '00000000-0000-4000-8000-00000000a501', 'explanation',
   '50000000-0000-4000-8000-00000000a501', '60000000-0000-4000-8000-00000000a501',
   '{"block": "p0", "start": 0, "end": 7}', 'because', 'yellow');

-- One link and one fork per case. `pinned` is the manifest's `include` (null: an older manifest
-- without the key).
create function pg_temp.fork_case(n int, pinned jsonb, link_flags text) returns void
language plpgsql as $$
declare
  link uuid := ('80000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid;
  fork uuid := ('90000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid;
  target uuid := ('a0000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid;
  salt uuid := ('b0000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid;
begin
  insert into public.workspace_share_links (id, workspace_id, created_by, token_digest, allow_fork)
  values (link, '10000000-0000-4000-8000-00000000a501', '00000000-0000-4000-8000-00000000a501',
          sha256(n::text::bytea), true);
  execute format('update public.workspace_share_links set %s where id = %L', link_flags, link);
  insert into public.workspace_forks
    (id, source_workspace_id, source_share_link_id, forked_by, name, source_snapshot_manifest,
     origin_attribution)
  values (fork, '10000000-0000-4000-8000-00000000a501', link,
          '00000000-0000-4000-8000-00000000a502', 'copy',
          jsonb_strip_nulls(jsonb_build_object(
            'version', 3, 'id_salt', salt, 'target_workspace_id', target, 'include', pinned,
            'documents', jsonb_build_array(jsonb_build_object(
              'document_id', '20000000-0000-4000-8000-00000000a501',
              'revision_id', '30000000-0000-4000-8000-00000000a501')),
            'questions', jsonb_build_array(jsonb_build_object(
              'question_id', '50000000-0000-4000-8000-00000000a501',
              'revision_id', '60000000-0000-4000-8000-00000000a501',
              'sources', '[]'::jsonb)))),
          '{}'::jsonb);
end;
$$;

-- What landed in a fork's target workspace: summary runs, opt-ins, notes, AI explanations.
create function pg_temp.copied(n int) returns text language sql as $$
  select format('summaries=%s optin=%s notes=%s ai=%s',
    (select count(*) from public.document_summary_runs where workspace_id = t),
    (select count(*) from public.documents
      where workspace_id = t and summary_enabled_at is not null),
    (select count(*) from public.chapter_notes where workspace_id = t),
    (select count(*) from public.question_ai_explanations where workspace_id = t))
    from (select ('a0000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid as t) x
$$;

create function pg_temp.commit_fork(n int) returns text language sql as $$
  select public.worker_fork_commit(
    ('90000000-0000-4000-8000-00000000a5' || lpad(n::text, 2, '0'))::uuid)
$$;

create function pg_temp.flags(notes bool, ai bool, summary bool) returns jsonb language sql as $$
  select jsonb_build_object('notes', notes, 'ai_explanations', ai, 'summary', summary)
$$;

-- All on: everything is copied.
select pg_temp.fork_case(1, pg_temp.flags(true, true, true), 'include_notes = true');
select is(pg_temp.commit_fork(1), 'completed', 'a fork with everything on commits');
select is(pg_temp.copied(1), 'summaries=1 optin=1 notes=1 ai=1', 'everything on: all three copied');

-- An older manifest without `include` copies as before.
select pg_temp.fork_case(2, null, 'include_notes = true');
select is(pg_temp.commit_fork(2), 'completed', 'an older manifest commits');
select is(pg_temp.copied(2), 'summaries=1 optin=1 notes=1 ai=1',
  'an older manifest reads as all on');

-- Each flag off on the link alone, as it would be pinned and at commit.
select pg_temp.fork_case(3, pg_temp.flags(false, true, true), 'include_notes = false');
select is(pg_temp.commit_fork(3), 'completed', 'notes off: the fork still commits');
select is(pg_temp.copied(3), 'summaries=1 optin=1 notes=0 ai=1', 'notes off: no notes');

select pg_temp.fork_case(4, pg_temp.flags(true, false, true), 'include_ai_explanations = false');
select is(pg_temp.commit_fork(4), 'completed', 'AI off: the fork still commits');
select is(pg_temp.copied(4), 'summaries=1 optin=1 notes=1 ai=0', 'AI off: no AI explanations');

select pg_temp.fork_case(5, pg_temp.flags(true, true, false), 'include_summary = false');
select is(pg_temp.commit_fork(5), 'completed', 'summary off: the fork still commits');
select is(pg_temp.copied(5), 'summaries=0 optin=0 notes=1 ai=1',
  'summary off: no summary and no auto-refresh opt-in');

-- Turned off after the request (pinned on), and on after the request (pinned off).
select pg_temp.fork_case(6, pg_temp.flags(true, true, true),
  'include_notes = false, include_ai_explanations = false, include_summary = false');
select is(pg_temp.commit_fork(6), 'completed', 'flags turned off mid-fork never cancel it');
select is(pg_temp.copied(6), 'summaries=0 optin=0 notes=0 ai=0',
  'a flag off at commit wins over the pinned value');

select pg_temp.fork_case(7, pg_temp.flags(false, false, false), 'include_notes = true');
select is(pg_temp.commit_fork(7), 'completed', 'flags turned on mid-fork commit');
select is(pg_temp.copied(7), 'summaries=0 optin=0 notes=0 ai=0',
  'a flag off in the manifest wins over the link');

-- Owner records: on for this link, still never copied.
select pg_temp.fork_case(8, pg_temp.flags(true, true, true), 'include_owner_records = true');
select is(pg_temp.commit_fork(8), 'completed', 'owner records on: the fork commits');
select is(
  (select format('attempts=%s states=%s highlights=%s',
     (select count(*) from public.question_attempts
       where workspace_id = 'a0000000-0000-4000-8000-00000000a508'),
     (select count(*) from public.question_user_states
       where workspace_id = 'a0000000-0000-4000-8000-00000000a508'),
     (select count(*) from public.user_highlights
       where workspace_id = 'a0000000-0000-4000-8000-00000000a508'))),
  'attempts=0 states=0 highlights=0', 'owner records are never copied');

select * from finish();
rollback;
