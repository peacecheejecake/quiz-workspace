-- CHAPTER-MAP: the chapter an import draft is registered under (QIMPORT-01-AC08, docs/questions.md
-- §6). Until now imported questions were registered without a chapter. The API suggests one by
-- matching the chapter of the question in the question PDF to a book chapter of the workspace
-- (normalised title, quiz_api.chapter_matching); the reviewer may pick another one or none.
--
-- Additive only: two columns with defaults, one foreign key, one index.
--
-- question_drafts
--   chapter_manual  false: the chapter is the API's suggestion, recomputed on every read (a book
--                   uploaded after the import is matched too); true: the reviewer chose
--                   `chapter_id` (null = "챕터 없음").
--   chapter_id      the chosen chapter (only meaningful with chapter_manual). It may point at a
--                   chapter of an older revision of its book: the API and the registration job
--                   resolve it to the same section of the book's current revision (as the
--                   documents_remap_question_chapters trigger does for questions), or to none.
-- quiz_worker inserts drafts with the defaults (its insert policy is unchanged) and never updates
-- them; quiz_api already has UPDATE on question_drafts.

alter table public.question_drafts
  add column chapter_id uuid,
  add column chapter_manual boolean not null default false,
  add constraint question_drafts_chapter_fk foreign key (workspace_id, chapter_id)
    references public.chapters (workspace_id, id) on delete set null (chapter_id),
  add constraint question_drafts_chapter_only_if_manual
    check (chapter_manual or chapter_id is null);

create index question_drafts_chapter_idx
  on public.question_drafts (chapter_id) where chapter_id is not null;
