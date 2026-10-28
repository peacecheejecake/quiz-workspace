-- UX6-UPLOAD-B: one upload place for every PDF; the server tells body text and question papers
-- apart (DOC-01-AC07/AC08, docs/questions.md §6). Until now the uploader chose the kind
-- (`document_type` book | question_paper) by where they uploaded.
--
-- Additive only: defaulted/nullable columns, consistency checks over them, one new worker
-- function, and a replaced worker_start_question_import that also starts for books with
-- questions. Existing rows keep their meaning (type_source 'user', content_kind null = derived
-- from document_type).
--
-- documents.document_type stays "is this body text?" and keeps driving search, generation
-- sources and chapter matching: `book` for a book and for a book that also prints questions.
--
-- documents.type_source
--   'user'   the kind was chosen by a person: the upload's explicit document_type (as before,
--            the default) or a later override (PATCH /documents/{id}, `종류 변경`)
--   'auto'   uploaded with document_type 'auto': created as a `book`, classified by the
--            `document.parse` job before its first revision is published
-- documents.content_kind (null = not classified yet / a document from before this migration,
--   read as its document_type)
--   'book' | 'question_paper' | 'mixed' (= a book that also prints questions; document_type book)
--   Always consistent with document_type: question_paper <=> 'question_paper'.
-- documents.detection
--   The classifier's numbers (book_core ContentDetection: kind, confidence, strong_questions,
--   coverage, page_share, answered_ratio, gap_ratio, version). Never document text. Kept after a
--   user override, so a later calibration can compare.
-- document_uploads.auto_classify
--   The intent was created with document_type 'auto' (its document_type column then says
--   'book', the kind the document starts as).
--
-- worker_classify_document(document, revision, kind, detection) -> the document_type set, or null
--   Called by quiz_worker inside the publish transaction of the first revision (document row
--   already locked FOR UPDATE there). Applies only to a live document with type_source 'auto'
--   that was never classified, for its first revision (no parent): a retried or redelivered
--   parse job, a correction revision or a document the user re-typed meanwhile is never
--   reclassified. quiz_worker gets no UPDATE on document_type / content_kind / detection: only
--   this narrow capability.
--
-- worker_register_import_drafts (20261023120000) is replaced unchanged except for one check:
--   an item whose chapter belongs to a document that is no longer a book (re-typed as a
--   question paper after the selection) is refused (`stale-draft`) instead of registered
--   under it. The API also refuses that re-typing while registration items are pending.
--
-- worker_start_question_import (20261021120000) also starts for a `book` whose content_kind is
--   'mixed'. The worker calls it for a question paper, and for a mixed book only when the
--   classifier was confident (a low-confidence one is labelled and waits for the user).

alter table public.documents
  add column type_source text not null default 'user',
  add column content_kind text,
  add column detection jsonb,
  add constraint documents_type_source_valid check (type_source in ('user', 'auto')),
  add constraint documents_content_kind_valid
    check (content_kind is null or content_kind in ('book', 'question_paper', 'mixed')),
  add constraint documents_content_kind_matches_type
    check (content_kind is null
           or (content_kind = 'question_paper') = (document_type = 'question_paper')),
  add constraint documents_detection_object
    check (detection is null
           or (pg_catalog.jsonb_typeof(detection) = 'object'
               and pg_catalog.octet_length(detection::text) <= 2000));

alter table public.document_uploads
  add column auto_classify boolean not null default false,
  add constraint document_uploads_auto_classify_book
    check (not auto_classify or document_type = 'book');

comment on column public.documents.type_source is
  'UX6-UPLOAD-B: user = kind chosen by a person (upload type or override); auto = classified.';
comment on column public.documents.content_kind is
  'UX6-UPLOAD-B: book | question_paper | mixed; null = not classified (read as document_type).';
comment on column public.documents.detection is
  'UX6-UPLOAD-B: content classifier numbers (no document text).';

create function public.worker_classify_document(
  p_document_id uuid,
  p_revision_id uuid,
  p_kind text,
  p_detection jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  doc record;
  new_type text;
begin
  if p_document_id is null or p_revision_id is null
     or p_kind is null or p_kind not in ('book', 'question_paper', 'mixed') then
    return null;
  end if;
  select d.id, d.type_source, d.content_kind, d.deleted_at
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or doc.type_source <> 'auto'
     or doc.content_kind is not null then
    return null;
  end if;
  if not exists (
    select 1 from public.document_revisions r
     where r.id = p_revision_id and r.document_id = p_document_id
       and r.parent_revision_id is null
  ) then
    return null;
  end if;
  new_type := case when p_kind = 'question_paper' then 'question_paper' else 'book' end;
  update public.documents
     set document_type = new_type, content_kind = p_kind, detection = p_detection
   where id = p_document_id;
  return new_type;
end;
$$;

comment on function public.worker_classify_document(uuid, uuid, text, jsonb) is
  'UX6-UPLOAD-B: set the kind of an auto-classified document once (quiz_worker only).';

revoke all on function public.worker_classify_document(uuid, uuid, text, jsonb)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_classify_document(uuid, uuid, text, jsonb) to quiz_worker;

create or replace function public.worker_start_question_import(
  p_document_id uuid,
  p_revision_id uuid,
  p_user_id uuid
)
returns table (run_id uuid, job_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  doc record;
  new_run uuid := pg_catalog.gen_random_uuid();
  new_job uuid := pg_catalog.gen_random_uuid();
begin
  if p_document_id is null or p_revision_id is null or p_user_id is null then
    return;
  end if;
  select d.id, d.workspace_id, d.document_type, d.content_kind, d.active_revision_id,
         d.deleted_at
    into doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if not found
     or doc.deleted_at is not null
     or not (doc.document_type = 'question_paper'
             or doc.content_kind is not distinct from 'mixed')
     or doc.active_revision_id is distinct from p_revision_id then
    return;
  end if;
  if not public.worker_workspace_writable(doc.workspace_id, p_user_id, true) then
    return;
  end if;
  if exists (
    select 1 from public.question_import_runs r
     where r.workspace_id = doc.workspace_id and r.source_document_id = p_document_id
  ) then
    return;
  end if;

  insert into public.async_jobs (id, workspace_id, created_by, job_type, schema_version,
                                 idempotency_key, payload)
  values (new_job, doc.workspace_id, p_user_id, 'question.import', 1,
          'question_import:' || new_run::text || ':1',
          pg_catalog.jsonb_build_object('import_id', new_run::text));

  insert into public.question_import_runs (id, workspace_id, created_by, source_document_id,
                                           source_document_revision_id, async_job_id, status,
                                           started_by)
  values (new_run, doc.workspace_id, p_user_id, p_document_id, p_revision_id, new_job, 'queued',
          'system');

  -- Ids only, like the API's own `question_import.started`.
  insert into public.activity_events (workspace_id, actor_id, event_type, target_type, target_id,
                                      metadata)
  values (doc.workspace_id, p_user_id, 'question_import.started', 'question_import', new_run,
          pg_catalog.jsonb_build_object('started_by', 'system'));

  run_id := new_run;
  job_id := new_job;
  return next;
end;
$$;

comment on function public.worker_start_question_import(uuid, uuid, uuid) is
  'QIMP-AUTO / UX6-UPLOAD-B: start the import of a just-published question paper or book with '
  'questions once (quiz_worker only).';

revoke all on function public.worker_start_question_import(uuid, uuid, uuid)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_start_question_import(uuid, uuid, uuid) to quiz_worker;

create or replace function public.worker_register_import_drafts(p_job_id uuid, p_limit integer)
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
      -- UX6-UPLOAD-B: a chapter whose document is no longer a book (종류 변경 to 문제지 after the
      -- selection) is no registration target: refused as changed since the selection (the
      -- reviewer reloads and sees the new chapter), never filed under a question paper.
      if item.chapter_id is not null and exists (
        select 1
          from public.chapters oc
          join public.documents doc
            on doc.id = oc.document_id and doc.workspace_id = oc.workspace_id
         where oc.id = item.chapter_id and oc.workspace_id = job.workspace_id
           and doc.document_type <> 'book'
      ) then
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
  'QIMP-JOB: approve and register the next pending drafts of a question.import_register job '
  '(quiz_worker only); never under a chapter of a non-book (UX6-UPLOAD-B).';

revoke all on function public.worker_register_import_drafts(uuid, integer)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_register_import_drafts(uuid, integer) to quiz_worker;
