-- M3.4 document corrections: question chapter links follow the document's active revision.
--
-- Sources: docs/architecture.md §4 (a text correction creates a new revision; the previous
-- published revision stays until the new one is indexed and published), docs/screens/
-- documents-editor.md (DOC-02-AC02/AC03), apps/api/src/quiz_api/api/questions.py (M4.2a decision:
-- on publish, `questions.chapter_id` moves to the new revision's chapter with the same
-- `(document_id, section_key)`, or to null when the section no longer exists; question_sources
-- keep pointing at the revision they were saved against).
--
-- documents_remap_question_chapters: AFTER UPDATE OF active_revision_id on documents. Whatever
-- switches the active revision (the worker's publish transaction today, any later rollback
-- path), the questions linked to a chapter of another revision of that document are moved, in
-- the same transaction, to the chapter with the same section_key in the new active revision, or
-- set to null when it has none. quiz_worker has (and keeps) no privilege on questions: the
-- function is SECURITY DEFINER with an empty search_path and touches only questions.chapter_id
-- of questions that point at chapters of this document. EXECUTE is revoked from everyone; a
-- trigger function needs no EXECUTE grant to fire.
--
-- Lock order: the switching transaction already holds the document row (FOR UPDATE in the
-- worker's publish), then updates question rows. The API's question save reads the chapter's
-- document FOR SHARE before writing the question (QuestionRepository.chapter_is_current), so a
-- question saved concurrently with a publish either commits first (and is remapped here) or
-- waits and then sees the new active revision (and is rejected as stale).

create function public.documents_remap_question_chapters()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.questions q
     set chapter_id = (
           select nc.id
             from public.chapters oc
             join public.chapters nc
               on nc.document_revision_id = new.active_revision_id
              and nc.section_key = oc.section_key
            where oc.id = q.chapter_id
         )
   where q.workspace_id = new.workspace_id
     and q.chapter_id in (
           select c.id
             from public.document_revisions r
             join public.chapters c on c.document_revision_id = r.id
            where r.workspace_id = new.workspace_id
              and r.document_id = new.id
              and r.id <> new.active_revision_id
         );
  return null;
end;
$$;

comment on function public.documents_remap_question_chapters() is
  'Trigger: move questions.chapter_id to the same section of the document''s new active revision (or null).';

revoke all on function public.documents_remap_question_chapters()
  from public, anon, authenticated, quiz_api, quiz_worker;

create trigger documents_remap_question_chapters
  after update of active_revision_id on public.documents
  for each row
  when (new.active_revision_id is not null
        and old.active_revision_id is distinct from new.active_revision_id)
  execute function public.documents_remap_question_chapters();
