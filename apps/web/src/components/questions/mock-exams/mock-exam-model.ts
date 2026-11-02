// MOCK-01 모의고사 display model (docs/screens/mock-exams.md, questions.md §11): labels, the list
// meta line, the generation progress and failure texts, the 문항 수 limits and how a saved range
// (the person's intent: `전체 선택`, chapters, single questions, exclusions, filters) is shown
// again in the QuestionRangePicker. Pure, so it is unit-tested; FastAPI decides every limit.
import type { Schemas } from '@quiz/api-client';
import type { QuestionDotStatus } from '@quiz/ui';
import type { RangeFilterState, RangeGroup } from '../viewer/range-model';
import { EMPTY_RANGE_FILTERS } from '../viewer/range-model';
import { displayStem } from '@/lib/questions/display-stem';
import { formatDateTime } from '../labels';

export type MockExam = Schemas['MockExam'];
export type MockExamList = Schemas['MockExamList'];
export type MockExamConfig = Schemas['MockExamConfig'];
export type MockExamGeneration = Schemas['MockExamGeneration'];
export type MockExamQuestion = Schemas['MockExamQuestion'];
export type MockExamStatus = MockExam['status'];
export type MockRange = Schemas['QuestionRange'];
export type VariationType = MockExamConfig['variation_types'][number];
export type Difficulty = NonNullable<MockExamConfig['difficulty']>;

/** 문항 수 with an AI variation type (user decision 2026-11-01). */
export const MAX_AI_QUESTIONS = 100;
export const DEFAULT_QUESTION_COUNT = 20;
/** A mock exam (보기 섞기 only, 범위 전체) holds at most this many questions (MOCK-01-C06). */
export const MAX_RANGE_QUESTIONS = 5_000;
export const TITLE_MAX = 100;
/** Characters of the stem a question row shows ("발문 앞 40자"). */
export const ROW_STEM_CHARS = 40;

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
  OPTION_SHUFFLE: '원본 문제를 그대로 옮기고 보기 순서만 섞습니다. AI를 쓰지 않습니다.',
  PARAPHRASE: '개념과 정답은 그대로 두고 문제 문구를 바꿉니다.',
  INVERT_POLARITY: "'옳지 않은 것'을 묻는 문제를 '옳은 것'을 묻도록 뒤집습니다(또는 그 반대).",
  ANALOGOUS_CONCEPT: '원본의 관련 본문을 근거로 비슷한 개념을 묻는 문제를 만듭니다.',
};

export const AI_DISABLED_TEXT = '이 환경에서는 AI 변형을 쓸 수 없습니다.';
export const AI_NOTICE_TEXT =
  '고른 문제의 발문·보기·정답·해설과 관련 본문이 AI 서비스로 전송됩니다.';
export const NO_RANGE_TEXT = '출제 범위를 고르세요';
export const WORKING_TEXT = '문제를 만드는 중입니다. 창을 닫아도 계속 만듭니다.';
export const NOT_FOUND_TEXT = '모의고사를 찾을 수 없습니다.';
export const FAILED_TITLE = '모의고사를 만들지 못했습니다';
export const EMPTY_TEXT = '아직 모의고사가 없습니다.';
export const EMPTY_HINT = '`추가`로 변형 유형과 범위를 골라 모의고사를 만드세요.';

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  easy: '쉬움',
  medium: '보통',
  hard: '어려움',
};
export const SAME_DIFFICULTY_LABEL = '원본과 같게';

export const STATUS_LABELS: Readonly<Record<MockExamStatus, string>> = {
  generating: '만드는 중',
  ready: '준비됨',
  partial: '일부만 만듦',
  failed: '실패',
};

export type StatusTone = 'accent' | 'success' | 'warning' | 'danger';

export const STATUS_TONES: Readonly<Record<MockExamStatus, StatusTone>> = {
  generating: 'accent',
  ready: 'success',
  partial: 'warning',
  failed: 'danger',
};

export function isAiType(type: VariationType): boolean {
  return type !== 'OPTION_SHUFFLE';
}

export function usesAi(types: readonly VariationType[]): boolean {
  return types.some(isAiType);
}

/** The chosen types in display order ("문구 변형, 정오 반전"). */
export function variationText(types: readonly VariationType[]): string {
  return VARIATION_ORDER.filter((t) => types.includes(t))
    .map((t) => VARIATION_LABELS[t])
    .join(', ');
}

/** The list row's meta line: "문제 18개 · 문구 변형, 정오 반전 · 2026. 11. 1. 오후 3:28". */
export function metaText(exam: Pick<MockExam, 'question_count_current' | 'config' | 'created_at'>) {
  return [
    `문제 ${exam.question_count_current}개`,
    variationText(exam.config.variation_types),
    formatDateTime(exam.created_at),
  ].join(' · ');
}

/** "2회차": the round whose questions are shown (null before the first one finished). */
export function roundText(exam: Pick<MockExam, 'current_generation'>): string | null {
  return exam.current_generation ? `${exam.current_generation.version}회차` : null;
}

/** How often a list or detail with a mock exam being made reads it again (ms). */
export const MOCK_POLL_MS = 1500;

/** Whether a mock exam has questions to practise now (a remake keeps the previous ones). */
export function canPractise(
  exam: Pick<MockExam, 'current_generation' | 'question_count_current'>,
): boolean {
  return exam.current_generation !== null && exam.question_count_current > 0;
}

/** Whether the newest round is still being made. */
export function isGenerating(exam: Pick<MockExam, 'latest_generation'>): boolean {
  const status = exam.latest_generation?.status;
  return status === 'queued' || status === 'running';
}

/** The running round's progress as {done, total} ("20개 중 7개"). */
export function generationProgress(generation: MockExamGeneration | null | undefined): {
  done: number;
  total: number;
} {
  const total = generation?.progress?.total ?? generation?.requested_count ?? 0;
  const done = Math.min(total, generation?.progress?.done ?? 0);
  return { done, total };
}

export function progressValueText(progress: { done: number; total: number }): string {
  return `${progress.total}개 중 ${progress.done}개`;
}

export function progressPercent(progress: { done: number; total: number }): number | undefined {
  return progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : undefined;
}

/** The failure reason of a failed round (docs/screens/mock-exams.md "실패"). */
export function failureText(errorCode: string | null | undefined): string {
  switch (errorCode) {
    case 'llm_unavailable':
    case 'llm_timeout':
      return 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
    case 'no_valid_questions':
      return '검증을 통과한 문제를 만들지 못했습니다. 범위나 변형 유형을 바꿔 보세요.';
    case 'no-matching-questions':
    case 'no_matching_questions':
      return '범위에 맞는 확정 문제가 없습니다.';
    default:
      return '모의고사를 만들지 못했습니다. 다시 시도하세요.';
  }
}

/** "20문항 중 17문항을 만들었습니다. 3개는 검증을 통과하지 못했습니다." */
export function partialText(
  generation: Pick<MockExamGeneration, 'requested_count' | 'created_count'>,
) {
  const skipped = Math.max(0, generation.requested_count - generation.created_count);
  return (
    `${generation.requested_count}문항 중 ${generation.created_count}문항을 만들었습니다. ` +
    `${skipped}개는 검증을 통과하지 못했습니다.`
  );
}

/** "지금 문제 4개를 새로 만든 문제로 바꿉니다. 편집한 문제도 바뀝니다." */
export function replaceText(current: number): string {
  return `지금 문제 ${current}개를 새로 만든 문제로 바꿉니다. 편집한 문제도 바뀝니다.`;
}

/** "모의고사 <n>": the name a new mock exam starts with. */
export function defaultTitle(existing: number): string {
  return `모의고사 ${existing + 1}`;
}

/** A question row's title: "문제 k · <발문 앞 40자>". */
export function questionRowTitle(stem: string, k: number): string {
  const text = displayStem(stem).replace(/\s+/g, ' ').trim();
  const head = text.length > ROW_STEM_CHARS ? `${text.slice(0, ROW_STEM_CHARS)}…` : text;
  return `문제 ${k} · ${head}`;
}

/** Whether the question carries a non-blocking validation warning ("확인 필요", editors only). */
export function needsReview(question: Pick<MockExamQuestion, 'validation_issues'>): boolean {
  return (question.validation_issues ?? []).some((i) => i.severity === 'warning');
}

// --- 만들기 options ---------------------------------------------------------------------------------

/** The options step's values as typed (문항 수 stays text until it is checked). */
export interface OptionValues {
  readonly title: string;
  readonly types: readonly VariationType[];
  readonly count: string;
  /** 보기 섞기 only: every question of the range (`question_count` null). */
  readonly wholeRange: boolean;
  readonly difficulty: Difficulty | null;
}

export function optionsFromConfig(title: string, config: MockExamConfig): OptionValues {
  return {
    title,
    types: VARIATION_ORDER.filter((t) => config.variation_types.includes(t)),
    count:
      config.question_count === null || config.question_count === undefined
        ? String(DEFAULT_QUESTION_COUNT)
        : String(config.question_count),
    wholeRange: config.question_count === null || config.question_count === undefined,
    difficulty: config.difficulty ?? null,
  };
}

export function newOptions(existing: number, llmAvailable: boolean): OptionValues {
  return {
    title: defaultTitle(existing),
    types: llmAvailable ? ['PARAPHRASE'] : ['OPTION_SHUFFLE'],
    count: String(DEFAULT_QUESTION_COUNT),
    wholeRange: false,
    difficulty: null,
  };
}

export type OptionError =
  | { readonly field: 'title'; readonly message: string }
  | { readonly field: 'types'; readonly message: string }
  | { readonly field: 'count'; readonly message: string };

/** What blocks `다음`: an empty or long name, no type, an AI type that is off, a bad count. */
export function checkOptions(values: OptionValues, llmAvailable: boolean): OptionError | null {
  const title = values.title.trim();
  if (title === '') return { field: 'title', message: '이름을 입력하세요.' };
  if (title.length > TITLE_MAX) {
    return { field: 'title', message: `이름은 ${TITLE_MAX}자까지 쓸 수 있습니다.` };
  }
  if (values.types.length === 0) {
    return { field: 'types', message: '변형 유형을 하나 이상 고르세요.' };
  }
  const ai = usesAi(values.types);
  if (ai && !llmAvailable) return { field: 'types', message: AI_DISABLED_TEXT };
  if (!ai && values.wholeRange) return null;
  const count = /^\d{1,5}$/.test(values.count.trim()) ? Number(values.count.trim()) : NaN;
  const max = ai ? MAX_AI_QUESTIONS : MAX_RANGE_QUESTIONS;
  if (!Number.isInteger(count) || count < 1 || count > max) {
    return {
      field: 'count',
      message: ai
        ? `AI 변형은 1~${MAX_AI_QUESTIONS}문항까지 만들 수 있습니다.`
        : `1~${MAX_RANGE_QUESTIONS.toLocaleString('ko-KR')}문항 중에서 고르세요.`,
    };
  }
  return null;
}

/**
 * The questions a round makes from `selected` range questions: `min(문항 수, 범위)`; 보기 섞기
 * only with 범위 전체 makes every one.
 */
export function madeCount(values: OptionValues, selected: number): number {
  if (!usesAi(values.types) && values.wholeRange) return selected;
  const count = Number(values.count.trim());
  return Number.isFinite(count) ? Math.max(0, Math.min(count, selected)) : 0;
}

/**
 * The config a round sends. 보기 섞기 only cannot ask for more than the range holds (422), so its
 * count is capped at the selection, as "선택 n문제 중 m문항을 만듭니다" says.
 */
export function configFrom(values: OptionValues, selected: number): MockExamConfig {
  const types = VARIATION_ORDER.filter((t) => values.types.includes(t));
  const ai = usesAi(types);
  const count = Number(values.count.trim());
  return {
    variation_types: types,
    question_count: !ai && values.wholeRange ? null : ai ? count : Math.min(count, selected),
    difficulty: ai ? values.difficulty : null,
  };
}

// --- 범위 --------------------------------------------------------------------------------------------

/** The picker filters a saved range was chosen with. */
export function filtersFromRange(range: MockRange | null | undefined): RangeFilterState {
  const f = range?.filters;
  if (!f) return EMPTY_RANGE_FILTERS;
  return {
    status: (f.status ?? []) as QuestionDotStatus[],
    favorite: f.favorite === true,
    retry: f.retry === true,
    type: f.type ?? null,
  };
}

/**
 * The selection a saved range shows among the visible `groups` (설정 바꾸기): `전체 선택` and
 * whole chapters select what is there now (new questions included), single ids only themselves,
 * exclusions are taken out.
 */
export function selectionFromRange(groups: readonly RangeGroup[], range: MockRange): Set<string> {
  const out = new Set<string>();
  const chapters = new Set(range.chapter_ids ?? []);
  const singles = new Set(range.question_ids ?? []);
  for (const group of groups) {
    const whole = range.all === true || chapters.has(group.key);
    for (const q of group.questions) if (whole || singles.has(q.id)) out.add(q.id);
  }
  for (const id of range.excluded_question_ids ?? []) out.delete(id);
  return out;
}
