// Browser side of CHNOTE-01 for members: calls this app's own `/api/...` relay routes, which add
// the session's access token server-side (no JWT in the browser). FastAPI decides everything
// (membership, role, archived workspace, feature switch).
import { NOTE_PROBLEMS, type ChapterNoteList, type ChapterNoteState } from './model';

export type NoteFailureKind =
  'notFound' | 'forbidden' | 'running' | 'noQuestions' | 'disabled' | 'unauthenticated' | 'failed';

export class NoteApiError extends Error {
  constructor(
    readonly kind: NoteFailureKind,
    readonly status = 0,
  ) {
    super(`Chapter note request failed: ${kind}`);
    this.name = 'NoteApiError';
  }
}

export const NOTE_FAILURE_MESSAGES: Readonly<Record<NoteFailureKind, string>> = {
  notFound: '장을 찾을 수 없습니다.',
  forbidden: '이 Workspace에서 정리 노트를 만들 권한이 없습니다.',
  running: '이 장의 정리 노트를 이미 만드는 중입니다.',
  noQuestions: '이 장에는 확정된 문제가 없습니다.',
  disabled: '이 환경에서는 AI 정리 노트를 사용할 수 없습니다.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  failed: '정리 노트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export function classifyNoteFailure(status: number, body: unknown): NoteFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (type === NOTE_PROBLEMS.running) return 'running';
  if (type === NOTE_PROBLEMS.noQuestions) return 'noQuestions';
  if (type === NOTE_PROBLEMS.disabled) return 'disabled';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  return 'failed';
}

type FetchLike = typeof fetch;

async function call<T>(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new NoteApiError('failed');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new NoteApiError(classifyNoteFailure(response.status, body), response.status);
  }
  return (await response.json()) as T;
}

export function notePath(chapterId: string, version?: number | null): string {
  const id = encodeURIComponent(chapterId);
  return `/api/chapters/${id}/note${version ? `?version=${version}` : ''}`;
}

export function getChapterNote(
  chapterId: string,
  version: number | null,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<ChapterNoteState> {
  return call(fetchImpl, notePath(chapterId, version), { signal });
}

/** `정리 노트 만들기` / `다시 만들기` / `다시 시도`; the same key replays the same generation. */
export function createChapterNote(
  chapterId: string,
  idempotencyKey: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<ChapterNoteState> {
  return call(fetchImpl, notePath(chapterId), {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function listChapterNotes(
  workspaceId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<ChapterNoteList> {
  return call(fetchImpl, `/api/workspaces/${encodeURIComponent(workspaceId)}/chapter-notes`, {
    signal,
  });
}
