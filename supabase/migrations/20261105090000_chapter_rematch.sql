-- CHAP-MATCH: re-match the chapters the matcher left empty once a book becomes ready
-- (docs/questions.md §14.4). The worker reads candidates and decides the matches
-- (book_core.chapter_matching); this function is its only write path into `questions`.
--
-- worker_rematch_chapters(p_workspace_id, p_moves jsonb) -> integer (moves applied)
--   p_moves: [{"question_id", "expected_chapter_id" (nullable), "chapter_id"}, ...]
-- Rules, all rechecked under lock inside the call (a move that fails any is skipped, never an
-- error, so a batch is idempotent and a redelivery moves nothing twice):
--   * the workspace is active and not deleted;
--   * documents of the old and new chapters FOR SHARE (id order), then the questions FOR UPDATE
--     (id order): the question lock order (documents before questions);
--   * the question is live, CONFIRMED, chapter_source = 'auto' (a chapter a person set or
--     changed is `manual` and never touched) and its chapter still equals expected_chapter_id;
--   * the old chapter is none or a chapter of a non-book document (the paper fallback);
--   * the new chapter belongs to this workspace, to a live document's active revision, and is a
--     book chapter or a level-1 chapter of a question paper. A paper chapter only replaces none.
-- Effects: chapter_id, chapter_source stays 'auto', chapter_set_at = now(), chapter_set_by =
-- null (system), one question_chapter_changes row (source 'recommendation', changed_by null).
-- quiz_worker only; no table privilege is added.

create function public.worker_rematch_chapters(p_workspace_id uuid, p_moves jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_move record;
  v_moved integer := 0;
  v_ok boolean;
begin
  if p_workspace_id is null or p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    return 0;
  end if;
  perform 1 from public.workspaces w
   where w.id = p_workspace_id and w.status = 'active' and w.deleted_at is null
     for share;
  if not found then
    return 0;
  end if;

  -- Documents first, in id order.
  perform d.id
      from public.documents d
     where d.workspace_id = p_workspace_id
       and d.id in (
         select c.document_id
           from public.chapters c
           join jsonb_to_recordset(p_moves)
                  as m (question_id uuid, expected_chapter_id uuid, chapter_id uuid)
             on c.id in (m.chapter_id, m.expected_chapter_id)
          where c.workspace_id = p_workspace_id
       )
     order by d.id
       for share;

  for v_move in
    select r.question_id, r.expected_chapter_id as expected, r.chapter_id as target
      from (
        select distinct on (m.question_id) m.question_id, m.expected_chapter_id, m.chapter_id
          from jsonb_to_recordset(p_moves)
                 as m (question_id uuid, expected_chapter_id uuid, chapter_id uuid)
         where m.chapter_id is not null
         order by m.question_id
      ) r
      join public.questions q on q.id = r.question_id and q.workspace_id = p_workspace_id
     order by q.id
       for update of q
  loop
    select true into v_ok
      from public.questions q
     where q.id = v_move.question_id
       and q.workspace_id = p_workspace_id
       and q.deleted_at is null
       and q.publication_status = 'CONFIRMED'
       and q.chapter_source = 'auto'
       and q.chapter_id is not distinct from v_move.expected
       and (
         q.chapter_id is null
         or exists (
           select 1 from public.chapters oc
             join public.documents od
               on od.id = oc.document_id and od.workspace_id = oc.workspace_id
            where oc.id = q.chapter_id and oc.workspace_id = p_workspace_id
              and od.document_type <> 'book'
         )
       )
       and exists (
         select 1 from public.chapters nc
           join public.documents nd
             on nd.id = nc.document_id and nd.workspace_id = nc.workspace_id
          where nc.id = v_move.target and nc.workspace_id = p_workspace_id
            and nd.deleted_at is null
            and nd.active_revision_id = nc.document_revision_id
            and (nd.document_type = 'book'
                 or (nc.level = 1 and q.chapter_id is null))
       );
    if v_ok is not true then
      v_ok := null;
      continue;
    end if;
    v_ok := null;
    update public.questions
       set chapter_id = v_move.target,
           chapter_source = 'auto',
           chapter_set_by = null,
           chapter_set_at = pg_catalog.now()
     where id = v_move.question_id and workspace_id = p_workspace_id;
    insert into public.question_chapter_changes (workspace_id, question_id, from_chapter_id,
                                                 to_chapter_id, source, changed_by)
    values (p_workspace_id, v_move.question_id, v_move.expected, v_move.target,
            'recommendation', null);
    v_moved := v_moved + 1;
  end loop;
  return v_moved;
end;
$$;

comment on function public.worker_rematch_chapters(uuid, jsonb) is
  'CHAP-MATCH (quiz_worker only): apply (question, expected chapter, new chapter) moves to auto questions with no chapter or a question-paper fallback chapter; rechecked under lock, idempotent, never touches manual chapters.';

revoke all on function public.worker_rematch_chapters(uuid, jsonb)
  from public, anon, authenticated, quiz_api;
grant execute on function public.worker_rematch_chapters(uuid, jsonb) to quiz_worker;
