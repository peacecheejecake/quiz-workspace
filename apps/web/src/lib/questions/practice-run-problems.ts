// QVIEW-01 run API failures (RFC 9457 problems, QVIEW-01-C01–C05) as the run panel tells them.
// Pure, so the mapping is unit-tested; the API stays the authority on every decision.
import { PRACTICE_RUN_MAX } from './practice-runs';
import { QUESTION_PROBLEM_TYPES } from './problems';

/** Why a run action failed, as the run panel tells it. */
export type RunFailureKind =
  | 'notFound'
  | 'archived'
  | 'noMatching'
  | 'tooLarge'
  | 'rangeInvalid'
  | 'finished'
  | 'alreadySubmitted'
  | 'invalid'
  | 'unavailable';

export type RunActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: RunFailureKind; readonly message: string };

export const RUN_FAILURE_MESSAGES: Readonly<Record<RunFailureKind, string>> = {
  notFound: '풀이를 찾을 수 없습니다.',
  archived: '보관된 Workspace에서는 답안을 제출할 수 없습니다.',
  noMatching: '조건에 맞는 문제가 없습니다.',
  tooLarge: `한 번에 ${PRACTICE_RUN_MAX.toLocaleString('ko-KR')}문제까지 풀 수 있습니다.`,
  rangeInvalid: '고른 문제 중 더 이상 풀 수 없는 문제가 있습니다. 범위를 다시 골라 주세요.',
  finished: '끝난 풀이입니다. 처음부터 다시 풀어 주세요.',
  alreadySubmitted: '이미 제출한 문제입니다.',
  invalid: '입력한 내용을 확인해 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

const RUN_PROBLEMS = {
  noMatching: 'urn:quiz-workspace:problem:no-matching-questions',
  tooLarge: 'urn:quiz-workspace:problem:practice-run-too-large',
  rangeInvalid: 'urn:quiz-workspace:problem:range-invalid',
  finished: 'urn:quiz-workspace:problem:practice-run-finished',
  alreadySubmitted: 'urn:quiz-workspace:problem:already-submitted',
} as const;

function problemType(body: unknown): string | undefined {
  const type = (body as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' ? type : undefined;
}

/** An API failure of a run call as the run panel tells it. */
export function classifyRunFailure(status: number, body: unknown): RunFailureKind {
  const type = problemType(body);
  if (status === 403) {
    return type === QUESTION_PROBLEM_TYPES.workspaceArchived ? 'archived' : 'notFound';
  }
  if (status === 404) return 'notFound';
  if (status === 409) {
    if (type === RUN_PROBLEMS.noMatching) return 'noMatching';
    if (type === RUN_PROBLEMS.finished) return 'finished';
    if (type === RUN_PROBLEMS.alreadySubmitted) return 'alreadySubmitted';
    return 'unavailable';
  }
  if (status === 422) {
    if (type === RUN_PROBLEMS.tooLarge) return 'tooLarge';
    if (type === RUN_PROBLEMS.rangeInvalid) return 'rangeInvalid';
    return 'invalid';
  }
  return 'unavailable';
}
