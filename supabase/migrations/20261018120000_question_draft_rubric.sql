-- M4.4a review fix: a draft's essay model answer / grading criteria.
--
-- A question paper's answer key may print a model answer for an essay question. Essays have no
-- auto-gradable accepted answers (question_rules: accepted_answers are SHORT_ANSWER only), so the
-- import keeps that text as the draft's `rubric` ("모범 답안 / 채점 기준"), which publishing copies
-- to question_revisions.rubric (used by self/reviewer grading, questions.md §4.5). The book_core
-- QuestionDraft payload has no rubric field, hence a column next to it.
--
-- Additive: one nullable column. quiz_worker's table-level INSERT on question_drafts
-- (20261018100000) covers it; the RLS insert policy is unchanged.

alter table public.question_drafts
  add column rubric text,
  add constraint question_drafts_rubric_length
    check (rubric is null or char_length(rubric) <= 20000);
