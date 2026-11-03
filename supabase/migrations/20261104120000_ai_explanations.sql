-- EXPL-B: AI explanations of a question after submission (AIEXPL-01, docs/questions.md §13,
-- docs/architecture.md §5-§6).
--
-- Additive only: two new tables with their grants, policies, indexes and triggers, one nullable
-- column on llm_feature_usage and a fork-copy trigger. Nothing existing changes meaning.
--
-- question_ai_explanations             one explanation version of a bank question revision,
--                                      shared by the whole workspace. Key = (question_revision_id,
--                                      prompt_version, model).
-- mock_exam_question_ai_explanations   the same for a mock exam question revision (its own rows:
--                                      never the source question's, AIEXPL-01-C09).
--
-- Status queued -> running -> succeeded | failed. Per key at most one queued/running row
-- (`…_one_live`: concurrent requests get the same row) and at most one succeeded row that is
-- not superseded (`…_one_current`). 다시 만들기 inserts a new version while the previous success
-- stays current; the worker supersedes the previous success in the transaction that stores the
-- new one, so a failed regeneration never hides the last good explanation. Failed rows block
-- nothing. Rows are never deleted on their own (history); they go with their question / mock exam
-- question (cascade). `sources` pins the passages the API chose ([{tag, document_id,
-- document_revision_id, chapter_id, block_ids, page_from, page_to, from_question}]; ids and pages
-- only, never text — the worker re-reads the blocks); the worker adds `number` to the cited ones.
-- `body` is the validated explanation (succeeded only).
--
-- quiz_api: reads; inserts queued rows (the policy pins the shape). quiz_worker: reads; moves a
--   row through running to its end (status, body, cited source numbers, error code, superseding
--   the previous success). Membership is re-checked through worker_ask_member_active.
-- Activity `question.ai_explanation_generated` / `mock_exam.ai_explanation_generated` (ids and the
-- version only) is written by a trigger when a row succeeds.
-- Fork: the newest succeeded explanation of each copied question revision is copied with new ids
-- (question, revision and source document ids remapped; no older version, failure or usage).
-- llm_feature_usage gains `ref_id`: the explanation a usage row belongs to (no FK: either table;
-- usage outlives it).

-- ---------------------------------------------------------------------------------------------
-- question_ai_explanations
-- ---------------------------------------------------------------------------------------------
create table public.question_ai_explanations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  question_id uuid not null,
  question_revision_id uuid not null,
  version integer not null default 1,
  regenerated boolean not null default false,
  status text not null default 'queued',
  job_id uuid references public.async_jobs (id) on delete set null,
  prompt_version text not null,
  model text not null,
  body jsonb,
  sources jsonb not null default '[]'::jsonb,
  error_code text,
  truncated boolean not null default false,
  dropped_citations integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  superseded_at timestamptz,
  constraint question_ai_explanations_question_fk
    foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id) on delete cascade,
  constraint question_ai_explanations_revision_fk
    foreign key (workspace_id, question_id, question_revision_id)
    references public.question_revisions (workspace_id, question_id, id) on delete cascade,
  constraint question_ai_explanations_version_positive check (version >= 1),
  constraint question_ai_explanations_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint question_ai_explanations_prompt_version_length
    check (btrim(prompt_version) <> '' and char_length(prompt_version) <= 100),
  constraint question_ai_explanations_model_length
    check (btrim(model) <> '' and char_length(model) <= 200),
  constraint question_ai_explanations_body_iff_succeeded
    check ((status = 'succeeded') = (body is not null)),
  constraint question_ai_explanations_body_object
    check (body is null or (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 262144)),
  constraint question_ai_explanations_sources_array
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 65536),
  constraint question_ai_explanations_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint question_ai_explanations_error_iff_failed
    check ((status = 'failed') = (error_code is not null)),
  constraint question_ai_explanations_dropped_non_negative check (dropped_citations >= 0),
  constraint question_ai_explanations_finished_iff_terminal
    check ((status in ('succeeded', 'failed')) = (finished_at is not null)),
  constraint question_ai_explanations_superseded_succeeded
    check (superseded_at is null or status = 'succeeded')
);

create unique index question_ai_explanations_one_live
  on public.question_ai_explanations (question_revision_id, prompt_version, model)
  where status in ('queued', 'running');
create unique index question_ai_explanations_one_current
  on public.question_ai_explanations (question_revision_id, prompt_version, model)
  where status = 'succeeded' and superseded_at is null;
create index question_ai_explanations_key_idx
  on public.question_ai_explanations (question_revision_id, prompt_version, model, created_at desc);
create index question_ai_explanations_question_idx
  on public.question_ai_explanations (question_id);
create index question_ai_explanations_workspace_idx
  on public.question_ai_explanations (workspace_id);
create index question_ai_explanations_creator_idx
  on public.question_ai_explanations (created_by, created_at);
create index question_ai_explanations_job_idx
  on public.question_ai_explanations (job_id) where job_id is not null;

create trigger question_ai_explanations_set_updated_at
  before update on public.question_ai_explanations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- mock_exam_question_ai_explanations (same shape and rules; key = mock exam question revision)
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_question_ai_explanations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_question_id uuid not null,
  mock_exam_question_revision_id uuid not null,
  version integer not null default 1,
  regenerated boolean not null default false,
  status text not null default 'queued',
  job_id uuid references public.async_jobs (id) on delete set null,
  prompt_version text not null,
  model text not null,
  body jsonb,
  sources jsonb not null default '[]'::jsonb,
  error_code text,
  truncated boolean not null default false,
  dropped_citations integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  superseded_at timestamptz,
  constraint mock_exam_question_ai_explanations_question_fk
    foreign key (workspace_id, mock_exam_question_id)
    references public.mock_exam_questions (workspace_id, id) on delete cascade,
  constraint mock_exam_question_ai_explanations_revision_fk
    foreign key (workspace_id, mock_exam_question_id, mock_exam_question_revision_id)
    references public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, id)
    on delete cascade,
  constraint mock_exam_question_ai_explanations_version_positive check (version >= 1),
  constraint mock_exam_question_ai_explanations_status_valid
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint mock_exam_question_ai_explanations_prompt_version_length
    check (btrim(prompt_version) <> '' and char_length(prompt_version) <= 100),
  constraint mock_exam_question_ai_explanations_model_length
    check (btrim(model) <> '' and char_length(model) <= 200),
  constraint mock_exam_question_ai_explanations_body_iff_succeeded
    check ((status = 'succeeded') = (body is not null)),
  constraint mock_exam_question_ai_explanations_body_object
    check (body is null or (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 262144)),
  constraint mock_exam_question_ai_explanations_sources_array
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 65536),
  constraint mock_exam_question_ai_explanations_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint mock_exam_question_ai_explanations_error_iff_failed
    check ((status = 'failed') = (error_code is not null)),
  constraint mock_exam_question_ai_explanations_dropped_non_negative
    check (dropped_citations >= 0),
  constraint mock_exam_question_ai_explanations_finished_iff_terminal
    check ((status in ('succeeded', 'failed')) = (finished_at is not null)),
  constraint mock_exam_question_ai_explanations_superseded_succeeded
    check (superseded_at is null or status = 'succeeded')
);

create unique index mock_exam_question_ai_explanations_one_live
  on public.mock_exam_question_ai_explanations
     (mock_exam_question_revision_id, prompt_version, model)
  where status in ('queued', 'running');
create unique index mock_exam_question_ai_explanations_one_current
  on public.mock_exam_question_ai_explanations
     (mock_exam_question_revision_id, prompt_version, model)
  where status = 'succeeded' and superseded_at is null;
create index mock_exam_question_ai_explanations_key_idx
  on public.mock_exam_question_ai_explanations
     (mock_exam_question_revision_id, prompt_version, model, created_at desc);
create index mock_exam_question_ai_explanations_question_idx
  on public.mock_exam_question_ai_explanations (mock_exam_question_id);
create index mock_exam_question_ai_explanations_workspace_idx
  on public.mock_exam_question_ai_explanations (workspace_id);
create index mock_exam_question_ai_explanations_creator_idx
  on public.mock_exam_question_ai_explanations (created_by, created_at);
create index mock_exam_question_ai_explanations_job_idx
  on public.mock_exam_question_ai_explanations (job_id) where job_id is not null;

create trigger mock_exam_question_ai_explanations_set_updated_at
  before update on public.mock_exam_question_ai_explanations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Usage reference (the explanation a usage row belongs to; `message_id` stays for ask answers)
-- ---------------------------------------------------------------------------------------------
alter table public.llm_feature_usage add column ref_id uuid;
alter table public.llm_feature_usage
  add constraint llm_feature_usage_ref_feature
  check (ref_id is null or (feature = 'ai_explanation' and message_id is null));
create index llm_feature_usage_ref_idx
  on public.llm_feature_usage (ref_id) where ref_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Activity when an explanation succeeds (ids and the version only, never content).
-- ---------------------------------------------------------------------------------------------
create function public.ai_explanations_record_generated()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'mock_exam_question_ai_explanations' then
    insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                        target_id, metadata)
    values (new.workspace_id, new.created_by, 'mock_exam.ai_explanation_generated',
            'mock_exam_question', new.mock_exam_question_id,
            pg_catalog.jsonb_build_object('explanation_id', new.id::text,
                                          'revision_id', new.mock_exam_question_revision_id::text,
                                          'version', new.version));
  else
    insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                        target_id, metadata)
    values (new.workspace_id, new.created_by, 'question.ai_explanation_generated', 'question',
            new.question_id,
            pg_catalog.jsonb_build_object('explanation_id', new.id::text,
                                          'revision_id', new.question_revision_id::text,
                                          'version', new.version));
  end if;
  return null;
end;
$$;

comment on function public.ai_explanations_record_generated() is
  'EXPL trigger: activity *.ai_explanation_generated (ids and version only) when one succeeds.';

create trigger question_ai_explanations_record_generated
  after update of status on public.question_ai_explanations
  for each row
  when (new.status = 'succeeded' and old.status in ('queued', 'running'))
  execute function public.ai_explanations_record_generated();
create trigger mock_exam_question_ai_explanations_record_generated
  after update of status on public.mock_exam_question_ai_explanations
  for each row
  when (new.status = 'succeeded' and old.status in ('queued', 'running'))
  execute function public.ai_explanations_record_generated();

-- ---------------------------------------------------------------------------------------------
-- Fork copy: fires in the worker_fork_commit transaction when the fork row becomes COMPLETED,
-- after the documents, questions and revisions were copied (the chapter-note copy's pattern).
-- Mock exams are never forked, so their explanations are not either.
-- ---------------------------------------------------------------------------------------------
create function public.fork_copy_question_ai_explanations()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  salt uuid := (new.source_snapshot_manifest ->> 'id_salt')::uuid;
begin
  if salt is null or new.target_workspace_id is null then
    return null;
  end if;

  insert into public.question_ai_explanations (id, workspace_id, question_id,
                                               question_revision_id, version, regenerated, status,
                                               job_id, prompt_version, model, body, sources,
                                               error_code, truncated, dropped_citations,
                                               created_by, created_at, started_at, finished_at)
  select public.fork_remap_id(salt, e.id), new.target_workspace_id,
         public.fork_remap_id(salt, e.question_id),
         public.fork_remap_id(salt, e.question_revision_id), 1, false, 'succeeded', null,
         e.prompt_version, e.model, e.body, s.sources, null, e.truncated, e.dropped_citations,
         new.forked_by, e.created_at, e.started_at, e.finished_at
    from (
      select distinct on (x.question_revision_id) x.*
        from pg_catalog.jsonb_array_elements(new.source_snapshot_manifest -> 'questions') as m
        join public.question_ai_explanations x
          on x.question_id = (m ->> 'question_id')::uuid
         and x.question_revision_id = (m ->> 'revision_id')::uuid
         and x.workspace_id = new.source_workspace_id
       where x.status = 'succeeded'
         and x.superseded_at is null
       order by x.question_revision_id, x.created_at desc, x.id desc
    ) e
    -- The copied question must exist in the target (worker_fork_commit copied it).
    join public.questions tq
      on tq.id = public.fork_remap_id(salt, e.question_id)
     and tq.workspace_id = new.target_workspace_id
    cross join lateral (
      select coalesce(
               pg_catalog.jsonb_agg(
                 src || pg_catalog.jsonb_build_object(
                          'document_id', p.target_document_id::text,
                          'document_revision_id', p.target_revision_id::text,
                          'chapter_id', case when src ->> 'chapter_id' is null then null
                                             else public.fork_remap_id(
                                                    salt, (src ->> 'chapter_id')::uuid)::text
                                        end)
                 order by el.ord),
               '[]'::jsonb) as sources
        from pg_catalog.jsonb_array_elements(e.sources) with ordinality as el(src, ord)
        join public.worker_fork_documents(new.id) p
          on p.source_document_id = (src ->> 'document_id')::uuid
    ) s
  on conflict (id) do nothing;
  return null;
end;
$$;

comment on function public.fork_copy_question_ai_explanations() is
  'EXPL trigger: copy the newest succeeded AI explanation of each copied question revision.';

create trigger workspace_forks_copy_question_ai_explanations
  after update of status on public.workspace_forks
  for each row
  when (new.status = 'COMPLETED' and old.status is distinct from 'COMPLETED')
  execute function public.fork_copy_question_ai_explanations();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.question_ai_explanations,
  public.mock_exam_question_ai_explanations
from public, anon, authenticated;
revoke all on function public.ai_explanations_record_generated()
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.fork_copy_question_ai_explanations()
  from public, anon, authenticated, quiz_api, quiz_worker;

grant select, insert on public.question_ai_explanations to quiz_api;
grant select, insert on public.mock_exam_question_ai_explanations to quiz_api;

grant select on public.question_ai_explanations to quiz_worker;
grant update (status, body, sources, error_code, truncated, dropped_citations, started_at,
              finished_at, superseded_at, updated_at)
  on public.question_ai_explanations to quiz_worker;
grant select on public.mock_exam_question_ai_explanations to quiz_worker;
grant update (status, body, sources, error_code, truncated, dropped_citations, started_at,
              finished_at, superseded_at, updated_at)
  on public.mock_exam_question_ai_explanations to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.question_ai_explanations enable row level security;
alter table public.mock_exam_question_ai_explanations enable row level security;

-- quiz_api: the API checks question → workspace → membership (and the submission gate) on every
-- request; the insert policy bounds what a new row may look like.
create policy quiz_api_select on public.question_ai_explanations
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_ai_explanations
  for insert to quiz_api
  with check (status = 'queued' and body is null and error_code is null and finished_at is null
              and started_at is null and superseded_at is null and dropped_citations = 0
              and not truncated);
create policy quiz_api_select on public.mock_exam_question_ai_explanations
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_question_ai_explanations
  for insert to quiz_api
  with check (status = 'queued' and body is null and error_code is null and finished_at is null
              and started_at is null and superseded_at is null and dropped_citations = 0
              and not truncated);

-- quiz_worker: an unfinished row moves on; a succeeded one may only be superseded.
create policy quiz_worker_select on public.question_ai_explanations
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.question_ai_explanations
  for update to quiz_worker
  using (status in ('queued', 'running') or (status = 'succeeded' and superseded_at is null))
  with check (true);
create policy quiz_worker_select on public.mock_exam_question_ai_explanations
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.mock_exam_question_ai_explanations
  for update to quiz_worker
  using (status in ('queued', 'running') or (status = 'succeeded' and superseded_at is null))
  with check (true);
