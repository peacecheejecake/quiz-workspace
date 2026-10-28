// Upload/document failures as the DOC-01 screen shows them. Every failure carries a Korean reason
// and whether "다시 시도" can help; `restart` says the next attempt needs a new upload intent.
import type { Problem } from '@quiz/api-client';

export const DOCUMENT_PROBLEMS = {
  uploadIncomplete: 'urn:quiz-workspace:problem:upload-incomplete',
  uploadExpired: 'urn:quiz-workspace:problem:upload-expired',
  uploadMismatch: 'urn:quiz-workspace:problem:upload-mismatch',
  workspaceArchived: 'urn:quiz-workspace:problem:workspace-archived',
  insufficientRole: 'urn:quiz-workspace:problem:insufficient-role',
  documentInUse: 'urn:quiz-workspace:problem:document-in-use',
  documentNotReady: 'urn:quiz-workspace:problem:document-not-ready',
} as const;

export type DocumentFailureKind =
  | 'network'
  | 'storage'
  | 'incomplete'
  | 'expired'
  | 'mismatch'
  | 'rejected'
  | 'tooLarge'
  | 'unauthenticated'
  | 'archived'
  | 'forbidden'
  | 'notFound'
  | 'inUse'
  | 'notReady'
  | 'unavailable';

export const DOCUMENT_FAILURE_MESSAGES: Readonly<Record<DocumentFailureKind, string>> = {
  network: '네트워크 연결이 끊겨 업로드가 중단되었습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
  storage: '파일 저장소에 업로드하지 못했습니다. 다시 시도해 주세요.',
  incomplete: '업로드가 끝나지 않았습니다. 다시 시도하면 이어서 진행합니다.',
  expired: '업로드 시간이 만료되었습니다. 다시 시도하면 새로 업로드합니다.',
  mismatch: '업로드된 파일이 선택한 파일과 다릅니다. 파일을 다시 선택해 주세요.',
  rejected: 'PDF 파일(.pdf)만 업로드할 수 있습니다.',
  tooLarge: '파일이 너무 큽니다. PDF는 최대 50MB(50MiB)까지 업로드할 수 있습니다.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  archived: '보관된 Workspace에는 업로드하거나 문서를 삭제할 수 없습니다.',
  forbidden: '이 Workspace에서 문서를 업로드하거나 삭제할 권한이 없습니다.',
  notFound: '문서를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.',
  inUse: '이 교재의 챕터나 출처를 쓰는 문제가 있어 문제지로 바꿀 수 없습니다.',
  notReady: '처리가 끝난 PDF만 종류를 바꿀 수 있습니다.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

const RETRYABLE = new Set<DocumentFailureKind>([
  'network',
  'storage',
  'incomplete',
  'expired',
  'unavailable',
]);

export class DocumentApiError extends Error {
  readonly retryable: boolean;
  /** Server detail (RFC 9457 `detail`), shown after our own reason when present. */
  readonly detail?: string;

  constructor(
    readonly kind: DocumentFailureKind,
    readonly status = 0,
    detail?: string,
  ) {
    super(DOCUMENT_FAILURE_MESSAGES[kind]);
    this.name = 'DocumentApiError';
    this.retryable = RETRYABLE.has(kind);
    this.detail = detail;
  }
}

/** Maps a failed API (or BFF) response to a failure kind by status and problem type. */
export function classifyDocumentFailure(status: number, body: unknown): DocumentFailureKind {
  const problem = asProblem(body);
  const type = problem?.type;
  if (status === 401) return 'unauthenticated';
  if (status === 403)
    return type === DOCUMENT_PROBLEMS.workspaceArchived ? 'archived' : 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409 && type === DOCUMENT_PROBLEMS.uploadIncomplete) return 'incomplete';
  if (status === 409 && type === DOCUMENT_PROBLEMS.uploadExpired) return 'expired';
  if (status === 409 && type === DOCUMENT_PROBLEMS.documentInUse) return 'inUse';
  if (status === 409 && type === DOCUMENT_PROBLEMS.documentNotReady) return 'notReady';
  if (type === DOCUMENT_PROBLEMS.uploadMismatch) return 'mismatch';
  if (status === 413) return 'tooLarge';
  if (status === 415 || status === 422) return 'rejected';
  return 'unavailable';
}

export function asProblem(body: unknown): Partial<Problem> | undefined {
  return typeof body === 'object' && body !== null ? (body as Partial<Problem>) : undefined;
}

export function errorFromResponse(status: number, body: unknown): DocumentApiError {
  const detail = asProblem(body)?.detail;
  return new DocumentApiError(
    classifyDocumentFailure(status, body),
    status,
    typeof detail === 'string' ? detail : undefined,
  );
}
