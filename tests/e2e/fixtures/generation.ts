// Question variant generation (QGEN-01) fixtures: scenario-driven source questions, generation
// run API helpers and the QGEN-01 UI label contract. M6.0 keeps every assumption about M6.1/M6.2/
// M6.3 in this header (mirrored by tests/integration/questions/test_generation_api_contract.py);
// a deliberate change is a one-place edit here.
//
// Grounded in the docs: routes POST /questions/{id}/generations, GET /question-generations/{id}/
// drafts, POST /question-generations/{id}/publish (architecture §6); variation types and workflow
// (questions.md §5: OPTION_SHUFFLE never creates a question or a dot; PARAPHRASE / INVERT_POLARITY /
// ANALOGOUS_CONCEPT produce isolated DRAFTs with diff + justification + source links that a human
// approves; the LLM's declared answer is never trusted); `question_generation_runs`,
// `question_drafts` (origin `generation`) and `question_lineage` (supabase/migrations/
// 20261017180000_question_domain.sql: 1-3 draft variation types per run, candidate_count 1-20);
// book_core `QuestionDraft` (variation_type, parent_question_id, source_question_revision_id,
// generator, evidence, validations).
//
// NOT in the docs (M6.0 assumptions, to confirm or change in M6.1/M6.2/M6.3):
//   G1 Fake LLM (APP_ENV=test only, implementation-plan §7 fault-injection decision): the worker
//      builds `book_core.llm.scenarios.ScenarioLLMClient.from_file(tests/fixtures/llm/
//      generation-scenarios.json)` instead of the real provider. It answers from the scenario whose
//      marker occurs in the prompt; tests put the marker at the end of the SOURCE question's stem
//      (` [E2E-LLM-OK]`), so the worker's prompt must contain the source stem. Scenarios:
//        E2E-LLM-OK            schema-valid PARAPHRASE + ANALOGOUS_CONCEPT candidates (source
//                              `disinfection`)
//        E2E-LLM-INVERT-MULTI  INVERT_POLARITY that keeps the 4 options of a '옳지 않은 것' MCQ:
//                              3 statements become correct while the model declares 1 (source
//                              `not-correct`)
//        E2E-LLM-MALFORMED     non-JSON output        } every task; the run fails with
//        E2E-LLM-SCHEMA-INVALID JSON of another shape } `llm_output_invalid` and no draft
//      An unscripted task/marker raises (never a silent default).
//   G2 LLM task names: `questions.generate.paraphrase`, `.invert_polarity`, `.analogous_concept`.
//   G3 LLM output: {candidates: [{question_type, stem, options: [{id, text}], correct_option_ids,
//      is_multi_answer, explanation, justification, evidence: [{quote}]}]}. Evidence quotes are
//      verbatim excerpts of the passages given to the model; the worker maps each quote to the
//      block (block id + page) it occurs in, and a quote found in no passage is a validation
//      error (source coverage). Passages = the published blocks of the source question's
//      `sources` pages (book-ko p.4 in every scenario; more may be added by search).
//   G4 Run API
//      POST /questions/{id}/generations {variation_types: VariationType[1..3], candidate_count?:
//           1..20 (default 1)} (+ optional `Idempotency-Key`: same key → same run) → 202 Run.
//           The source must be a CONFIRMED question; OPTION_SHUFFLE is not a generation → 422 and
//           no run (shuffling is a practice-session concern: POST /questions/{id}/practice-sessions
//           already stores the displayed order, M5.2). Viewer → 403 insufficient-role, archived →
//           403 workspace-archived, another user's / unknown question → 404 (same body).
//      GET  /question-generations/{id} → 200 Run;  GET /workspaces/{id}/question-generations →
//           200 {items: Run[]} newest first (the generate screen lists runs like the import screen)
//      Run = {id, workspace_id, status: queued|running|succeeded|failed|cancelled, job_id,
//             source_question_id, source_question_revision_id, variation_types, candidate_count,
//             error_code (failed: e.g. `llm_output_invalid`), draft_count, published_count,
//             llm_model, prompt_version, created_at, finished_at}; job_type `question.generate`.
//      GET  /question-generations/{id}/drafts → 200 {items: GenerationDraft[]} by position
//      GenerationDraft = the import Draft (A4: id, position, question_type, review_status,
//             published_question_id, validations [{code, severity: warning|error, message,
//             field}], publishable, publish_errors, version, payload: QuestionDraft) + {run_id,
//             variation_type}; payload.origin `generation`, payload.parent_question_id,
//             payload.source_question_revision_id, payload.justification, payload.generator
//             {model, prompt_version}, payload.evidence [{document_id, revision_id, block_ids,
//             locations: [{page}], quote}]. The ORIGINAL to diff against is the run's source
//             revision (GET /questions/{source_question_id}); the UI computes the diff.
//      Review and register exactly like imports (A4): PATCH /question-drafts/{id} {base_version,
//           review_status?, ...edits} (a draft with an `error` validation cannot be approved →
//           422; an edit recomputes validations), then POST /question-generations/{id}/publish
//           {drafts: [{draft_id, version}]} → 200 {items: [{draft_id, question_id}]}; pending/
//           rejected → 409 draft-not-approved, nothing registered; idempotent per draft.
//   G5 INVERT_POLARITY validation: when the candidate reuses the source options, the inverted
//      answer set is the complement of the source's correct option ids. If that set does not
//      match the draft's answer / answer mode (here 3 answers on a single-answer MCQ), the draft
//      carries an `error` validation (UI: "복수 정답" warning) and is not publishable until the
//      reviewer resolves it, e.g. by switching to multi-answer with the 3 ids explicitly
//      (PATCH {is_multi_answer: true, correct_option_ids}).
//   G6 Question += lineage: {parent_question_id, source_question_revision_id, variation_type,
//      generation_run_id} | null (GET /questions/{id}); a registered variant is CONFIRMED with
//      origin `generation` and `sources` built from the draft evidence ({document_id, page_start,
//      page_end}); it gets its own dot (overview total + 1) and its own study state.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   QGEN-01  route /workspaces/{id}/questions/generate; `?source=<question id>` preselects the
//            source question (deep link from the bank/practice panel). h1 "문제 변형 출제"; region
//            "원본 문제" showing the source stem; group "변형 유형" with one radio or checkbox per
//            type: "보기 섞기" (OPTION_SHUFFLE), "문구 변형" (PARAPHRASE), "정오 반전"
//            (INVERT_POLARITY), "유사 개념" (ANALOGOUS_CONCEPT); button "생성". 보기 섞기 opens the
//            source question's practice panel (QPLAY-01 dialog) in a shuffled order instead of a
//            run. While a run works: progressbar "생성". Drafts: list "생성된 초안", one listitem
//            per draft (QuestionGenerationForm/VariationDiffViewer in a ≥600px drawer is M6.3's
//            choice) showing the diff against the original with <ins>/<del> (roles insertion/
//            deletion), the justification, evidence links (pageLabel) into the document viewer,
//            the validation state as text ("검증 통과" or the warning, e.g. "복수 정답"), checkbox
//            "승인" (disabled while an error validation remains), "편집"; button "승인한 문제 등록"
//            publishes; a registered draft says "등록됨". A failed run shows role=alert.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { JOB_TIMEOUT_MS } from './documents.ts';
import { REPO_ROOT } from './local-env.ts';
import type { Draft, Question, QuestionInput, QuestionOption } from './questions.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

const SCENARIO_FILE = join(REPO_ROOT, 'tests/fixtures/llm/generation-scenarios.json');

export type VariationType =
  'OPTION_SHUFFLE' | 'PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT';
export type SourceName = 'disinfection' | 'not-correct' | 'malformed' | 'schema-invalid';

interface ScenarioSource {
  readonly marker: string;
  readonly question_type: 'MCQ';
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly correct_option_ids: readonly string[];
  readonly is_multi_answer: boolean;
  readonly explanation: string | null;
  readonly source_page: number;
}

interface ScenarioCandidate {
  readonly stem: string;
  readonly options: readonly QuestionOption[];
  readonly correct_option_ids: readonly string[] | null;
  readonly justification: string;
  readonly evidence: readonly { readonly quote: string }[];
}

interface ScenarioFile {
  readonly scenarios: readonly {
    readonly marker: string;
    readonly responses: Readonly<Record<string, { candidates: ScenarioCandidate[] } | string>>;
  }[];
  readonly sources: Readonly<Record<SourceName, ScenarioSource>>;
}

function scenarioFile(): ScenarioFile {
  return JSON.parse(readFileSync(SCENARIO_FILE, 'utf8')) as ScenarioFile;
}

export function scenarioSource(name: SourceName): ScenarioSource {
  return scenarioFile().sources[name];
}

/** The single candidate the fake LLM returns for `marker` + `task` (G1/G2). */
export function scenarioCandidate(marker: string, task: string): ScenarioCandidate {
  const scenario = scenarioFile().scenarios.find((s) => s.marker === marker);
  const response = scenario?.responses[task];
  if (!response || typeof response === 'string') throw new Error(`no ${marker} output for ${task}`);
  const [candidate] = response.candidates;
  if (!candidate) throw new Error(`empty ${marker} output for ${task}`);
  return candidate;
}

export const GENERATE_TASK: Readonly<Record<Exclude<VariationType, 'OPTION_SHUFFLE'>, string>> = {
  PARAPHRASE: 'questions.generate.paraphrase',
  INVERT_POLARITY: 'questions.generate.invert_polarity',
  ANALOGOUS_CONCEPT: 'questions.generate.analogous_concept',
};

/**
 * Source question input for scenario `name`: the stem ends with ` [<marker>]` (G1) and cites
 * page `source_page` of `documentId`; numbered `n` for the heatmap/practice label (A9).
 */
export function generationSourceInput(name: SourceName, documentId: string, n = 1): QuestionInput {
  const s = scenarioSource(name);
  return {
    question_type: s.question_type,
    stem: `${s.stem} [${s.marker}]`,
    options: s.options,
    correct_option_ids: s.correct_option_ids,
    is_multi_answer: s.is_multi_answer,
    explanation: s.explanation,
    question_number: n,
    sources: [{ document_id: documentId, page_start: s.source_page, page_end: s.source_page }],
  };
}

// ---------------------------------------------------------------------------------------------
// API (G4–G6)
// ---------------------------------------------------------------------------------------------

export interface GenerationRun {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly job_id: string;
  readonly source_question_id: string;
  readonly source_question_revision_id: string;
  readonly variation_types: readonly VariationType[];
  readonly error_code?: string | null;
}

export interface GenerationDraft extends Draft {
  readonly variation_type: VariationType;
  readonly publishable: boolean;
  readonly payload: Draft['payload'] & {
    readonly origin: string;
    readonly variation_type: VariationType;
    readonly parent_question_id: string;
    readonly source_question_revision_id: string;
    readonly justification: string | null;
  };
}

export interface QuestionLineage {
  readonly parent_question_id: string;
  readonly source_question_revision_id: string;
  readonly variation_type: VariationType;
  readonly generation_run_id: string;
}

export type GeneratedQuestion = Question & { readonly lineage: QuestionLineage | null };

export async function startGeneration(
  owner: Member,
  questionId: string,
  variationTypes: readonly VariationType[],
): Promise<GenerationRun> {
  return owner.api.ok<GenerationRun>(
    'POST',
    `/questions/${questionId}/generations`,
    { variation_types: variationTypes },
    [202],
  );
}

export async function listGenerations(
  member: Member,
  workspaceId: string,
): Promise<GenerationRun[]> {
  const body = await member.api.ok<{ items: GenerationRun[] }>(
    'GET',
    `/workspaces/${workspaceId}/question-generations`,
    undefined,
    [200],
  );
  return body.items;
}

export async function getGeneration(member: Member, runId: string): Promise<GenerationRun> {
  return member.api.ok<GenerationRun>('GET', `/question-generations/${runId}`, undefined, [200]);
}

export async function listGenerationDrafts(
  member: Member,
  runId: string,
): Promise<GenerationDraft[]> {
  const body = await member.api.ok<{ items: GenerationDraft[] }>(
    'GET',
    `/question-generations/${runId}/drafts`,
    undefined,
    [200],
  );
  return [...body.items].sort((a, b) => a.position - b.position);
}

/** Polls (no sleeps) until the newest run of the workspace is terminal; returns it. */
export async function waitForLatestGeneration(
  member: Member,
  workspaceId: string,
): Promise<GenerationRun> {
  let run: GenerationRun | undefined;
  await expect
    .poll(
      async () => {
        run = (await listGenerations(member, workspaceId))[0];
        return run ? ['succeeded', 'failed', 'cancelled'].includes(run.status) : false;
      },
      { message: 'a generation run finishes', timeout: JOB_TIMEOUT_MS },
    )
    .toBe(true);
  if (!run) throw new Error('no generation run');
  return run;
}

export async function getGeneratedQuestion(
  member: Member,
  questionId: string,
): Promise<GeneratedQuestion> {
  return member.api.ok<GeneratedQuestion>('GET', `/questions/${questionId}`, undefined, [200]);
}

// ---------------------------------------------------------------------------------------------
// UI (QGEN-01)
// ---------------------------------------------------------------------------------------------

export function generatePath(workspaceId: string, sourceQuestionId?: string): string {
  const base = `/workspaces/${workspaceId}/questions/generate`;
  return sourceQuestionId ? `${base}?source=${sourceQuestionId}` : base;
}

const VARIATION_NAME: Readonly<Record<VariationType, RegExp>> = {
  OPTION_SHUFFLE: /보기 (섞기|순서 섞기)|선택지 섞기|shuffle/i,
  PARAPHRASE: /문구 변형|표현 바꾸기|paraphrase/i,
  INVERT_POLARITY: /정오 반전|긍정.?부정 반전|invert/i,
  ANALOGOUS_CONCEPT: /유사 개념|analogous/i,
};

export const generateUi = {
  heading: (page: Page) => page.getByRole('heading', { level: 1 }),
  source: (page: Page) =>
    main(page).getByRole('region', { name: /^(원본 문제|원본|source question)/i }),
  variation: (page: Page, type: VariationType) => {
    const group = main(page).getByRole('group', { name: /변형 (유형|방식)|variation/i });
    const name = VARIATION_NAME[type];
    return group.getByRole('checkbox', { name }).or(group.getByRole('radio', { name }));
  },
  generate: (page: Page) =>
    main(page).getByRole('button', { name: /^(변형 )?(생성|만들기)|^generate/i }),
  drafts: (page: Page) =>
    main(page).getByRole('list', {
      name: /생성된 (초안|문제)|변형 초안|generated (drafts|questions)/i,
    }),
  draftItems: (page: Page) => generateUi.drafts(page).getByRole('listitem'),
  insertions: (draft: Locator) => draft.getByRole('insertion'),
  deletions: (draft: Locator) => draft.getByRole('deletion'),
  evidence: (draft: Locator, page: RegExp) => draft.getByRole('link', { name: page }),
  validationOk: (draft: Locator) =>
    draft.getByText(/검증 통과|검증 완료|validation passed|checks passed/i),
  multipleAnswers: (draft: Locator) =>
    draft.getByText(
      /복수 정답|정답이 (여러|둘 이상|2개 이상)|정답 개수|multiple correct answers?/i,
    ),
  approve: (draft: Locator) => draft.getByRole('checkbox', { name: /승인|approve/i }),
  published: (draft: Locator) => draft.getByText(/등록됨|등록 완료|registered|published/i),
  publish: (page: Page) =>
    main(page).getByRole('button', {
      name: /(승인|선택)한? (초안|문제|항목)?\s*등록|publish|register approved/i,
    }),
  alert: (page: Page) => main(page).getByRole('alert').first(),
};
