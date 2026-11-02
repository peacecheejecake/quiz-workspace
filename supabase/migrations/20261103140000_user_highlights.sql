-- UX9-HL-B: personal highlights (docs/screens/highlights.md HILITE-01-C01~C08, docs/questions.md
-- §15, docs/architecture.md §5 `user_highlights`, docs/workspace-sharing.md §11).
--
-- One row = one highlight of one user on one target:
--   note          a chapter note *version* (chapter_notes row; versions never change, so its
--                 anchor is always exact)
--   explanation   a question's human explanation; question_revision_id is the revision the
--                 highlight was made on (the API re-finds the quote in the current revision)
--   ai_explanation  AIEXPL-01 (`question_ai_explanations`, not merged yet): refused by the
--                 check `user_highlights_ai_explanation_pending` until the migration that adds
--                 that table adds the FK and drops the check (UX9-HL-AIEXPL).
-- anchor {block, start, end}: block "s<i>.i<j>" (note item) or "p<i>" (explanation paragraph),
-- UTF-16 offsets, end exclusive. quote (1..2,000 chars) and prefix/suffix (<= 32 chars around it)
-- are cut by the API from the stored text, never taken from the client.
--
-- Personal record: never shared (share API) and never copied by forks (worker_fork_commit copies
-- an explicit table list without this one). No activity events. Rows are soft-deleted
-- (`deleted_at`); `replaced_by` marks rows merged into a new highlight (`replace_ids`), which are
-- never restored. Hard deletes only come from cascades (question / note / workspace / user).
--
-- Additive only: one new table, its indexes, trigger, grants and RLS policies.
--
-- quiz_api: select, insert, update(color, version, deleted_at, replaced_by, updated_at); no delete.
-- quiz_worker, anon, authenticated: nothing.

create table public.user_highlights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  target_kind text not null,
  chapter_note_id uuid,
  question_id uuid,
  question_revision_id uuid,
  ai_explanation_id uuid,
  anchor jsonb not null,
  quote text not null,
  prefix text not null default '',
  suffix text not null default '',
  color text not null,
  version integer not null default 1,
  replaced_by uuid references public.user_highlights (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint user_highlights_note_fk foreign key (workspace_id, chapter_note_id)
    references public.chapter_notes (workspace_id, id) on delete cascade,
  constraint user_highlights_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint user_highlights_revision_fk
    foreign key (workspace_id, question_id, question_revision_id)
    references public.question_revisions (workspace_id, question_id, id) on delete cascade,
  constraint user_highlights_target_kind_valid
    check (target_kind in ('note', 'explanation', 'ai_explanation')),
  constraint user_highlights_target_columns check (
    case target_kind
      when 'note' then chapter_note_id is not null and question_id is null
                       and question_revision_id is null and ai_explanation_id is null
      when 'explanation' then chapter_note_id is null and question_id is not null
                              and question_revision_id is not null and ai_explanation_id is null
      when 'ai_explanation' then chapter_note_id is null and question_id is not null
                                 and question_revision_id is null
                                 and ai_explanation_id is not null
      else false
    end),
  constraint user_highlights_ai_explanation_pending check (target_kind <> 'ai_explanation'),
  constraint user_highlights_anchor_valid check (
    jsonb_typeof(anchor) = 'object'
    and (anchor - array['block', 'start', 'end']) = '{}'::jsonb
    and jsonb_typeof(anchor -> 'block') = 'string'
    and anchor ->> 'block' ~ '^(s[0-9]{1,4}\.i[0-9]{1,4}|p[0-9]{1,4})$'
    and jsonb_typeof(anchor -> 'start') = 'number'
    and jsonb_typeof(anchor -> 'end') = 'number'
    and case
      when (anchor ->> 'start') ~ '^[0-9]{1,9}$' and (anchor ->> 'end') ~ '^[0-9]{1,9}$'
        then (anchor ->> 'start')::integer < (anchor ->> 'end')::integer
      else false
    end),
  constraint user_highlights_quote_length check (char_length(quote) between 1 and 2000),
  constraint user_highlights_context_length
    check (char_length(prefix) <= 32 and char_length(suffix) <= 32),
  constraint user_highlights_color_valid check (color in ('yellow', 'blue', 'pink')),
  constraint user_highlights_version_positive check (version >= 1),
  constraint user_highlights_replaced_deleted check (replaced_by is null or deleted_at is not null),
  constraint user_highlights_replaced_not_self check (replaced_by is distinct from id),
  constraint user_highlights_deleted_order check (deleted_at is null or deleted_at >= created_at)
);

-- The caller's live highlights of one target (create/restore overlap + limit, reads).
create index user_highlights_user_note_idx
  on public.user_highlights (user_id, chapter_note_id) where deleted_at is null;
create index user_highlights_user_question_idx
  on public.user_highlights (user_id, question_id) where deleted_at is null;
create index user_highlights_workspace_user_idx
  on public.user_highlights (workspace_id, user_id);
-- Cascades from chapter_notes / questions / question_revisions.
create index user_highlights_note_idx on public.user_highlights (chapter_note_id)
  where chapter_note_id is not null;
create index user_highlights_question_idx
  on public.user_highlights (workspace_id, question_id, question_revision_id)
  where question_id is not null;
create index user_highlights_replaced_by_idx on public.user_highlights (replaced_by)
  where replaced_by is not null;

create trigger user_highlights_set_updated_at
  before update on public.user_highlights
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table public.user_highlights from public, anon, authenticated;

grant select, insert on public.user_highlights to quiz_api;
grant update (color, version, deleted_at, replaced_by, updated_at)
  on public.user_highlights to quiz_api;

alter table public.user_highlights enable row level security;
create policy quiz_api_select on public.user_highlights
  for select to quiz_api using (true);
create policy quiz_api_insert on public.user_highlights
  for insert to quiz_api with check (true);
create policy quiz_api_update on public.user_highlights
  for update to quiz_api using (true) with check (true);
