-- MOCK-B: mock exams (MOCK-01, docs/questions.md §11, docs/architecture.md §5).
--
-- A mock exam is a saved generation setting (title, config, range) plus the questions made from
-- it. Its questions live only here: nothing in this migration reads or writes the question bank
-- tables except the source foreign key below (questions.md §11, decision 2). Additive only: new
-- tables, their grants/policies/indexes/triggers, two trigger functions, and EXECUTE on the existing
-- question_*_valid CHECK helpers for quiz_worker. Nothing existing is altered.
--
-- mock_exams                   the saved setting; soft delete (`deleted_at`). `version` counts
--                              its mock_exam_revisions rows; `current_generation_id` is the
--                              generation whose questions are shown (set by the worker when a
--                              generation succeeds or partly succeeds; a failed one keeps it).
-- mock_exam_revisions          append-only history: one row per create / rename / settings change
-- mock_exam_generations        one generation (회차) per make / remake; `version` 1, 2, ...;
--                              at most one queued/running generation per mock exam (partial
--                              unique index: POST answers 409 `mock-generation-running`).
--                              `plan` [{position, question_id, question_revision_id,
--                              variation_type, chapter_rank}] is pinned by the API from the range
--                              and the seed; the job reads only these revisions. Counts and usage
--                              only: no prompt, no LLM output, no question text.
-- mock_exam_generation_items   per-plan-item checkpoint (pending -> done | failed -> done |
--                              skipped), written by the worker in the transaction that stores a
--                              finished batch, so a restarted job never calls a finished batch
--                              again.
-- mock_exam_questions          one made question; source FK `on delete set null` (a hard-deleted
--                              source keeps the copy practisable); `removed_at` = taken out of the
--                              mock exam (soft).
-- mock_exam_question_revisions append-only content snapshots (stable option ids); an edit is a
--                              new row.
-- mock_exam_practice_sessions  / mock_exam_attempts: the shape of practice_sessions /
--                              question_attempts against mock exam revisions (MOCK-P writes them).
--                              `practice_run_id` / `run_position` link a session to a QVIEW
--                              practice run; the FK to practice_runs is added with MOCK-P.
--
-- Append-only (C04): mock_exam_revisions, mock_exam_question_revisions and mock_exam_attempts
-- refuse UPDATE and DELETE for every role (trigger), except the referential actions of a
-- cascade (a deleted workspace, user or parent row: pg_trigger_depth() > 1).
--
-- quiz_api: CRUD of mock exams (no DELETE), queued generations, question edits (new revisions)
--   and removal, practice sessions and attempts, settling a generation whose job ended.
-- quiz_worker (`mock_exam.generate`): reads its generation and the mock exam, writes the
--   generation's progress/result, the item checkpoints, the made questions and their first
--   revisions, and `mock_exams.current_generation_id`. It cannot insert generations or touch
--   another column of a mock exam.
-- Activity `mock_exam.generated` (ids and counts only) is written by a trigger when a generation
-- finishes, so the worker needs no privilege on activity_events.

-- ---------------------------------------------------------------------------------------------
-- mock_exams
-- ---------------------------------------------------------------------------------------------
create table public.mock_exams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null,
  config jsonb not null,
  range jsonb not null,
  version integer not null default 1,
  current_generation_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id) on delete set null,
  constraint mock_exams_workspace_id_id_key unique (workspace_id, id),
  constraint mock_exams_title_length check (btrim(title) <> '' and char_length(title) <= 100),
  constraint mock_exams_config_object
    check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  constraint mock_exams_range_object
    check (jsonb_typeof(range) = 'object' and pg_column_size(range) <= 262144),
  constraint mock_exams_version_positive check (version >= 1),
  constraint mock_exams_deleted_consistent check (deleted_by is null or deleted_at is not null)
);

comment on table public.mock_exams is
  'MOCK: saved mock exam settings (title, config, range); questions live in mock_exam_questions.';

create index mock_exams_workspace_idx
  on public.mock_exams (workspace_id, created_at desc, id desc) where deleted_at is null;
create index mock_exams_created_by_idx on public.mock_exams (created_by);
create index mock_exams_deleted_by_idx on public.mock_exams (deleted_by);

create trigger mock_exams_set_updated_at
  before update on public.mock_exams
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- mock_exam_revisions (append-only)
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_id uuid not null,
  version integer not null,
  title text not null,
  config jsonb not null,
  range jsonb not null,
  edited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint mock_exam_revisions_exam_fk foreign key (workspace_id, mock_exam_id)
    references public.mock_exams (workspace_id, id) on delete cascade,
  constraint mock_exam_revisions_version_key unique (mock_exam_id, version),
  constraint mock_exam_revisions_version_positive check (version >= 1),
  constraint mock_exam_revisions_title_length
    check (btrim(title) <> '' and char_length(title) <= 100),
  constraint mock_exam_revisions_config_object
    check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  constraint mock_exam_revisions_range_object
    check (jsonb_typeof(range) = 'object' and pg_column_size(range) <= 262144)
);

create index mock_exam_revisions_edited_by_idx on public.mock_exam_revisions (edited_by);

-- ---------------------------------------------------------------------------------------------
-- mock_exam_generations
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_generations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_id uuid not null,
  version integer not null,
  status text not null default 'queued',
  job_id uuid,
  config jsonb not null,
  range jsonb not null,
  plan jsonb not null,
  seed bigint not null,
  requested_count integer not null,
  created_count integer not null default 0,
  skipped_count integer not null default 0,
  progress_done integer not null default 0,
  llm_calls integer not null default 0,
  batches_total integer,
  batches_done integer not null default 0,
  prompt_version text,
  model text,
  error_code text,
  usage jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint mock_exam_generations_workspace_id_id_key unique (workspace_id, id),
  constraint mock_exam_generations_exam_id_key unique (mock_exam_id, id),
  constraint mock_exam_generations_version_key unique (mock_exam_id, version),
  constraint mock_exam_generations_exam_fk foreign key (workspace_id, mock_exam_id)
    references public.mock_exams (workspace_id, id) on delete cascade,
  constraint mock_exam_generations_job_fk foreign key (workspace_id, job_id)
    references public.async_jobs (workspace_id, id) on delete set null (job_id),
  constraint mock_exam_generations_status_valid
    check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  constraint mock_exam_generations_version_positive check (version >= 1),
  constraint mock_exam_generations_config_object
    check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  constraint mock_exam_generations_range_object
    check (jsonb_typeof(range) = 'object' and pg_column_size(range) <= 262144),
  constraint mock_exam_generations_plan_array
    check (jsonb_typeof(plan) = 'array' and jsonb_array_length(plan) between 1 and 5000
           and pg_column_size(plan) <= 2097152),
  constraint mock_exam_generations_seed_range check (seed between 0 and 2147483647),
  constraint mock_exam_generations_counts_valid
    check (requested_count = jsonb_array_length(plan)
           and created_count >= 0 and skipped_count >= 0
           and created_count + skipped_count <= requested_count
           and progress_done between 0 and requested_count
           and llm_calls >= 0
           and (batches_total is null or batches_total >= 0)
           and batches_done >= 0),
  constraint mock_exam_generations_usage_object
    check (usage is null or (jsonb_typeof(usage) = 'object' and pg_column_size(usage) <= 8192)),
  constraint mock_exam_generations_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint mock_exam_generations_provenance_length
    check ((prompt_version is null or char_length(prompt_version) <= 200)
           and (model is null or char_length(model) <= 200)),
  constraint mock_exam_generations_finished_consistent
    check ((status in ('queued', 'running')) = (finished_at is null))
);

comment on table public.mock_exam_generations is
  'MOCK: one generation (회차) of a mock exam; counts, codes and usage only (no text).';

-- One queued/running generation per mock exam; the workspace's running count (C06).
create unique index mock_exam_generations_active_key
  on public.mock_exam_generations (mock_exam_id) where status in ('queued', 'running');
create index mock_exam_generations_workspace_active_idx
  on public.mock_exam_generations (workspace_id) where status in ('queued', 'running');
create index mock_exam_generations_exam_idx
  on public.mock_exam_generations (mock_exam_id, version desc);
create index mock_exam_generations_job_idx
  on public.mock_exam_generations (workspace_id, job_id) where job_id is not null;
create index mock_exam_generations_created_by_idx on public.mock_exam_generations (created_by);

create trigger mock_exam_generations_set_updated_at
  before update on public.mock_exam_generations
  for each row execute function public.set_updated_at();

-- The shown generation is one of the mock exam's own.
alter table public.mock_exams
  add constraint mock_exams_current_generation_fk
  foreign key (id, current_generation_id)
  references public.mock_exam_generations (mock_exam_id, id) on delete set null (current_generation_id);

create index mock_exams_current_generation_idx
  on public.mock_exams (id, current_generation_id) where current_generation_id is not null;

-- ---------------------------------------------------------------------------------------------
-- mock_exam_questions and their revisions
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_id uuid not null,
  generation_id uuid not null,
  position integer not null,
  question_type text not null,
  variation_type text not null,
  active_revision_id uuid,
  source_question_id uuid,
  source_question_revision_id uuid,
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mock_exam_questions_workspace_id_id_key unique (workspace_id, id),
  constraint mock_exam_questions_generation_position_key unique (generation_id, position),
  constraint mock_exam_questions_exam_fk foreign key (workspace_id, mock_exam_id)
    references public.mock_exams (workspace_id, id) on delete cascade,
  constraint mock_exam_questions_generation_fk foreign key (mock_exam_id, generation_id)
    references public.mock_exam_generations (mock_exam_id, id) on delete cascade,
  -- A hard-deleted source (or its revision) leaves the copy practisable (C08).
  constraint mock_exam_questions_source_fk
    foreign key (workspace_id, source_question_id, source_question_revision_id)
    references public.question_revisions (workspace_id, question_id, id)
    on delete set null (source_question_id, source_question_revision_id),
  constraint mock_exam_questions_position_valid check (position >= 0 and position < 5000),
  constraint mock_exam_questions_question_type_valid
    check (question_type in ('MCQ', 'SHORT_ANSWER', 'ESSAY')),
  constraint mock_exam_questions_variation_type_valid
    check (variation_type in ('OPTION_SHUFFLE', 'PARAPHRASE', 'INVERT_POLARITY',
                              'ANALOGOUS_CONCEPT')),
  constraint mock_exam_questions_removed_consistent
    check (removed_by is null or removed_at is not null)
);

create index mock_exam_questions_exam_idx
  on public.mock_exam_questions (mock_exam_id, generation_id, position);
create index mock_exam_questions_source_idx
  on public.mock_exam_questions (workspace_id, source_question_id, source_question_revision_id)
  where source_question_id is not null;
create index mock_exam_questions_removed_by_idx on public.mock_exam_questions (removed_by);

create trigger mock_exam_questions_set_updated_at
  before update on public.mock_exam_questions
  for each row execute function public.set_updated_at();

create table public.mock_exam_question_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_question_id uuid not null,
  version integer not null,
  stem text not null,
  options jsonb not null default '[]'::jsonb,
  correct_option_ids text[],
  accepted_answers text[],
  is_multi_answer boolean not null default false,
  explanation text,
  rubric text,
  evidence jsonb not null default '[]'::jsonb,
  validation_issues jsonb not null default '[]'::jsonb,
  origin text not null,
  edited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint mock_exam_question_revisions_question_fk
    foreign key (workspace_id, mock_exam_question_id)
    references public.mock_exam_questions (workspace_id, id) on delete cascade,
  constraint mock_exam_question_revisions_version_key unique (mock_exam_question_id, version),
  constraint mock_exam_question_revisions_ref_key
    unique (workspace_id, mock_exam_question_id, id),
  constraint mock_exam_question_revisions_version_positive check (version >= 1),
  constraint mock_exam_question_revisions_stem_length
    check (btrim(stem) <> '' and char_length(stem) <= 20000),
  constraint mock_exam_question_revisions_options_valid
    check (public.question_options_valid(options)),
  constraint mock_exam_question_revisions_correct_options_valid
    check (public.question_correct_options_valid(options, correct_option_ids)),
  constraint mock_exam_question_revisions_single_answer
    check (is_multi_answer or correct_option_ids is null or cardinality(correct_option_ids) = 1),
  constraint mock_exam_question_revisions_accepted_answers_valid
    check (public.question_text_items_valid(accepted_answers)),
  constraint mock_exam_question_revisions_explanation_length
    check (explanation is null or char_length(explanation) <= 20000),
  constraint mock_exam_question_revisions_rubric_length
    check (rubric is null or char_length(rubric) <= 20000),
  constraint mock_exam_question_revisions_evidence_array
    check (jsonb_typeof(evidence) = 'array' and pg_column_size(evidence) <= 262144),
  constraint mock_exam_question_revisions_issues_array
    check (jsonb_typeof(validation_issues) = 'array'
           and pg_column_size(validation_issues) <= 65536),
  constraint mock_exam_question_revisions_origin_valid check (origin in ('generated', 'edited')),
  constraint mock_exam_question_revisions_origin_consistent
    check ((origin = 'generated') = (version = 1))
);

create index mock_exam_question_revisions_edited_by_idx
  on public.mock_exam_question_revisions (edited_by);

alter table public.mock_exam_questions
  add constraint mock_exam_questions_active_revision_fk
  foreign key (workspace_id, id, active_revision_id)
  references public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, id);

-- ---------------------------------------------------------------------------------------------
-- mock_exam_generation_items (per-item checkpoint)
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_generation_items (
  generation_id uuid not null,
  position integer not null,
  workspace_id uuid not null,
  source_question_id uuid not null,
  source_question_revision_id uuid not null,
  variation_type text not null,
  batch_no integer,
  status text not null default 'pending',
  skip_reason text,
  mock_exam_question_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mock_exam_generation_items_pkey primary key (generation_id, position),
  constraint mock_exam_generation_items_generation_fk foreign key (workspace_id, generation_id)
    references public.mock_exam_generations (workspace_id, id) on delete cascade,
  constraint mock_exam_generation_items_question_fk
    foreign key (workspace_id, mock_exam_question_id)
    references public.mock_exam_questions (workspace_id, id) on delete set null (mock_exam_question_id),
  constraint mock_exam_generation_items_position_valid
    check (position >= 0 and position < 5000),
  constraint mock_exam_generation_items_variation_type_valid
    check (variation_type in ('OPTION_SHUFFLE', 'PARAPHRASE', 'INVERT_POLARITY',
                              'ANALOGOUS_CONCEPT')),
  constraint mock_exam_generation_items_status_valid
    check (status in ('pending', 'done', 'failed', 'retried', 'skipped')),
  constraint mock_exam_generation_items_batch_no_valid check (batch_no is null or batch_no >= 0),
  constraint mock_exam_generation_items_skip_reason_format
    check (skip_reason is null or skip_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint mock_exam_generation_items_done_consistent
    check (status <> 'done' or mock_exam_question_id is not null)
);

create index mock_exam_generation_items_question_idx
  on public.mock_exam_generation_items (workspace_id, mock_exam_question_id)
  where mock_exam_question_id is not null;

create trigger mock_exam_generation_items_set_updated_at
  before update on public.mock_exam_generation_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Practice (MOCK-P writes these): the shape of practice_sessions / question_attempts.
-- ---------------------------------------------------------------------------------------------
create table public.mock_exam_practice_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_question_id uuid not null,
  mock_exam_question_revision_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  practice_run_id uuid,
  run_position integer,
  displayed_option_ids text[] not null default '{}',
  shuffle_seed bigint,
  state text not null default 'open',
  opened_at timestamptz not null default now(),
  submitted_at timestamptz,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mock_exam_practice_sessions_revision_fk
    foreign key (workspace_id, mock_exam_question_id, mock_exam_question_revision_id)
    references public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, id)
    on delete cascade,
  constraint mock_exam_practice_sessions_attempt_ref_key
    unique (id, user_id, mock_exam_question_revision_id),
  constraint mock_exam_practice_sessions_displayed_option_ids_valid
    check (public.question_ids_valid(displayed_option_ids)),
  constraint mock_exam_practice_sessions_state_valid
    check (state in ('open', 'pending_grade', 'graded')),
  constraint mock_exam_practice_sessions_state_timestamps check (
    (state = 'open' and submitted_at is null and graded_at is null)
    or (state = 'pending_grade' and submitted_at is not null and graded_at is null)
    or (state = 'graded' and submitted_at is not null and graded_at is not null)
  ),
  constraint mock_exam_practice_sessions_run_consistent
    check ((practice_run_id is null) = (run_position is null)
           and (run_position is null or (run_position >= 0 and run_position < 5000)))
);

create index mock_exam_practice_sessions_user_question_idx
  on public.mock_exam_practice_sessions (user_id, mock_exam_question_id, opened_at desc);
create index mock_exam_practice_sessions_revision_idx
  on public.mock_exam_practice_sessions
     (workspace_id, mock_exam_question_id, mock_exam_question_revision_id);
create unique index mock_exam_practice_sessions_run_position_key
  on public.mock_exam_practice_sessions (practice_run_id, run_position)
  where practice_run_id is not null;

create trigger mock_exam_practice_sessions_set_updated_at
  before update on public.mock_exam_practice_sessions
  for each row execute function public.set_updated_at();

create table public.mock_exam_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mock_exam_question_id uuid not null,
  mock_exam_question_revision_id uuid not null,
  practice_session_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  displayed_option_ids text[] not null default '{}',
  submitted_answer jsonb not null,
  result text not null,
  grading_method text,
  grades_attempt_id uuid,
  graded_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz not null default now(),
  graded_at timestamptz,
  constraint mock_exam_attempts_revision_fk
    foreign key (workspace_id, mock_exam_question_id, mock_exam_question_revision_id)
    references public.mock_exam_question_revisions (workspace_id, mock_exam_question_id, id)
    on delete cascade,
  constraint mock_exam_attempts_session_fk
    foreign key (practice_session_id, user_id, mock_exam_question_revision_id)
    references public.mock_exam_practice_sessions (id, user_id, mock_exam_question_revision_id)
    on delete cascade,
  constraint mock_exam_attempts_grade_ref_key
    unique (mock_exam_question_revision_id, user_id, id),
  constraint mock_exam_attempts_grades_attempt_fk
    foreign key (mock_exam_question_revision_id, user_id, grades_attempt_id)
    references public.mock_exam_attempts (mock_exam_question_revision_id, user_id, id)
    on delete cascade,
  constraint mock_exam_attempts_grades_attempt_key unique (grades_attempt_id),
  constraint mock_exam_attempts_displayed_option_ids_valid
    check (public.question_ids_valid(displayed_option_ids)),
  constraint mock_exam_attempts_submitted_answer_object
    check (jsonb_typeof(submitted_answer) = 'object'),
  constraint mock_exam_attempts_submitted_answer_size
    check (pg_column_size(submitted_answer) <= 65536),
  constraint mock_exam_attempts_result_valid
    check (result in ('correct', 'incorrect', 'pending')),
  constraint mock_exam_attempts_grading_method_valid
    check (grading_method is null or grading_method in ('auto', 'self', 'reviewer')),
  constraint mock_exam_attempts_grading_consistent check (
    (result = 'pending' and grading_method is null and graded_at is null
       and grades_attempt_id is null and graded_by is null)
    or (result in ('correct', 'incorrect') and graded_at is not null and (
          (coalesce(grading_method = 'auto', false)
             and grades_attempt_id is null and graded_by is null)
          or (coalesce(grading_method in ('self', 'reviewer'), false)
             and grades_attempt_id is not null)
       ))
  )
);

create index mock_exam_attempts_user_question_idx
  on public.mock_exam_attempts (user_id, mock_exam_question_id, submitted_at desc);
create index mock_exam_attempts_revision_idx
  on public.mock_exam_attempts
     (workspace_id, mock_exam_question_id, mock_exam_question_revision_id);
create index mock_exam_attempts_session_idx on public.mock_exam_attempts (practice_session_id);
create index mock_exam_attempts_graded_by_idx on public.mock_exam_attempts (graded_by);

-- ---------------------------------------------------------------------------------------------
-- Append-only history (C04): no UPDATE or DELETE except a cascade's referential action.
-- ---------------------------------------------------------------------------------------------
create function public.mock_exam_append_only()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  -- Referential actions (workspace / user / parent row deleted) run inside the RI trigger.
  if pg_catalog.pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception '% is append-only (% refused)', tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

comment on function public.mock_exam_append_only() is
  'MOCK trigger: refuse UPDATE/DELETE on append-only mock exam history (cascades excepted).';

create trigger mock_exam_revisions_append_only
  before update or delete on public.mock_exam_revisions
  for each row execute function public.mock_exam_append_only();
create trigger mock_exam_question_revisions_append_only
  before update or delete on public.mock_exam_question_revisions
  for each row execute function public.mock_exam_append_only();
create trigger mock_exam_attempts_append_only
  before update or delete on public.mock_exam_attempts
  for each row execute function public.mock_exam_append_only();

-- ---------------------------------------------------------------------------------------------
-- Activity: `mock_exam.generated` when a generation finishes (ids and counts only).
-- ---------------------------------------------------------------------------------------------
create function public.mock_exam_generations_record_finished()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id,
                                      metadata)
  values (new.workspace_id, new.created_by, 'mock_exam.generated', 'mock_exam', new.mock_exam_id,
          pg_catalog.jsonb_build_object(
            'generation_id', new.id::text,
            'version', new.version,
            'status', new.status,
            'requested_count', new.requested_count,
            'created_count', new.created_count,
            'skipped_count', new.skipped_count,
            'llm_calls', new.llm_calls,
            'error_code', new.error_code));
  return null;
end;
$$;

comment on function public.mock_exam_generations_record_finished() is
  'MOCK trigger: activity mock_exam.generated (ids and counts only) when a generation ends.';

create trigger mock_exam_generations_record_finished
  after update of status on public.mock_exam_generations
  for each row
  when (new.status in ('succeeded', 'partial', 'failed')
        and old.status in ('queued', 'running'))
  execute function public.mock_exam_generations_record_finished();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on table
  public.mock_exams,
  public.mock_exam_revisions,
  public.mock_exam_generations,
  public.mock_exam_generation_items,
  public.mock_exam_questions,
  public.mock_exam_question_revisions,
  public.mock_exam_practice_sessions,
  public.mock_exam_attempts
from public, anon, authenticated;
revoke all on function public.mock_exam_append_only()
  from public, anon, authenticated, quiz_api, quiz_worker;
revoke all on function public.mock_exam_generations_record_finished()
  from public, anon, authenticated, quiz_api, quiz_worker;

-- The CHECK helpers of the copied question content (quiz_api already has them).
grant execute on function public.question_options_valid(jsonb) to quiz_worker;
grant execute on function public.question_correct_options_valid(jsonb, text[]) to quiz_worker;
grant execute on function public.question_text_items_valid(text[]) to quiz_worker;
grant execute on function public.question_ids_valid(text[]) to quiz_worker;

grant select, insert on public.mock_exams to quiz_api;
grant update (title, config, range, version, deleted_at, deleted_by, updated_at)
  on public.mock_exams to quiz_api;
grant select, insert on public.mock_exam_revisions to quiz_api;
grant select, insert on public.mock_exam_generations to quiz_api;
grant update (status, error_code, finished_at, updated_at)
  on public.mock_exam_generations to quiz_api;
grant select on public.mock_exam_generation_items to quiz_api;
grant select on public.mock_exam_questions to quiz_api;
grant update (active_revision_id, removed_at, removed_by, updated_at)
  on public.mock_exam_questions to quiz_api;
grant select, insert on public.mock_exam_question_revisions to quiz_api;
grant select, insert, update on public.mock_exam_practice_sessions to quiz_api;
grant select, insert on public.mock_exam_attempts to quiz_api;

grant select on public.mock_exams to quiz_worker;
grant update (current_generation_id, updated_at) on public.mock_exams to quiz_worker;
grant select on public.mock_exam_generations to quiz_worker;
grant update (status, created_count, skipped_count, progress_done, llm_calls, batches_total,
              batches_done, prompt_version, model, error_code, usage, started_at, finished_at,
              updated_at)
  on public.mock_exam_generations to quiz_worker;
grant select, insert on public.mock_exam_generation_items to quiz_worker;
grant update (batch_no, status, skip_reason, mock_exam_question_id, updated_at)
  on public.mock_exam_generation_items to quiz_worker;
grant select, insert on public.mock_exam_questions to quiz_worker;
grant update (active_revision_id, updated_at) on public.mock_exam_questions to quiz_worker;
grant select, insert on public.mock_exam_question_revisions to quiz_worker;

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------
alter table public.mock_exams enable row level security;
alter table public.mock_exam_revisions enable row level security;
alter table public.mock_exam_generations enable row level security;
alter table public.mock_exam_generation_items enable row level security;
alter table public.mock_exam_questions enable row level security;
alter table public.mock_exam_question_revisions enable row level security;
alter table public.mock_exam_practice_sessions enable row level security;
alter table public.mock_exam_attempts enable row level security;

create policy quiz_api_select on public.mock_exams for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exams
  for insert to quiz_api
  with check (deleted_at is null and current_generation_id is null and version = 1);
create policy quiz_api_update on public.mock_exams
  for update to quiz_api using (deleted_at is null) with check (true);

create policy quiz_api_select on public.mock_exam_revisions
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_revisions
  for insert to quiz_api with check (true);

create policy quiz_api_select on public.mock_exam_generations
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_generations
  for insert to quiz_api
  with check (status = 'queued' and created_count = 0 and skipped_count = 0
              and progress_done = 0 and llm_calls = 0 and usage is null
              and error_code is null and started_at is null and finished_at is null);
-- Settle (job ended without the worker) or cancel (the mock exam is deleted): never a success.
create policy quiz_api_update on public.mock_exam_generations
  for update to quiz_api
  using (status in ('queued', 'running'))
  with check (status in ('failed', 'cancelled'));

create policy quiz_api_select on public.mock_exam_generation_items
  for select to quiz_api using (true);

create policy quiz_api_select on public.mock_exam_questions
  for select to quiz_api using (true);
create policy quiz_api_update on public.mock_exam_questions
  for update to quiz_api using (removed_at is null) with check (true);

create policy quiz_api_select on public.mock_exam_question_revisions
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_question_revisions
  for insert to quiz_api with check (origin = 'edited');

create policy quiz_api_all on public.mock_exam_practice_sessions
  for all to quiz_api using (true) with check (true);
create policy quiz_api_select on public.mock_exam_attempts
  for select to quiz_api using (true);
create policy quiz_api_insert on public.mock_exam_attempts
  for insert to quiz_api with check (true);

create policy quiz_worker_select on public.mock_exams for select to quiz_worker using (true);
create policy quiz_worker_update on public.mock_exams
  for update to quiz_worker using (deleted_at is null) with check (deleted_at is null);
create policy quiz_worker_select on public.mock_exam_generations
  for select to quiz_worker using (true);
create policy quiz_worker_update on public.mock_exam_generations
  for update to quiz_worker using (status in ('queued', 'running')) with check (true);
create policy quiz_worker_select on public.mock_exam_generation_items
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.mock_exam_generation_items
  for insert to quiz_worker with check (status = 'pending' and mock_exam_question_id is null);
create policy quiz_worker_update on public.mock_exam_generation_items
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.mock_exam_questions
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.mock_exam_questions
  for insert to quiz_worker with check (removed_at is null and removed_by is null);
create policy quiz_worker_update on public.mock_exam_questions
  for update to quiz_worker using (true) with check (true);
create policy quiz_worker_select on public.mock_exam_question_revisions
  for select to quiz_worker using (true);
create policy quiz_worker_insert on public.mock_exam_question_revisions
  for insert to quiz_worker with check (origin = 'generated' and edited_by is null);
