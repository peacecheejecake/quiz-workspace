-- RELSRC-B: stored related-passage lists (RELSRC-01, docs/questions.md §13,
-- docs/architecture.md §5-§6). Method A: search only, no LLM, computed inside the API request.
--
-- Additive only: two new tables with their grants, policies and indexes.
--
-- question_related_sources            one list per (question revision, corpus fingerprint,
--                                     retrieval version). Workspace-shared (the user's answer is
--                                     no input). `items` holds passage references only (document,
--                                     revision, block ids, pages, score, question-source flag,
--                                     rank), never passage text, stem, answer or query: excerpts
--                                     are rebuilt from the published blocks on every read.
-- mock_exam_question_related_sources  the same for mock exam question revisions (own lists,
--                                     never shared with the source question's).
--
-- Older keys are kept with `superseded_at` (history); exactly one list per question is current
-- (partial unique index). The API takes `pg_advisory_xact_lock` on the key and re-checks before it
-- computes, so concurrent first reads compute once; the unique key is the backstop.
--
-- quiz_api: select, insert, update (superseded_at only). quiz_worker: nothing (forks copy no rows;
-- deletes cascade from questions / mock exam questions).

-- ---------------------------------------------------------------------------------------------
-- question_related_sources
-- ---------------------------------------------------------------------------------------------
create table public.question_related_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  question_revision_id uuid not null,
  corpus_fingerprint text not null,
  retrieval_version text not null,
  items jsonb not null default '[]'::jsonb,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint question_related_sources_key
    unique (question_revision_id, corpus_fingerprint, retrieval_version),
  constraint question_related_sources_revision_fk
    foreign key (workspace_id, question_id, question_revision_id)
    references public.question_revisions (workspace_id, question_id, id) on delete cascade,
  constraint question_related_sources_fingerprint_format
    check (corpus_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint question_related_sources_version_length
    check (btrim(retrieval_version) <> '' and char_length(retrieval_version) <= 100),
  constraint question_related_sources_items_array
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 50
           and pg_column_size(items) <= 65536)
);

create unique index question_related_sources_one_current
  on public.question_related_sources (question_id) where superseded_at is null;
create index question_related_sources_question_idx
  on public.question_related_sources (question_id, created_at);
create index question_related_sources_workspace_idx
  on public.question_related_sources (workspace_id);

-- ---------------------------------------------------------------------------------------------
-- mock_exam_question_related_sources
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_question_related_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_question_id uuid not null,
  mock_exam_question_revision_id uuid not null,
  corpus_fingerprint text not null,
  retrieval_version text not null,
  items jsonb not null default '[]'::jsonb,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mock_exam_question_related_sources_key
    unique (mock_exam_question_revision_id, corpus_fingerprint, retrieval_version),
  constraint mock_exam_question_related_sources_revision_fk
    foreign key (workspace_id, mock_exam_question_id, mock_exam_question_revision_id)
    references public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, id)
    on delete cascade,
  constraint mock_exam_question_related_sources_fingerprint_format
    check (corpus_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint mock_exam_question_related_sources_version_length
    check (btrim(retrieval_version) <> '' and char_length(retrieval_version) <= 100),
  constraint mock_exam_question_related_sources_items_array
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 50
           and pg_column_size(items) <= 65536)
);

create unique index mock_exam_question_related_sources_one_current
  on public.mock_exam_question_related_sources (mock_exam_question_id)
  where superseded_at is null;
create index mock_exam_question_related_sources_question_idx
  on public.mock_exam_question_related_sources (mock_exam_question_id, created_at);
create index mock_exam_question_related_sources_workspace_idx
  on public.mock_exam_question_related_sources (workspace_id);

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.question_related_sources,
  public.mock_exam_question_related_sources
from public, anon, authenticated, quiz_worker;

grant select, insert on public.question_related_sources to quiz_api;
grant update (superseded_at) on public.question_related_sources to quiz_api;
grant select, insert on public.mock_exam_question_related_sources to quiz_api;
grant update (superseded_at) on public.mock_exam_question_related_sources to quiz_api;

-- ---------------------------------------------------------------------------------------------
-- Row level security: the API authorizes every read (RELSRC-01-C01); the policies bound writes.
-- ---------------------------------------------------------------------------------------------
alter table public.question_related_sources enable row level security;
alter table public.mock_exam_question_related_sources enable row level security;

create policy quiz_api_select on public.question_related_sources
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_related_sources
  for insert to quiz_api with check (true);
create policy quiz_api_update on public.question_related_sources
  for update to quiz_api using (true) with check (true);
create policy quiz_api_select on public.mock_exam_question_related_sources
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_question_related_sources
  for insert to quiz_api with check (true);
create policy quiz_api_update on public.mock_exam_question_related_sources
  for update to quiz_api using (true) with check (true);
