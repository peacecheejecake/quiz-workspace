// Maps question API failures (RFC 9457 problems, implementation-plan §7) to what QBANK-01 shows.
// Pure, so the mapping is unit-tested; the API stays the authority on every decision.
import type { Problem } from '@quiz/api-client';
import { PROBLEM_TYPES } from '@/lib/workspaces/problems';
import type { ValidationIssue } from './form';

export const QUESTION_PROBLEM_TYPES = {
  ...PROBLEM_TYPES,
  staleRevision: 'urn:quiz-workspace:problem:stale-revision',
  practiceSessionSubmitted: 'urn:quiz-workspace:problem:practice-session-submitted',
  practiceSessionNotPending: 'urn:quiz-workspace:problem:practice-session-not-pending',
} as const;

export type QuestionFailureKind =
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'staleRevision'
  | 'idempotencyKeyReused'
  | 'alreadySubmitted'
  | 'notPending'
  | 'invalid'
  | 'unavailable';

export const QUESTION_FAILURE_MESSAGES: Readonly<Record<QuestionFailureKind, string>> = {
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace는 읽기 전용입니다. 문제를 등록하거나 수정할 수 없습니다.',
  forbidden: '문제를 등록하거나 수정할 권한이 없습니다.',
  notFound: '문제를 찾을 수 없습니다. 삭제되었거나 접근 권한이 없습니다.',
  staleRevision:
    '다른 곳에서 이 문제가 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 저장해 주세요.',
  idempotencyKeyReused: '요청이 겹쳐 처리하지 못했습니다. 다시 시도해 주세요.',
  alreadySubmitted: '이미 제출한 풀이입니다. 문제를 다시 열어 새로 풀어 주세요.',
  notPending: '이미 채점이 끝난 풀이입니다.',
  invalid: '입력한 내용을 확인해 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export interface QuestionFailure {
  readonly kind: QuestionFailureKind;
  /** 422 field issues (`errors[]`), when the API sent them. */
  readonly issues?: readonly ValidationIssue[];
}

export function classifyQuestionFailure(status: number, body: unknown): QuestionFailure {
  const problem = asProblem(body);
  const type = problem?.type;
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 403) {
    return { kind: type === QUESTION_PROBLEM_TYPES.workspaceArchived ? 'archived' : 'forbidden' };
  }
  if (status === 404) return { kind: 'notFound' };
  if (status === 409) {
    if (type === QUESTION_PROBLEM_TYPES.staleRevision) return { kind: 'staleRevision' };
    if (type === QUESTION_PROBLEM_TYPES.idempotencyKeyReused) {
      return { kind: 'idempotencyKeyReused' };
    }
    if (type === QUESTION_PROBLEM_TYPES.practiceSessionSubmitted)
      return { kind: 'alreadySubmitted' };
    if (type === QUESTION_PROBLEM_TYPES.practiceSessionNotPending) return { kind: 'notPending' };
    return { kind: 'unavailable' };
  }
  if (status === 422) return { kind: 'invalid', issues: validationIssues(problem) };
  return { kind: 'unavailable' };
}

function asProblem(body: unknown): Partial<Problem> | undefined {
  return typeof body === 'object' && body !== null ? (body as Partial<Problem>) : undefined;
}

function validationIssues(problem: Partial<Problem> | undefined): ValidationIssue[] {
  const errors = problem?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((e): ValidationIssue[] => {
    if (typeof e !== 'object' || e === null || !Array.isArray(e.loc)) return [];
    const loc = e.loc.filter((p): p is string | number => ['string', 'number'].includes(typeof p));
    return [{ loc, msg: typeof e.msg === 'string' ? e.msg : '', type: e.type }];
  });
}
