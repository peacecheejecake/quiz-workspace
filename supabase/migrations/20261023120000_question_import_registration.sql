-- QIMP-JOB: registering the selected import drafts continues on the server (QIMPORT-01-AC07,
-- docs/questions.md §6). Until now the import page sent the selection in browser-driven batches
-- of 200 (`POST /question-imports/{id}/publish` with `approve: true`); leaving the page stopped
-- the registration half-way. Now one request records the whole selection and a
-- `question.import_register` job approves and registers it in batches.
--
-- Additive only: one nullable column, one table, one function and its grants.
--
-- question_import_runs.registration_job_id
--   The run's newest registration job (set by quiz_api when a selection is submitted); the import
--   page reattaches to it on return. quiz_worker has no UPDATE on it (its column grants on runs
--   are status/finished_at/provenance only, 20261018100000).
--
-- question_import_registration_items (one row per submitted draft)
--   Written by quiz_api in the submit transaction: the draft, the version the reviewer selected
--   and the chapter to register it under (resolved by the API, CHAPTER-MAP; null = none). Drafts
--   the API already refuses at submit (changed since: `stale-draft`, cannot be confirmed:
--   `not-publishable`) or finds registered (`skipped`) are recorded as such, the rest `pending`.
--   Only worker_register_import_drafts (below) moves a pending item; nobody deletes items (they
--   go with their job / run / draft). The items are the job's durable progress: processed/total
--   and the refused list are read from them, and a retried or re-delivered job continues with the
--   pending ones, so nothing is registered twice.
--
-- worker_register_import_drafts(job, limit) -> (outcome, registered, skipped, refused, remaining)
--   Called by the `question.import_register` job (quiz_worker), one transaction per batch.
--   SECURITY DEFINER: quiz_worker has (and keeps) no privilege on drafts, questions, revisions,
--   sources or activity; this function is its one narrow capability. Per call:
--     * the job must be a running `question.import_register` job ('not_found' / 'not_running');
--     * its workspace must still be writable by the job's user, rows locked FOR SHARE
--       ('workspace_unavailable': archived, deleted, or the user lost the editor role);
--     * up to `limit` pending items, drafts locked FOR UPDATE in position order (the API's
--       publish lock order), then the documents of their chapters FOR SHARE (the API's question
--       lock order: a concurrent revision publish either commits first and the chapter is
--       resolved in its new revision, or waits and remaps the committed question);
--     * per item: a draft that is already registered -> `skipped` (its question); a draft whose
--       version is not the selected one -> `refused`/`stale-draft` (never registered silently);
--       otherwise the draft is approved by the job's user (unless approved already) and
--       registered exactly like the API's publish: a CONFIRMED question (origin `import`,
--       revision 1 from the draft, the chapter resolved to the current revision of its document
--       by section key, or none), one import source row, `question.created`, the draft's
--       `published_question_id`. A draft at the selected version is unchanged since the API found
--       it confirmable at submit, so the content rules are not repeated here; a row the
--       constraints still reject is `refused`/`not-publishable` and nothing of it is kept.
--     * one `question_import.published` activity with the batch's count.
--   Draft version: the API's `draft_version` (updated_at in microseconds since the epoch, hex).

alter table public.question_import_runs
  add column registration_job_id uuid references public.async_jobs (id) on delete set null;

create table public.question_import_registration_items (
  workspace_id uuid not null,
  job_id uuid not null references public.async_jobs (id) on delete cascade,
  import_run_id uuid not null,
  draft_id uuid not null,
  -- Order of the submitted selection (0-based).
  ordinal integer not null,
  version text not null,
  chapter_id uuid,
  state text not null default 'pending',
  reason text,
  question_id uuid,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint question_import_registration_items_pkey primary key (job_id, draft_id),
  constraint question_import_registration_items_ordinal_key unique (job_id, ordinal),
  constraint question_import_registration_items_run_fk foreign key (workspace_id, import_run_id)
    references public.question_import_runs (workspace_id, id) on delete cascade,
  constraint question_import_registration_items_draft_fk foreign key (workspace_id, draft_id)
    references public.question_drafts (workspace_id, id) on delete cascade,
  constraint question_import_registration_items_chapter_fk foreign key (workspace_id, chapter_id)
    references public.chapters (workspace_id, id) on delete set null (chapter_id),
  constraint question_import_registration_items_question_fk foreign key (workspace_id, question_id)
    references public.questions (workspace_id, id),
  constraint question_import_registration_items_ordinal_non_negative check (ordinal >= 0),
  constraint question_import_registration_items_version_length
    check (char_length(version) between 1 and 64),
  constraint question_import_registration_items_state_valid
    check (state in ('pending', 'registered', 'skipped', 'refused')),
  constraint question_import_registration_items_reason_valid
    check (reason is null or reason in ('stale-draft', 'not-publishable')),
  constraint question_import_registration_items_reason_iff_refused
    check ((state = 'refused') = (reason is not null)),
  constraint question_import_registration_items_question_iff_done
    check ((state in ('registered', 'skipped')) = (question_id is not null)),
  constraint question_import_registration_items_processed_iff_done
    check ((state = 'pending') = (processed_at is null))
);

create index question_import_registration_items_run_idx
  on public.question_import_registration_items (import_run_id);
create index question_import_registration_items_draft_idx
  on public.question_import_registration_items (draft_id);
create index question_import_registration_items_pending_idx
  on public.question_import_registration_items (job_id) where state = 'pending';

alter table public.question_import_registration_items enable row level security;

grant select, insert on public.question_import_registration_items to quiz_api;
create policy quiz_api_select on public.question_import_registration_items
  for select to quiz_api using (true);
create policy quiz_api_insert on public.question_import_registration_items
  for insert to quiz_api with check (true);

grant select on public.question_import_registration_items to quiz_worker;
create policy quiz_worker_select on public.question_import_registration_items
  for select to quiz_worker using (true);

create function public.worker_register_import_drafts(p_job_id uuid, p_limit integer)
returns table (outcome text, registered integer, skipped integer, refused integer,
               remaining integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job record;
  run record;
  d record;
  item record;
  ids uuid[];
  v_type text;
  v_accepted jsonb;
  v_rubric text;
  v_options jsonb;
  v_chapter uuid;
  v_question uuid;
  v_revision uuid;
  v_payload jsonb;
  n_registered integer := 0;
  n_skipped integer := 0;
  n_refused integer := 0;
begin
  outcome := 'ok';
  registered := 0;
  skipped := 0;
  refused := 0;
  remaining := 0;
  select j.id, j.workspace_id, j.created_by, j.status, j.job_type, j.payload
    into job
    from public.async_jobs j
   where j.id = p_job_id;
  if not found or job.job_type <> 'question.import_register' then
    outcome := 'not_found';
    return next;
    return;
  end if;
  if job.status <> 'running' then
    outcome := 'not_running';
    return next;
    return;
  end if;
  if not public.worker_workspace_writable(job.workspace_id, job.created_by, true) then
    outcome := 'workspace_unavailable';
    return next;
    return;
  end if;
  select r.id, r.workspace_id, r.source_document_id, r.source_document_revision_id
    into run
    from public.question_import_runs r
   where r.workspace_id = job.workspace_id
     and r.id::text = job.payload ->> 'import_id';
  if not found then
    outcome := 'not_found';
    return next;
    return;
  end if;

  select pg_catalog.array_agg(x.draft_id order by x.position, x.draft_id)
    into ids
    from (
      select i.draft_id, qd.position
        from public.question_import_registration_items i
        join public.question_drafts qd on qd.id = i.draft_id
       where i.job_id = p_job_id and i.state = 'pending'
       order by qd.position, i.draft_id
       limit greatest(coalesce(p_limit, 0), 0)
    ) x;

  if ids is not null then
    perform 1
       from public.question_drafts qd
      where qd.id = any (ids)
      order by qd.position, qd.id
        for update of qd;
    perform 1
       from public.documents doc
      where doc.workspace_id = job.workspace_id
        and doc.id in (
          select c.document_id
            from public.question_import_registration_items i
            join public.chapters c on c.id = i.chapter_id and c.workspace_id = i.workspace_id
           where i.job_id = p_job_id and i.draft_id = any (ids)
        )
      order by doc.id
        for share of doc;

    for item in
      select i.draft_id, i.version, i.chapter_id, i.state
        from public.question_import_registration_items i
        join public.question_drafts qd on qd.id = i.draft_id
       where i.job_id = p_job_id and i.draft_id = any (ids)
       order by qd.position, i.draft_id
         for update of i
    loop
      continue when item.state <> 'pending';
      select qd.id, qd.import_run_id, qd.question_type, qd.question_number, qd.is_multi_answer,
             qd.rubric, qd.payload, qd.review_status, qd.published_question_id, qd.updated_at
        into d
        from public.question_drafts qd
       where qd.id = item.draft_id;

      if d.published_question_id is not null then
        update public.question_import_registration_items
           set state = 'skipped', question_id = d.published_question_id,
               processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_skipped := n_skipped + 1;
        continue;
      end if;
      if d.import_run_id is distinct from run.id
         or pg_catalog.to_hex(
              (extract(epoch from d.updated_at) * 1000000)::bigint) <> item.version then
        update public.question_import_registration_items
           set state = 'refused', reason = 'stale-draft', processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_refused := n_refused + 1;
        continue;
      end if;

      begin
        -- The draft's content as quiz_api.question_drafts.content_of reads it.
        v_type := d.payload ->> 'question_type';
        v_accepted := coalesce(d.payload -> 'accepted_answers', 'null'::jsonb);
        v_rubric := d.rubric;
        if v_type = 'ESSAY' then
          if v_rubric is null and pg_catalog.jsonb_typeof(v_accepted) = 'array'
             and pg_catalog.jsonb_array_length(v_accepted) > 0 then
            select pg_catalog.string_agg(a.value, E'\n' order by a.ord)
              into v_rubric
              from pg_catalog.jsonb_array_elements_text(v_accepted) with ordinality as a (value, ord);
          end if;
          v_accepted := 'null'::jsonb;
        end if;
        select coalesce(pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('id', o.value ->> 'id', 'text', o.value ->> 'text')
                 order by o.ord), '[]'::jsonb)
          into v_options
          from pg_catalog.jsonb_array_elements(coalesce(d.payload -> 'options', '[]'::jsonb))
               with ordinality as o (value, ord);

        -- The chosen chapter in its document's current revision (same section), or none.
        v_chapter := null;
        if item.chapter_id is not null then
          select nc.id
            into v_chapter
            from public.chapters oc
            join public.documents doc
              on doc.id = oc.document_id and doc.workspace_id = oc.workspace_id
             and doc.deleted_at is null
            join public.chapters nc
              on nc.document_revision_id = doc.active_revision_id
             and nc.section_key = oc.section_key
           where oc.id = item.chapter_id and oc.workspace_id = job.workspace_id;
        end if;

        v_question := pg_catalog.gen_random_uuid();
        v_revision := pg_catalog.gen_random_uuid();
        insert into public.questions (id, workspace_id, chapter_id, question_type, origin,
                                      question_number, publication_status, created_by)
        values (v_question, job.workspace_id, v_chapter, v_type, 'import', d.question_number,
                'DRAFT', job.created_by);
        insert into public.question_revisions (id, workspace_id, question_id, version, stem,
                                               options, correct_option_ids, accepted_answers,
                                               is_multi_answer, explanation, rubric, created_by)
        values (
          v_revision, job.workspace_id, v_question, 1, d.payload ->> 'stem', v_options,
          case when pg_catalog.jsonb_typeof(d.payload -> 'correct_option_ids') = 'array'
               then array(select pg_catalog.jsonb_array_elements_text(
                                   d.payload -> 'correct_option_ids')) end,
          case when pg_catalog.jsonb_typeof(v_accepted) = 'array'
               then array(select pg_catalog.jsonb_array_elements_text(v_accepted)) end,
          d.is_multi_answer, d.payload ->> 'explanation', v_rubric, job.created_by);
        update public.questions
           set active_revision_id = v_revision, publication_status = 'CONFIRMED'
         where id = v_question;
        insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                            target_id, metadata)
        values (job.workspace_id, job.created_by, 'question.created', 'question', v_question,
                pg_catalog.jsonb_build_object('question_type', v_type,
                                              'publication_status', 'CONFIRMED',
                                              'version', 1, 'origin', 'import'));

        -- One source row summarising every evidence region (question_drafts.source_pages).
        with ev as (
          select e.value as evidence, e.ord as ev_ord
            from pg_catalog.jsonb_array_elements(coalesce(d.payload -> 'evidence', '[]'::jsonb))
                 with ordinality as e (value, ord)
        ),
        ev_locations as (
          select l.value, (ev.ev_ord * 100000 + l.ord) as ord
            from ev,
                 pg_catalog.jsonb_array_elements(coalesce(ev.evidence -> 'locations', '[]'::jsonb))
                 with ordinality as l (value, ord)
        ),
        ev_blocks as (
          select b.value as block_id, (ev.ev_ord * 100000 + b.ord) as ord
            from ev,
                 pg_catalog.jsonb_array_elements_text(
                   coalesce(ev.evidence -> 'block_ids', '[]'::jsonb)) with ordinality as b (value, ord)
        )
        insert into public.question_sources (workspace_id, question_id, document_id,
                                             document_revision_id, page_start, page_end,
                                             block_ids, locations, import_run_id)
        select job.workspace_id, v_question, run.source_document_id,
               case when run.source_document_id is not null
                    then run.source_document_revision_id end,
               (select pg_catalog.min((l.value ->> 'page')::integer) from ev_locations l),
               (select pg_catalog.max((l.value ->> 'page')::integer) from ev_locations l),
               coalesce((select array_agg(b.block_id order by b.first_seen)
                           from (select e.block_id, pg_catalog.min(e.ord) as first_seen
                                   from ev_blocks e group by e.block_id) b), '{}'),
               coalesce((select pg_catalog.jsonb_agg(l.value order by l.ord)
                           from ev_locations l), '[]'::jsonb),
               run.id;

        -- The selection is the approval of exactly the content at the selected version; an
        -- earlier approval (reviewer, time) is kept. Only the link is added then.
        v_payload := d.payload;
        if d.review_status <> 'approved' then
          v_payload := d.payload || pg_catalog.jsonb_build_object(
            'review_status', 'approved', 'options', v_options, 'accepted_answers', v_accepted);
          update public.question_drafts
             set review_status = 'approved', reviewed_by = job.created_by,
                 reviewed_at = pg_catalog.now(), payload = v_payload,
                 published_question_id = v_question
           where id = d.id;
        else
          update public.question_drafts set published_question_id = v_question where id = d.id;
        end if;

        update public.question_import_registration_items
           set state = 'registered', question_id = v_question, processed_at = pg_catalog.now()
         where job_id = p_job_id and draft_id = item.draft_id;
        n_registered := n_registered + 1;
      exception
        when check_violation or not_null_violation or foreign_key_violation
             or string_data_right_truncation or invalid_text_representation
             or numeric_value_out_of_range then
          -- Rolled back to the block start: nothing of this draft is kept.
          update public.question_import_registration_items
             set state = 'refused', reason = 'not-publishable', processed_at = pg_catalog.now()
           where job_id = p_job_id and draft_id = item.draft_id;
          n_refused := n_refused + 1;
      end;
    end loop;

    if n_registered > 0 then
      -- Ids and counts only, like the API's own `question_import.published`.
      insert into public.activity_events (workspace_id, actor_id, event_type, target_type,
                                          target_id, metadata)
      values (job.workspace_id, job.created_by, 'question_import.published', 'question_import',
              run.id, pg_catalog.jsonb_build_object('count', n_registered));
    end if;
  end if;

  registered := n_registered;
  skipped := n_skipped;
  refused := n_refused;
  select pg_catalog.count(*)::integer
    into remaining
    from public.question_import_registration_items i
   where i.job_id = p_job_id and i.state = 'pending';
  return next;
end;
$$;

comment on function public.worker_register_import_drafts(uuid, integer) is
  'QIMP-JOB: approve and register the next pending drafts of a question.import_register job (quiz_worker only).';

revoke all on function public.worker_register_import_drafts(uuid, integer)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_register_import_drafts(uuid, integer) to quiz_worker;
