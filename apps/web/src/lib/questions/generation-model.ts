// QGEN-01 form model (docs/questions.md §5): variation labels, which variations a source allows
// and the request body of a generation run. Pure and unit-tested.
//
// OPTION_SHUFFLE is not a generation: it never creates a question or a dot. It opens the
// original question's practice panel, whose session stores the shuffled order (M5.2), so it is
// exclusive with the LLM variations in the form.
import type { QuestionType } from './form';
import type {
  GenerationCreate,
  GenerationDifficulty,
  LlmVariationType,
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
  ANALOGOUS_CONCEPT: '원본의 출처 쪽 원문을 근거로 비슷한 개념을 묻는 새 초안을 만듭니다.',
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
  /** The source cites document pages (ANALOGOUS_CONCEPT takes its passages from them). */
  readonly hasSources: boolean;
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
  if (type === 'ANALOGOUS_CONCEPT' && !source.hasSources) {
    return '유사 개념은 원본 문제에 문서 출처 쪽이 있어야 만들 수 있습니다.';
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
