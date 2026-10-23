// QGEN-01 form model (docs/questions.md §5): variation labels, which variations a source allows
// and the request body of a generation run. Pure and unit-tested.
//
// OPTION_SHUFFLE is not a generation: it never creates a question or a dot. It opens the
// original question's practice panel, whose session stores the shuffled order (M5.2), so it is
// exclusive with the LLM variations in the form.
import type { QuestionType } from './form';
import type {
  GenerationBatch,
  GenerationBatchCreate,
  GenerationCreate,
  GenerationDifficulty,
  GenerationRun,
  LlmVariationType,
  RandomSelection,
  VariationType,
} from './generation-client';

export const VARIATION_ORDER: readonly VariationType[] = [
  'OPTION_SHUFFLE',
  'PARAPHRASE',
  'INVERT_POLARITY',
  'ANALOGOUS_CONCEPT',
];

export const VARIATION_LABELS: Readonly<Record<VariationType, string>> = {
  OPTION_SHUFFLE: '보기 섞기',
  PARAPHRASE: '문구 변형',
  INVERT_POLARITY: '정오 반전',
  ANALOGOUS_CONCEPT: '유사 개념',
};

export const VARIATION_DESCRIPTIONS: Readonly<Record<VariationType, string>> = {
  OPTION_SHUFFLE: '원본 문제를 보기 순서만 바꿔 바로 풉니다. 새 문제를 만들지 않습니다.',
  PARAPHRASE: '개념과 정답은 그대로 두고 문제 문구를 바꾼 초안을 만듭니다.',
  INVERT_POLARITY:
    "'옳지 않은 것'을 '옳은 것'처럼 뒤집습니다. 정답 개수가 달라질 수 있어 검토가 필요합니다.",
  ANALOGOUS_CONCEPT:
    '원본의 출처 쪽과 Workspace 문서에서 찾은 관련 원문을 근거로 비슷한 개념을 묻는 새 초안을 만듭니다.',
};

export const DIFFICULTY_LABELS: Readonly<Record<GenerationDifficulty, string>> = {
  easier: '더 쉽게',
  same: '비슷하게',
  harder: '더 어렵게',
};

export const CANDIDATE_COUNT_MIN = 1;
export const CANDIDATE_COUNT_MAX = 20;

export interface GenerationSourceFacts {
  readonly questionType: QuestionType;
  readonly confirmed: boolean;
}

/** Why `type` cannot be chosen for this source (null = it can). */
export function variationBlocker(
  type: VariationType,
  source: GenerationSourceFacts,
): string | null {
  if (!source.confirmed) return '확정된 문제만 변형할 수 있습니다.';
  if (type === 'OPTION_SHUFFLE' && source.questionType !== 'MCQ') {
    return '보기 섞기는 객관식 문제에만 쓸 수 있습니다.';
  }
  return null;
}

/**
 * Toggles `type` in the selection. Shuffling excludes the LLM variations (and vice versa): it
 * opens a practice session instead of starting a run.
 */
export function toggleVariation(
  selected: readonly VariationType[],
  type: VariationType,
  on: boolean,
): VariationType[] {
  if (!on) return selected.filter((t) => t !== type);
  if (type === 'OPTION_SHUFFLE') return ['OPTION_SHUFFLE'];
  const next = selected.filter((t) => t !== 'OPTION_SHUFFLE' && t !== type);
  return VARIATION_ORDER.filter((t) => t === type || next.includes(t));
}

export function parseCandidateCount(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= CANDIDATE_COUNT_MIN && n <= CANDIDATE_COUNT_MAX ? n : null;
}

export type GenerationRequest =
  | { readonly kind: 'shuffle' }
  | { readonly kind: 'generate'; readonly body: GenerationCreate }
  | { readonly kind: 'invalid'; readonly field: 'variations' | 'count'; readonly message: string };

/** What "생성" does with the form's values. */
export function generationRequest(
  selected: readonly VariationType[],
  countText: string,
  difficulty: GenerationDifficulty | null,
): GenerationRequest {
  if (selected.length === 0) {
    return {
      kind: 'invalid',
      field: 'variations',
      message: '변형 유형을 하나 이상 선택해 주세요.',
    };
  }
  if (selected.includes('OPTION_SHUFFLE')) return { kind: 'shuffle' };
  const count = parseCandidateCount(countText);
  if (count === null) {
    return {
      kind: 'invalid',
      field: 'count',
      message: `후보 수는 ${CANDIDATE_COUNT_MIN}~${CANDIDATE_COUNT_MAX} 사이의 숫자로 입력해 주세요.`,
    };
  }
  const variationTypes = VARIATION_ORDER.filter(
    (t): t is LlmVariationType => t !== 'OPTION_SHUFFLE' && selected.includes(t),
  );
  return {
    kind: 'generate',
    body: {
      variation_types: variationTypes,
      candidate_count: count,
      ...(difficulty ? { difficulty } : {}),
    },
  };
}

/** Stable JSON of a request body: a retry with the same body reuses its Idempotency-Key. */
export function bodyKey(body: GenerationCreate): string {
  return JSON.stringify([body.variation_types, body.candidate_count, body.difficulty ?? null]);
}

// ---------------------------------------------------------------------------------------------
// Run history (earlier runs stay reachable: their unregistered drafts are not lost)
// ---------------------------------------------------------------------------------------------

/** How many runs of a source the screen offers in its history. */
export const RUN_HISTORY_LIMIT = 20;

export const RUN_STATUS_LABELS: Readonly<Record<GenerationRun['status'], string>> = {
  queued: '대기 중',
  running: '생성 중',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

/** Drafts of the run that are not registered yet (pending, approved or rejected). */
export function unregisteredCount(run: Pick<GenerationRun, 'draft_count' | 'published_count'>) {
  return Math.max(0, run.draft_count - run.published_count);
}

/** Inserts or replaces `run`, newest first. */
export function upsertRun(runs: readonly GenerationRun[], run: GenerationRun): GenerationRun[] {
  const rest = runs.filter((r) => r.id !== run.id);
  return [run, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** One line per run in the history picker: when, what, how it ended, what is left to review. */
export function runLabel(run: GenerationRun, formatTime: (iso: string) => string): string {
  const types = run.variation_types.map((t) => VARIATION_LABELS[t]).join('·');
  const left = unregisteredCount(run);
  const tail =
    run.status === 'succeeded' ? (left > 0 ? ` · 미등록 초안 ${left}개` : ' · 모두 등록') : '';
  return `${formatTime(run.created_at)} · ${types} · ${RUN_STATUS_LABELS[run.status]}${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Batches (QGEN-MULTI, docs/questions.md §5 "묶음 변형 출제"): several selected or randomly
// picked sources, one run each; review and registration stay per run.
// ---------------------------------------------------------------------------------------------

/** Most sources one batch may have (the API refuses more). */
export const MAX_BATCH_SOURCES = 20;
/** Sources × variation types × candidates per batch (the API's cost guard). */
export const MAX_BATCH_CANDIDATES = 60;

export type StudyStatus = NonNullable<RandomSelection['statuses']>[number];

export const STUDY_STATUS_ORDER: readonly StudyStatus[] = [
  'unseen',
  'viewed',
  'incorrect',
  'correct',
  'retry',
];

export const STUDY_STATUS_LABELS: Readonly<Record<StudyStatus, string>> = {
  unseen: '안 푼 문제',
  viewed: '본 문제',
  incorrect: '틀린 문제',
  correct: '맞힌 문제',
  retry: '다시 풀기',
};

/** Adds or removes `id`, keeping the selection order; never more than MAX_BATCH_SOURCES. */
export function toggleSource(selected: readonly string[], id: string, on: boolean): string[] {
  const rest = selected.filter((s) => s !== id);
  if (!on) return rest;
  return rest.length >= MAX_BATCH_SOURCES ? [...selected] : [...rest, id];
}

/** Why the batch would exceed the cost guard (null = it does not). */
export function batchCostProblem(sources: number, body: GenerationCreate): string | null {
  const total = sources * body.variation_types.length * (body.candidate_count ?? 1);
  if (total <= MAX_BATCH_CANDIDATES) return null;
  return `한 번에 만들 수 있는 후보는 ${MAX_BATCH_CANDIDATES}개까지입니다(원본 ${sources}개 × 변형 유형 ${body.variation_types.length}개 × 후보 ${body.candidate_count ?? 1}개 = ${total}개). 원본이나 후보 수를 줄여 주세요.`;
}

export interface RandomPickFilters {
  readonly count: string;
  readonly chapter: string | null;
  readonly questionType: QuestionType | null;
  readonly statuses: readonly StudyStatus[];
  readonly favoriteOnly: boolean;
}

export const DEFAULT_RANDOM_FILTERS: RandomPickFilters = {
  count: '5',
  chapter: null,
  questionType: null,
  statuses: [],
  favoriteOnly: false,
};

export function parseSourceCount(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_BATCH_SOURCES ? n : null;
}

/** The random selection of a batch request (null: the count is not a number in range). */
export function randomSelection(filters: RandomPickFilters): RandomSelection | null {
  const count = parseSourceCount(filters.count);
  if (count === null) return null;
  return {
    mode: 'random',
    count,
    ...(filters.chapter ? { chapter: filters.chapter } : {}),
    ...(filters.questionType ? { question_type: filters.questionType } : {}),
    ...(filters.statuses.length > 0
      ? { statuses: STUDY_STATUS_ORDER.filter((s) => filters.statuses.includes(s)) }
      : {}),
    ...(filters.favoriteOnly ? { favorite: true } : {}),
  };
}

/** Stable JSON of a batch request: a retry with the same body reuses its Idempotency-Key. */
export function batchKey(body: GenerationBatchCreate): string {
  return JSON.stringify(body);
}

/** Whole-batch progress in percent: finished sources out of all (running jobs count as 0). */
export function batchProgress(
  batch: Pick<GenerationBatch, 'run_count' | 'finished_run_count'>,
): number {
  if (batch.run_count === 0) return 100;
  return Math.round((batch.finished_run_count / batch.run_count) * 100);
}

/** One source group's state line on the batch page. */
export function batchItemStatus(run: GenerationRun): string {
  switch (run.status) {
    case 'queued':
      return '대기 중';
    case 'running':
      return '생성 중';
    case 'succeeded':
      return run.published_count > 0
        ? `초안 ${run.draft_count}개 · 등록 ${run.published_count}개`
        : `초안 ${run.draft_count}개`;
    default:
      return RUN_STATUS_LABELS[run.status];
  }
}
