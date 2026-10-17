// Maps Workspace API failures (RFC 9457 problems, implementation-plan §7) to what the WS-01 screen
// shows. Pure, so the mapping is unit-tested; the API stays the authority on every decision.
import type { Problem } from '@quiz/api-client';

export const PROBLEM_TYPES = {
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  insufficientRole: 'urn:quiz-workspace:problem:insufficient-role',
  idempotencyKeyReused: 'urn:quiz-workspace:problem:idempotency-key-reused',
} as const;

export type WorkspaceFailureKind =
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'idempotencyKeyReused'
  | 'invalid'
  | 'unavailable';

export const WORKSPACE_FAILURE_MESSAGES: Readonly<Record<WorkspaceFailureKind, string>> = {
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace는 수정할 수 없습니다. 먼저 복원해 주세요.',
  forbidden: '이 작업을 할 권한이 없습니다. 소유자만 할 수 있습니다.',
  notFound: 'Workspace를 찾을 수 없습니다. 삭제되었거나 접근 권한이 없습니다.',
  idempotencyKeyReused: '요청이 겹쳐 처리하지 못했습니다. 다시 시도해 주세요.',
  invalid: '입력한 값을 확인해 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

/** Classifies a failed response by status and problem `type` (unknown bodies are tolerated). */
export function classifyWorkspaceFailure(status: number, body: unknown): WorkspaceFailureKind {
  const type = problemType(body);
  if (status === 401) return 'unauthenticated';
  if (status === 403) {
    return type === PROBLEM_TYPES.workspaceArchived ? 'archived' : 'forbidden';
  }
  if (status === 404) return 'notFound';
  if (status === 409 && type === PROBLEM_TYPES.idempotencyKeyReused) return 'idempotencyKeyReused';
  if (status === 422) return 'invalid';
  return 'unavailable';
}

function problemType(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const type = (body as Partial<Problem>).type;
  return typeof type === 'string' ? type : undefined;
}
