-- M6.2 review fix: snapshot the source question's provenance on the generation run.
--
-- A PARAPHRASE / INVERT_POLARITY draft generated without passages inherits the source question's
-- own evidence (book_core.generation). Re-validating a reviewer's edit against the source's
-- *current* sources would strand such a draft once the source question's sources are edited, so
-- the job stores the evidence it generated with, next to the passages (20261018150000), and the
-- API re-validates against that snapshot.
--
--   question_generation_runs.source_evidence
--     book_core `SourceEvidence[]` of the pinned source revision at generation time. NULL = not
--     snapshotted (runs that finished before this migration: the API falls back to the source
--     question's current sources).
--
-- Additive only: one nullable column, two checks, one column grant for quiz_worker (it writes the
-- snapshot in the transaction that marks the run succeeded).

alter table public.question_generation_runs
  add column source_evidence jsonb,
  add constraint question_generation_runs_source_evidence_array
    check (source_evidence is null or jsonb_typeof(source_evidence) = 'array'),
  add constraint question_generation_runs_source_evidence_size
    check (source_evidence is null or pg_column_size(source_evidence) <= 65536);

grant update (source_evidence) on public.question_generation_runs to quiz_worker;
