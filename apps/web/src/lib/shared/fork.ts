// Browser side of WS-FORK-01 (pure + fetch, unit-tested). The fork start goes to this origin's
// `/api/shared/{id}/forks` relay (the share cookie is scoped to `/api/shared/{id}`, and the relay
// adds the user's Bearer token server-side); status polls go to `/api/me/forks/{id}`. Nothing here
// handles a token or the link secret.
import type { Schemas } from '@quiz/api-client';
import { parseRetryAfter } from '@/lib/search/client';
import { sharedBase } from './client';

export type Fork = Schemas['Fork'];
export type ForkStatus = Fork['status'];

export const FORK_NAME_MAX = 200;
/** Status polls: every second at first, then slower while a fork keeps running. */
export const FORK_POLL_MS = 1000;
export const FORK_POLL_MAX_MS = 5000;

const PROBLEM = 'urn:quiz-workspace:problem:';

/**
 * - `unauthenticated`: the account session is gone (sign in again);
 * - `unavailable`: the link is wrong / expired / revoked, or there is no share session for it;
 * - `notAllowed`: the link no longer allows forking;
 * - `tooLarge`: the workspace is larger than one fork may copy;
 * - `keyReused`: the Idempotency-Key was sent with another name (start over with a new key);
 * - `invalidName`, `rateLimited`, `network`, `failed`.
 */
export type ForkFailureKind =
  | 'unauthenticated'
  | 'unavailable'
  | 'notAllowed'
  | 'tooLarge'
  | 'keyReused'
  | 'invalidName'
  | 'rateLimited'
  | 'network'
  | 'failed';

export class ForkRequestError extends Error {
  constructor(
    readonly kind: ForkFailureKind,
    readonly status = 0,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Fork request failed: ${kind}`);
    this.name = 'ForkRequestError';
  }
}

export function classifyForkFailure(status: number, body: unknown): ForkFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (type === `${PROBLEM}fork-not-allowed`) return 'notAllowed';
  if (type === `${PROBLEM}fork-too-large`) return 'tooLarge';
  if (type === `${PROBLEM}idempotency-key-reused`) return 'keyReused';
  if (type === `${PROBLEM}share-unavailable` || type === `${PROBLEM}share-session-required`) {
    return 'unavailable';
  }
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rateLimited';
  if (status === 400 || status === 422) return 'invalidName';
  return 'failed';
}

/** The name to send (trimmed), or the Korean reason it cannot be sent. */
export function validateForkName(raw: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (name === '') return { error: '새 Workspace 이름을 입력해 주세요.' };
  if ([...name].length > FORK_NAME_MAX) {
    return { error: `이름은 ${FORK_NAME_MAX}자 이하로 입력해 주세요.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: '이름에 제어 문자를 쓸 수 없습니다.' };
  return { name };
}

/** A suggested name for the copy: the source name, cut to the limit. */
export function suggestedForkName(sourceName: string): string {
  return [...sourceName.trim()].slice(0, FORK_NAME_MAX).join('');
}

export function isTerminal(status: ForkStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

/** Delay before the `n`-th status poll (0-based). */
export function pollDelay(n: number): number {
  return Math.min(FORK_POLL_MS * 2 ** Math.floor(n / 10), FORK_POLL_MAX_MS);
}

export function forkFailureMessage(error: unknown): string {
  if (!(error instanceof ForkRequestError)) {
    return 'Fork를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  switch (error.kind) {
    case 'unauthenticated':
      return '로그인이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.';
    case 'unavailable':
      return '링크를 사용할 수 없습니다. 링크가 만료되었거나 공유가 중지되었을 수 있습니다.';
    case 'notAllowed':
      return '이 링크는 더 이상 Fork를 허용하지 않습니다.';
    case 'tooLarge':
      return '이 Workspace는 너무 커서 Fork할 수 없습니다.';
    case 'keyReused':
      return '이전 요청과 내용이 달라 시작하지 못했습니다. 다시 시도해 주세요.';
    case 'invalidName':
      return '이름을 확인해 주세요. 1~200자이며 제어 문자를 쓸 수 없습니다.';
    case 'rateLimited':
      return error.retryAfterSeconds !== undefined
        ? `요청이 너무 많습니다. ${Math.max(error.retryAfterSeconds, 1)}초 후에 다시 시도해 주세요.`
        : '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    case 'network':
      return '서버에 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    default:
      return 'Fork를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
}

/** Why a fork ended FAILED or CANCELLED, from its `error_code`. */
export function forkEndMessage(fork: Pick<Fork, 'status' | 'error_code'>): string {
  if (fork.error_code === 'share_unavailable') {
    return '복제 중에 공유 링크가 철회되었거나 만료되었거나 Fork가 꺼져 링크를 사용할 수 없습니다. 복제된 데이터는 모두 정리되었습니다.';
  }
  return fork.status === 'CANCELLED'
    ? 'Fork가 취소되었습니다. 복제된 데이터는 모두 정리되었습니다.'
    : 'Fork에 실패했습니다. 복제된 데이터는 모두 정리되었습니다. 다시 시도해 주세요.';
}

type FetchLike = typeof fetch;

export interface ForkClient {
  start(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<Fork>;
  get(forkId: string, signal?: AbortSignal): Promise<Fork>;
}

export function createForkClient(
  shareId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
  now: () => number = Date.now,
): ForkClient {
  async function send(url: string, init: RequestInit): Promise<Fork> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ForkRequestError('network');
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const kind = classifyForkFailure(response.status, body);
      const retryAfter =
        kind === 'rateLimited'
          ? (parseRetryAfter(response.headers.get('retry-after'), now()) ?? undefined)
          : undefined;
      throw new ForkRequestError(kind, response.status, retryAfter);
    }
    return (await response.json()) as Fork;
  }

  return {
    start: (name, idempotencyKey, signal) =>
      send(`${sharedBase(shareId)}/forks`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ name }),
        signal,
      }),
    get: (forkId, signal) =>
      send(`/api/me/forks/${encodeURIComponent(forkId)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      }),
  };
}
