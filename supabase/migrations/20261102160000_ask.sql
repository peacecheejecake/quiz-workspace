-- ASK-B: AI questions over the workspace's documents (ASK-01, docs/questions.md §13,
-- docs/architecture.md §4-§6).
--
-- Additive only: new tables, their grants/policies/indexes/triggers and three functions. Nothing
-- existing is altered; quiz_worker still never reads practice data (the API pins what the answer
-- job needs from it on the message).
--
-- ask_conversations     one user's conversation in one workspace (personal: only its owner ever
--                       reaches it, enforced by the API). At most one attached question, by kind:
--                       a bank question (`question_id`, plus `practice_session_id` for the
--                       `practice` view) or a mock exam question (`mock_exam_question_id`, plus
--                       `mock_practice_session_id`); every attachment FK is `on delete set null`
--                       (the chip then reads "no longer available"). `last_message_at` drives the
--                       retention purge (ASK_RETENTION_DAYS).
-- ask_messages          append-only: a user question or an assistant answer. A finished answer
--                       (succeeded / no_sources / stopped / failed) never changes; `retry` and
--                       `regenerate` insert a new answer (`retry_of_message_id`,
--                       `regenerated_from_message_id`). At most one queued/running answer per user
--                       (partial unique index: 409 `ask-answer-running`). An answer pins the
--                       attachment refs and the disclosure level the API computed from the DB when
--                       it was sent; it never stores the question context the worker gives the LLM.
-- ask_message_sources   the evidence pinned by the API's retrieval: ids, pages, chunk id and score
--                       only, never passage text (the worker re-reads the blocks). `cited` and
--                       `number` are set by the worker after citation validation.
-- ask_message_feedback  one reason code per answer ("도움이 안 됨"); no free text.
-- llm_feature_usage     token accounting per LLM-called answer (and later AI explanations):
--                       counts and codes only. `message_id` is `on delete set null` so deleting a
--                       conversation keeps the usage for cost reporting (13 months, purged by the
--                       worker).
--
-- quiz_api: conversations CRUD, messages (insert; cancel = stopped), sources (insert), feedback,
--   reads of usage for the limits.
-- quiz_worker (`ask.answer`, `ask.purge`): reads conversations, messages and sources, finishes
--   answers, marks cited sources, writes usage, deletes expired conversations and usage. It reads
--   the attached question's revision (as it already may) but no practice data: the API pins the
--   session's option order and, for `full`, the caller's own submitted answer and result on the
--   answer message. Membership is re-checked through `worker_ask_member_active` (no privilege on
--   workspaces / memberships).
-- A soft-deleted workspace loses its conversations (trigger).

-- ---------------------------------------------------------------------------------------------
-- ask_conversations
-- ---------------------------------------------------------------------------------------------
create table public.ask_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  scope jsonb not null default '{"document_ids": [], "chapter_ids": []}'::jsonb,
  attachment_kind text,
  attachment_view text,
  attachment_label text,
  question_id uuid references public.questions (id) on delete set null,
  practice_session_id uuid references public.practice_sessions (id) on delete set null,
  mock_exam_question_id uuid references public.mock_exam_questions (id) on delete set null,
  mock_practice_session_id uuid
    references public.mock_exam_practice_sessions (id) on delete set null,
  selected_option_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint ask_conversations_ref_key unique (workspace_id, user_id, id),
  constraint ask_conversations_title_length
    check (title is null or (btrim(title) <> '' and char_length(title) <= 200)),
  constraint ask_conversations_scope_object
    check (jsonb_typeof(scope) = 'object' and pg_column_size(scope) <= 16384),
  constraint ask_conversations_attachment_valid check (
    (attachment_kind is null and attachment_view is null and attachment_label is null)
    or (attachment_kind = 'question' and attachment_view in ('practice', 'detail')
        and attachment_label is not null)
    or (attachment_kind = 'mock_exam_question' and attachment_view in ('practice', 'manage')
        and attachment_label is not null)
  ),
  constraint ask_conversations_attachment_label_length
    check (attachment_label is null or char_length(attachment_label) <= 200),
  constraint ask_conversations_bank_refs
    check (attachment_kind is not distinct from 'question'
           or (question_id is null and practice_session_id is null)),
  constraint ask_conversations_mock_refs
    check (attachment_kind is not distinct from 'mock_exam_question'
           or (mock_exam_question_id is null and mock_practice_session_id is null)),
  constraint ask_conversations_session_refs
    check (attachment_view is not distinct from 'practice'
           or (practice_session_id is null and mock_practice_session_id is null)),
  constraint ask_conversations_selected_valid
    check (public.question_ids_valid(selected_option_ids)
           and cardinality(selected_option_ids) <= 50)
);

create index ask_conversations_owner_recent_idx
  on public.ask_conversations (workspace_id, user_id, last_message_at desc, id desc);
create index ask_conversations_user_idx on public.ask_conversations (user_id);
create index ask_conversations_last_message_idx on public.ask_conversations (last_message_at);
create index ask_conversations_question_idx
  on public.ask_conversations (question_id) where question_id is not null;
create index ask_conversations_practice_session_idx
  on public.ask_conversations (practice_session_id) where practice_session_id is not null;
create index ask_conversations_mock_question_idx
  on public.ask_conversations (mock_exam_question_id) where mock_exam_question_id is not null;
create index ask_conversations_mock_session_idx
  on public.ask_conversations (mock_practice_session_id)
  where mock_practice_session_id is not null;

create trigger ask_conversations_set_updated_at
  before update on public.ask_conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- ask_messages
-- ---------------------------------------------------------------------------------------------
create table public.ask_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  role text not null,
  status text not null,
  question_message_id uuid references public.ask_messages (id) on delete cascade,
  retry_of_message_id uuid references public.ask_messages (id) on delete set null,
  regenerated_from_message_id uuid references public.ask_messages (id) on delete set null,
  text text not null default '',
  scope jsonb not null default '{"document_ids": [], "chapter_ids": []}'::jsonb,
  disclosure text not null default 'none',
  attachment_kind text,
  question_id uuid references public.questions (id) on delete set null,
  question_revision_id uuid references public.question_revisions (id) on delete set null,
  practice_session_id uuid references public.practice_sessions (id) on delete set null,
  mock_exam_question_id uuid references public.mock_exam_questions (id) on delete set null,
  mock_exam_question_revision_id uuid
    references public.mock_exam_question_revisions (id) on delete set null,
  mock_practice_session_id uuid
    references public.mock_exam_practice_sessions (id) on delete set null,
  selected_option_ids text[] not null default '{}',
  displayed_option_ids text[] not null default '{}',
  submitted_answer jsonb,
  attempt_result text,
  context_char_limit integer,
  degraded text[] not null default '{}',
  error_code text,
  uncited boolean not null default false,
  truncated boolean not null default false,
  dropped_citations integer not null default 0,
  model text,
  prompt_version text,
  job_id uuid references public.async_jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint ask_messages_conversation_fk
    foreign key (workspace_id, user_id, conversation_id)
    references public.ask_conversations (workspace_id, user_id, id) on delete cascade,
  constraint ask_messages_role_valid check (role in ('user', 'assistant')),
  constraint ask_messages_status_valid check (
    status in ('queued', 'retrieving', 'streaming', 'succeeded', 'no_sources', 'stopped',
               'failed')
  ),
  constraint ask_messages_shape check (
    (role = 'user' and status = 'succeeded' and question_message_id is null
       and retry_of_message_id is null and regenerated_from_message_id is null
       and disclosure = 'none' and attachment_kind is null and job_id is null
       and btrim(text) <> '')
    or (role = 'assistant' and question_message_id is not null)
  ),
  constraint ask_messages_single_origin
    check (retry_of_message_id is null or regenerated_from_message_id is null),
  constraint ask_messages_text_length check (char_length(text) <= 50000),
  constraint ask_messages_scope_object
    check (jsonb_typeof(scope) = 'object' and pg_column_size(scope) <= 16384),
  constraint ask_messages_disclosure_valid check (disclosure in ('none', 'hint', 'full')),
  constraint ask_messages_attachment_kind_valid
    check (attachment_kind is null or attachment_kind in ('question', 'mock_exam_question')),
  constraint ask_messages_disclosure_attachment
    check ((disclosure = 'none') = (attachment_kind is null)),
  constraint ask_messages_selected_valid
    check (public.question_ids_valid(selected_option_ids)
           and cardinality(selected_option_ids) <= 50),
  constraint ask_messages_displayed_valid
    check (public.question_ids_valid(displayed_option_ids)
           and cardinality(displayed_option_ids) <= 50),
  constraint ask_messages_submission_full
    check ((submitted_answer is null and attempt_result is null) or disclosure = 'full'),
  constraint ask_messages_submitted_answer_object
    check (submitted_answer is null or (jsonb_typeof(submitted_answer) = 'object'
                                        and pg_column_size(submitted_answer) <= 65536)),
  constraint ask_messages_attempt_result_valid
    check (attempt_result is null or attempt_result in ('correct', 'incorrect', 'pending')),
  constraint ask_messages_context_limit_positive
    check (context_char_limit is null or context_char_limit > 0),
  constraint ask_messages_degraded_valid
    check (degraded <@ array['dense_unavailable', 'attachment_only']::text[]),
  constraint ask_messages_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint ask_messages_error_iff_failed check ((status = 'failed') = (error_code is not null)),
  constraint ask_messages_dropped_non_negative check (dropped_citations >= 0),
  constraint ask_messages_model_length check (model is null or char_length(model) <= 200),
  constraint ask_messages_prompt_version_length
    check (prompt_version is null or char_length(prompt_version) <= 100),
  constraint ask_messages_finished_iff_terminal check (
    role = 'user'
    or (status in ('succeeded', 'no_sources', 'stopped', 'failed')) = (finished_at is not null)
  )
);

create index ask_messages_conversation_idx
  on public.ask_messages (conversation_id, created_at, id);
create index ask_messages_user_created_idx on public.ask_messages (user_id, created_at)
  where role = 'assistant';
create index ask_messages_workspace_user_idx on public.ask_messages (workspace_id, user_id);
create index ask_messages_question_message_idx
  on public.ask_messages (question_message_id) where question_message_id is not null;
create index ask_messages_retry_of_idx
  on public.ask_messages (retry_of_message_id) where retry_of_message_id is not null;
create index ask_messages_regenerated_from_idx
  on public.ask_messages (regenerated_from_message_id)
  where regenerated_from_message_id is not null;
create index ask_messages_question_idx
  on public.ask_messages (question_id) where question_id is not null;
create index ask_messages_question_revision_idx
  on public.ask_messages (question_revision_id) where question_revision_id is not null;
create index ask_messages_practice_session_idx
  on public.ask_messages (practice_session_id) where practice_session_id is not null;
create index ask_messages_mock_question_idx
  on public.ask_messages (mock_exam_question_id) where mock_exam_question_id is not null;
create index ask_messages_mock_revision_idx
  on public.ask_messages (mock_exam_question_revision_id)
  where mock_exam_question_revision_id is not null;
create index ask_messages_mock_session_idx
  on public.ask_messages (mock_practice_session_id) where mock_practice_session_id is not null;
create index ask_messages_job_idx on public.ask_messages (job_id) where job_id is not null;
-- One answer being made per user at a time (ASK-01 "동시에 만드는 답").
create unique index ask_messages_one_running_per_user
  on public.ask_messages (user_id)
  where role = 'assistant' and status in ('queued', 'retrieving', 'streaming');

create trigger ask_messages_set_updated_at
  before update on public.ask_messages
  for each row execute function public.set_updated_at();

-- Append-only (ASK-01-C08): a finished message never changes and no message is deleted on its
-- own; only the referential actions of a cascade (conversation / workspace / user deleted, an
-- attached question deleted: pg_trigger_depth() > 1) get through.
create function public.ask_messages_append_only()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'ask_messages is append-only (DELETE refused)' using errcode = '55000';
  end if;
  if old.status in ('succeeded', 'no_sources', 'stopped', 'failed') then
    raise exception 'a finished ask message is immutable' using errcode = '55000';
  end if;
  if new.id <> old.id or new.conversation_id <> old.conversation_id
     or new.workspace_id <> old.workspace_id or new.user_id <> old.user_id
     or new.role <> old.role
     or new.question_message_id is distinct from old.question_message_id
     or new.retry_of_message_id is distinct from old.retry_of_message_id
     or new.regenerated_from_message_id is distinct from old.regenerated_from_message_id
     or new.disclosure <> old.disclosure
     or new.attachment_kind is distinct from old.attachment_kind
     or new.scope <> old.scope
     or new.created_at <> old.created_at then
    raise exception 'ask message identity columns are immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

comment on function public.ask_messages_append_only() is
  'ASK trigger: refuse DELETE and changes to finished ask messages (cascades excepted).';

create trigger ask_messages_append_only
  before update or delete on public.ask_messages
  for each row execute function public.ask_messages_append_only();

-- ---------------------------------------------------------------------------------------------
-- ask_message_sources (pinned references, no text)
-- ---------------------------------------------------------------------------------------------
create table public.ask_message_sources (
  message_id uuid not null references public.ask_messages (id) on delete cascade,
  tag integer not null,
  rank integer not null,
  workspace_id uuid not null,
  document_id uuid not null,
  revision_id uuid not null,
  chapter_id uuid,
  block_ids text[] not null,
  matched_block_ids text[] not null default '{}',
  page_from integer not null,
  page_to integer not null,
  chunk_id text not null,
  score double precision not null,
  score_type text not null,
  cited boolean not null default false,
  number integer,
  primary key (message_id, tag),
  constraint ask_message_sources_document_fk
    foreign key (workspace_id, document_id)
    references public.documents (workspace_id, id) on delete cascade,
  constraint ask_message_sources_revision_fk
    foreign key (revision_id) references public.document_revisions (id) on delete cascade,
  constraint ask_message_sources_chapter_fk
    foreign key (chapter_id) references public.chapters (id) on delete set null,
  constraint ask_message_sources_tag_range check (tag between 1 and 50),
  constraint ask_message_sources_rank_positive check (rank >= 1),
  constraint ask_message_sources_blocks_valid
    check (public.question_ids_valid(block_ids) and cardinality(block_ids) between 1 and 200
           and public.question_ids_valid(matched_block_ids)
           and cardinality(matched_block_ids) <= 200),
  constraint ask_message_sources_pages_valid check (page_from >= 1 and page_to >= page_from),
  constraint ask_message_sources_chunk_id_length
    check (btrim(chunk_id) <> '' and char_length(chunk_id) <= 256),
  constraint ask_message_sources_score_type_valid
    check (score_type in ('bm25', 'cosine', 'rrf', 'rerank')),
  constraint ask_message_sources_number_iff_cited
    check (cited = (number is not null) and (number is null or number between 1 and 50))
);

create index ask_message_sources_document_idx
  on public.ask_message_sources (workspace_id, document_id);
create index ask_message_sources_revision_idx on public.ask_message_sources (revision_id);
create index ask_message_sources_chapter_idx
  on public.ask_message_sources (chapter_id) where chapter_id is not null;

-- ---------------------------------------------------------------------------------------------
-- ask_message_feedback
-- ---------------------------------------------------------------------------------------------
create table public.ask_message_feedback (
  message_id uuid primary key references public.ask_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ask_message_feedback_reason_valid
    check (reason in ('source_mismatch', 'made_up', 'revealed_answer', 'other'))
);

create index ask_message_feedback_user_idx on public.ask_message_feedback (user_id);

create trigger ask_message_feedback_set_updated_at
  before update on public.ask_message_feedback
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- llm_feature_usage (counts only)
-- ---------------------------------------------------------------------------------------------
create table public.llm_feature_usage (
  id uuid primary key default gen_random_uuid(),
  feature text not null,
  user_id uuid references auth.users (id) on delete set null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  message_id uuid references public.ask_messages (id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  llm_calls integer not null default 1,
  cost_usd numeric(12, 6),
  status text not null,
  error_code text,
  created_at timestamptz not null default now(),
  constraint llm_feature_usage_feature_valid check (feature in ('ask', 'ai_explanation')),
  constraint llm_feature_usage_model_length
    check (btrim(model) <> '' and char_length(model) <= 200),
  constraint llm_feature_usage_tokens_non_negative check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_creation_tokens >= 0 and llm_calls >= 0
  ),
  constraint llm_feature_usage_cost_non_negative check (cost_usd is null or cost_usd >= 0),
  constraint llm_feature_usage_status_valid
    check (status in ('succeeded', 'no_sources', 'stopped', 'failed')),
  constraint llm_feature_usage_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$')
);

create index llm_feature_usage_created_idx on public.llm_feature_usage (feature, created_at);
create index llm_feature_usage_user_created_idx
  on public.llm_feature_usage (user_id, feature, created_at);
create index llm_feature_usage_workspace_idx on public.llm_feature_usage (workspace_id);
create index llm_feature_usage_message_idx
  on public.llm_feature_usage (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------------------------
-- A soft-deleted workspace loses its conversations (ASK-01 "Workspace를 삭제하면 그 Workspace의
-- 대화도 지워진다"); usage keeps its counts (workspace_id stays until a hard delete).
-- ---------------------------------------------------------------------------------------------
create function public.ask_conversations_drop_with_workspace()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.ask_conversations c where c.workspace_id = new.id;
  return null;
end;
$$;

comment on function public.ask_conversations_drop_with_workspace() is
  'ASK trigger: delete the conversations of a workspace once it is soft-deleted.';

create trigger workspaces_drop_ask_conversations
  after update of status on public.workspaces
  for each row
  when (new.status = 'deleted' and old.status <> 'deleted')
  execute function public.ask_conversations_drop_with_workspace();

-- ---------------------------------------------------------------------------------------------
-- Worker re-check: may an answer of p_user_id still be written in p_workspace_id? (any member
-- role; the workspace active). Like worker_workspace_writable, it optionally locks the rows FOR
-- SHARE until the caller's transaction ends, so an archive / delete / membership change either
-- committed before or waits for the write.
-- ---------------------------------------------------------------------------------------------
create function public.worker_ask_member_active(
  p_workspace_id uuid,
  p_user_id uuid,
  p_lock boolean default false
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  found_status text;
begin
  if p_workspace_id is null or p_user_id is null then
    return false;
  end if;
  if p_lock then
    select w.status
      into found_status
      from public.workspaces w
      join public.workspace_memberships m on m.workspace_id = w.id
     where w.id = p_workspace_id
       and m.user_id = p_user_id
       and w.deleted_at is null
       for share of w, m;
  else
    select w.status
      into found_status
      from public.workspaces w
      join public.workspace_memberships m on m.workspace_id = w.id
     where w.id = p_workspace_id
       and m.user_id = p_user_id
       and w.deleted_at is null;
  end if;
  return coalesce(found_status = 'active', false);
end;
$$;

comment on function public.worker_ask_member_active(uuid, uuid, boolean) is
  'quiz_worker: is p_user_id still a member of the active workspace p_workspace_id? Optionally locks the rows FOR SHARE.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.ask_conversations,
  public.ask_messages,
  public.ask_message_sources,
  public.ask_message_feedback,
  public.llm_feature_usage
from public, anon, authenticated;
revoke all on function public.ask_messages_append_only()
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.ask_conversations_drop_with_workspace()
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.worker_ask_member_active(uuid, uuid, boolean)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_ask_member_active(uuid, uuid, boolean) to quiz_worker;

grant select, insert, delete on public.ask_conversations to quiz_api;
grant update (title, scope, attachment_kind, attachment_view, attachment_label, question_id,
              practice_session_id, mock_exam_question_id, mock_practice_session_id,
              selected_option_ids, last_message_at, updated_at)
  on public.ask_conversations to quiz_api;
grant select, insert on public.ask_messages to quiz_api;
grant update (status, text, finished_at, updated_at) on public.ask_messages to quiz_api;
grant select, insert on public.ask_message_sources to quiz_api;
grant select, insert, delete on public.ask_message_feedback to quiz_api;
grant update (reason, updated_at) on public.ask_message_feedback to quiz_api;
grant select on public.llm_feature_usage to quiz_api;

grant select, delete on public.ask_conversations to quiz_worker;
grant select on public.ask_messages to quiz_worker;
grant update (status, text, error_code, uncited, truncated, dropped_citations, model,
              prompt_version, started_at, finished_at, updated_at)
  on public.ask_messages to quiz_worker;
grant select on public.ask_message_sources to quiz_worker;
grant update (cited, number) on public.ask_message_sources to quiz_worker;
grant select, insert, delete on public.llm_feature_usage to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.ask_conversations enable row level security;
alter table public.ask_messages enable row level security;
alter table public.ask_message_sources enable row level security;
alter table public.ask_message_feedback enable row level security;
alter table public.llm_feature_usage enable row level security;

-- quiz_api: the API checks the conversation's owner on every request (ASK-01-C01); the policies
-- bound what a write may look like.
create policy quiz_api_all on public.ask_conversations
  for all to quiz_api using (true) with check (true);
create policy quiz_api_select on public.ask_messages
  for select to quiz_api using (true);
create policy quiz_api_insert on public.ask_messages
  for insert to quiz_api
  with check ((role = 'user' and status = 'succeeded')
              or (role = 'assistant' and status = 'queued' and error_code is null
                  and finished_at is null and started_at is null and model is null
                  and dropped_citations = 0 and not uncited and not truncated));
-- Cancel only: an unfinished answer becomes `stopped`.
create policy quiz_api_update on public.ask_messages
  for update to quiz_api
  using (role = 'assistant' and status in ('queued', 'retrieving', 'streaming'))
  with check (status = 'stopped');
create policy quiz_api_select on public.ask_message_sources
  for select to quiz_api using (true);
create policy quiz_api_insert on public.ask_message_sources
  for insert to quiz_api with check (not cited and number is null);
create policy quiz_api_all on public.ask_message_feedback
  for all to quiz_api using (true) with check (true);
create policy quiz_api_select on public.llm_feature_usage
  for select to quiz_api using (true);

create policy quiz_worker_select on public.ask_conversations
  for select to quiz_worker using (true);
create policy quiz_worker_delete on public.ask_conversations
  for delete to quiz_worker using (true);
create policy quiz_worker_select on public.ask_messages
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.ask_messages
  for update to quiz_worker
  using (role = 'assistant' and status in ('queued', 'retrieving', 'streaming'))
  with check (role = 'assistant');
create policy quiz_worker_select on public.ask_message_sources
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.ask_message_sources
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.llm_feature_usage
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.llm_feature_usage
  for insert to quiz_worker with check (true);
create policy quiz_worker_delete on public.llm_feature_usage
  for delete to quiz_worker using (true);
