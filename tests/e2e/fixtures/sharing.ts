// Workspace sharing and fork fixtures (S0): owner share-link API, the guest share session, the
// fork API, the superuser seeds/cleanup sharing needs, and the WS-SHARE-01 / WS-VIEW-01 /
// WS-FORK-01 UI label contract. Every assumption S0 makes for S1a/S1b/S2a/S2b/S3a/S3b is listed in
// this header; a deliberate change is a one-place edit here (and in
// tests/integration/sharing/conftest.py, which mirrors the API half).
//
// Grounded in the docs (docs/workspace-sharing.md §1–§6, docs/auth.md "Workspace 공유 링크·Fork
// 인가", docs/questions.md "공유 Workspace에서의 문제 개인정보 규칙", docs/deployment.md):
//   - owner routes  POST/GET /workspaces/{id}/share-links, PATCH …/{linkId},
//                   POST …/{linkId}/revoke, POST …/{linkId}/rotate
//   - viewer routes POST /shared/{shareId}/sessions, GET /shared/{shareId},
//                   GET …/documents/{docId}, GET …/documents/{docId}/pdf, POST …/search,
//                   GET …/questions, GET …/questions/{questionId}
//   - fork routes   POST /shared/{shareId}/forks (share session + Supabase JWT, Idempotency-Key)
//                   → 202 + job id; GET /me/forks/{forkId}
//   - secret ≥ 32 CSPRNG bytes, only a SHA-256/HMAC digest stored (`token_digest`), plaintext
//     returned once; link URL `/share/{shareId}#k={secret}`; fragment exchanged once and removed;
//     HttpOnly + Secure + SameSite=Lax short-lived share cookie, never a membership; revoked /
//     expired / deleted re-checked on every request; `Cache-Control: private, no-store`,
//     `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`; allow_fork default OFF;
//     fork re-checks the link at request and before commit, CANCELLED + cleanup on a mid-fork
//     revoke / allow_fork OFF, a COMPLETED fork survives source revoke/delete; ids remapped;
//     attempts, user states, favourites/retry, drafts, activity and share links never copied.
//   - authz outcomes (implementation-plan §7): invisible → 404 (one body), member without the
//     role → 403 insufficient-role, archived write → 403 workspace-archived.
//
// NOT in the docs (S0 assumptions, to confirm or change in S1a/S1b/S3a):
//   S1 shareId == the share link's `id` (uuid). Rotate revokes the old link and issues a NEW link
//      (new id, new secret); the old id answers like any unusable link.
//   S2 Owner API bodies
//      POST  /workspaces/{id}/share-links {allow_fork?, expires_at?} → 201 IssuedShareLink
//      GET   /workspaces/{id}/share-links → 200 {items: ShareLink[]} (newest first, no secret,
//            no digest)
//      PATCH /workspaces/{id}/share-links/{linkId} {allow_fork?, expires_at?} → 200 ShareLink
//      POST  …/{linkId}/revoke → 200 ShareLink (revoked_at set; idempotent)
//      POST  …/{linkId}/rotate → 201 IssuedShareLink (the replacement link)
//      ShareLink = {id, workspace_id, allow_fork, expires_at, revoked_at, created_at}
//      IssuedShareLink = ShareLink + {secret, share_url}; `secret` is base64url without padding
//      (≥ 32 bytes → ≥ 43 chars) and share_url = `<web origin>/share/{id}#k={secret}`.
//      Archived workspace: PATCH and revoke allowed; create and rotate → 403 workspace-archived.
//      Soft-deleted workspace: every owner route 404, every link unusable (S4).
//   S3 Session exchange: POST /shared/{shareId}/sessions {secret} with an allowlisted `Origin`
//      (the web origin, CORS_ALLOWED_ORIGINS) → 204 (200/201 accepted) + `Set-Cookie:
//      quiz_share_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Max-Age<=28800` (8 h; the
//      value never contains the secret). Missing or foreign Origin → 403. Wrong secret, unknown /
//      revoked / expired / deleted link → 404 with ONE body for all of them ("link
//      unavailable"; no existence oracle). Shared reads with a session that became unusable →
//      the same 404. A request without a share cookie → 401.
//   S4 Shared read bodies
//      GET  /shared/{id}            → 200 {workspace: {name, description?}, allow_fork,
//                                          documents: [{id, title}]}
//      GET  …/documents/{docId}     → 200 {id, title, revision_id, outline: OutlineNode[],
//                                          blocks: [{id, text, page}]}  (published revision only)
//      GET  …/documents/{docId}/pdf → 200 application/pdf, or a 302/303/307 to a short-lived
//                                     local signed URL
//      POST …/search {query, mode}  → 200 {items: SearchItem[]} (published docs of THIS workspace)
//      GET  …/questions             → 200 {items: SharedQuestion[]} (CONFIRMED only)
//      GET  …/questions/{qid}       → 200 SharedQuestion (answer + explanation included)
//      SharedQuestion = Question without any per-user field (no status / is_favorite /
//      needs_retry / attempts / user_state keys). Viewing never writes question_user_states.
//      Every /shared response carries the three privacy headers of docs/workspace-sharing.md §2.
//   S5 Fork API
//      POST /shared/{id}/forks {name} + `Idempotency-Key` + Bearer JWT + share cookie + Origin
//           → 202 Fork; same key + same body → the same fork (202); no JWT → 401; no/invalid
//           share session → 404 (S3 body) or 403; allow_fork OFF → 403; unusable link → 404;
//           missing/foreign Origin → 403.
//      GET  /me/forks/{forkId} → 200 Fork; someone else's fork → 404.
//      Fork = {id, job_id, status: PENDING|COPYING|COMPLETED|FAILED|CANCELLED,
//              target_workspace_id: string|null, progress?: number}
//      target_workspace_id is hidden (null, absent from GET /workspaces) until COMPLETED; after
//      CANCELLED/FAILED the target workspace row and its copies are gone.
//   S6 Fault injection (implementation-plan §7: APP_ENV=test fake adapters, marker in the input):
//      FORK_PAUSE_MARKER in the requested fork name makes the test fork worker copy everything
//      and then hold in COPYING at the commit-time re-check until the source link is revoked /
//      expired / allow_fork OFF (→ CANCELLED + cleanup) or 60 s pass (→ commit as usual).
//      FORK_FAILURE_MARKER makes the job fail after copying (→ FAILED + cleanup).
//   S7 Rate limits (docs/workspace-sharing.md §2, S4): at most 20 session exchanges per minute per
//      client and share id, and at most 5 fork starts per minute per user; above that 429 with a
//      `Retry-After` header. Tests send a burst of 30 / 10 and expect at least one 429.
//   S8 Expiry is moved into the past with the DB superuser (equivalent to waiting; the server
//      clock is not controllable), see expireShareLinkNow(). Owner favourites/retry flags are
//      seeded the same way (the practice API arrives in M5), see seedOwnerStudyState().
//   S9 The share page performs the fragment exchange itself (browser → web/API), then removes
//      `#k=` with history.replaceState; later navigation and reloads use the share cookie only.
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   WS-SHARE-01 `/workspaces/:id/settings/sharing`: h1 "공유 설정"; status "공유 꺼짐" while no
//     active link; scope notice ("발행된 … 읽기 전용") and copyright notice ("저작권"); switch
//     "Fork 허용" (off by default); button "링크 만들기"; after creating: readonly textbox "공유 링크"
//     (the full URL with #k=), button "링크 복사", notice that it is shown only once; date input
//     "만료일" (applies on change); buttons "링크 철회" and "링크 재발급", each confirmed in an
//     alertdialog; status "철회됨". Policy controls save on change (no separate save button).
//   WS-VIEW-01 `/share/:shareId`: notice "읽기 전용"; h1 = workspace name; outline (tree or
//     navigation "목차") with one link per document; list "문제" with one listitem per published
//     question opening a non-modal panel (role=dialog) with options, answer and explanation;
//     searchbox "검색" + list "검색 결과"; document view with a PDF region and page labels; no
//     write/practice/personal controls at all; an unusable link renders heading "링크를 사용할 수
//     없습니다" and nothing of the workspace. Fork ON: button "Fork" (signed out: leads to
//     /login?next=/share/{id}?panel=fork); Fork OFF: no fork control.
//   WS-FORK-01 `/share/:shareId?panel=fork`: dialog "Workspace Fork" explaining the copied scope
//     (발행된 문서·문제·해설), that the result is independent, that personal progress is not copied,
//     and copyright; textbox "새 Workspace 이름"; button "Fork 시작"; progress (progressbar or
//     status "복제 중"), then "Fork 완료" with a link to the new workspace; failure → role=alert +
//     "다시 시도"; cancellation → "취소됨".
//
// Secrets: tests compare secrets with booleans (never `toContain(secret)`, which would print the
// value on failure) and never put them in titles or attachments. The browser specs have to open
// `/share/{id}#k=<secret>`, so a failed test's trace holds that synthetic, per-test secret of a
// link whose workspace teardown deletes (same residual risk as the synthetic login passwords,
// tests/e2e/README.md).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { API_PREFIX, isMissingRoute, routeOf, type ApiResponse, type Problem } from './api.ts';
import { book, block, search, snippet, uploadReadyBook } from './documents.ts';
import { localDbAdminUrl, localEndpoints } from './local-env.ts';
import { createQuestion, mcqInput, type Question } from './questions.ts';
import { test as base } from './test.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export const SHARE_COOKIE = 'quiz_share_session';
export const MAX_SHARE_SESSION_SECONDS = 8 * 60 * 60;
export const MIN_SECRET_BYTES = 32;
export const FORK_PAUSE_MARKER = 'E2E-FORK-PAUSE';
export const FORK_FAILURE_MARKER = 'E2E-FAIL-FORK';
export const EXCHANGE_BURST = 30;
export const FORK_BURST = 10;
export const FORK_TIMEOUT_MS = 120_000;
export const FORK_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// ---------------------------------------------------------------------------------------------
// Types (S2, S4, S5)
// ---------------------------------------------------------------------------------------------

export interface ShareLink {
  readonly id: string;
  readonly workspace_id: string;
  readonly allow_fork: boolean;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

export interface IssuedShareLink extends ShareLink {
  readonly secret: string;
  readonly share_url: string;
}

export interface SharedWorkspace {
  readonly workspace: { readonly name: string; readonly description?: string | null };
  readonly allow_fork: boolean;
  readonly documents: readonly { readonly id: string; readonly title: string }[];
}

export interface SharedDocument {
  readonly id: string;
  readonly title: string;
  readonly revision_id: string;
  readonly blocks: readonly { readonly id: string; readonly text: string; readonly page: number }[];
}

export interface Fork {
  readonly id: string;
  readonly job_id: string;
  readonly status: 'PENDING' | 'COPYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly target_workspace_id: string | null;
  readonly progress?: number;
}

/** Keys a shared question (or any shared payload) must never carry (S4). */
export const PERSONAL_KEYS = [
  'status',
  'is_favorite',
  'needs_retry',
  'attempts',
  'user_state',
  'last_graded_result',
  'owner_id',
  'created_by',
  'email',
] as const;

/** Problem body without per-request fields, for "same 404 for every unusable link" checks. */
export function stableProblem(res: ApiResponse): Partial<Problem> {
  const { type, title, status, detail } = (res.body ?? {}) as Problem;
  return { type, title, status, detail };
}

/** Throws (secret-free) unless the share secret is absent from `text`. */
export function expectNoSecret(text: string, secret: string, where: string): void {
  expect(text.includes(secret), `share secret must not appear in ${where}`).toBe(false);
}

export function sharePath(shareId: string, secret?: string): string {
  return secret === undefined ? `/share/${shareId}` : `/share/${shareId}#k=${secret}`;
}

export function sharingSettingsPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/settings/sharing`;
}

/** Decoded length of a base64url secret. */
export function secretBytes(secret: string): number {
  return /^[A-Za-z0-9_-]+$/.test(secret) ? Buffer.from(secret, 'base64url').length : 0;
}

// ---------------------------------------------------------------------------------------------
// Raw HTTP (Node fetch: secrets, cookies and tokens never reach a Playwright trace)
// ---------------------------------------------------------------------------------------------

export interface RawResponse<T = unknown> extends ApiResponse<T> {
  readonly headers: Headers;
}

export interface RawOptions {
  readonly body?: unknown;
  readonly bearer?: string;
  readonly cookie?: string;
  /** `Origin` header; defaults to the web origin under test, `null` sends none. */
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

export function webOrigin(): string {
  return new URL(localEndpoints().baseUrl).origin;
}

export async function rawApi<T = unknown>(
  method: string,
  path: string,
  options: RawOptions = {},
): Promise<RawResponse<T>> {
  const origin = options.origin === undefined ? webOrigin() : options.origin;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(origin ? { origin } : {}),
    ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  };
  let res: Response;
  try {
    res = await fetch(`${localEndpoints().apiUrl}${API_PREFIX}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });
  } catch {
    throw new Error(`${method} ${API_PREFIX}${routeOf(path)}: API unreachable`);
  }
  const text = await res.text();
  let body: T | undefined;
  try {
    body = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    body = undefined;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    text,
    headers: res.headers,
  };
}

/** Fails with "<METHOD> <route> not implemented (<status>)" or a short status message. */
export function expectStatus(
  res: ApiResponse,
  expected: readonly number[],
  method: string,
  path: string,
): void {
  if (expected.includes(res.status)) return;
  const route = `${method} ${API_PREFIX}${routeOf(path)}`;
  if (isMissingRoute(res)) throw new Error(`${route} not implemented (${res.status})`);
  const type = (res.body as Problem | undefined)?.type;
  throw new Error(
    `${route}: expected ${expected.join('/')}, got HTTP ${res.status}${type ? ` ${type}` : ''}`,
  );
}

export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: ReadonlyMap<string, string>;
}

export function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...attrs] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const attributes = new Map<string, string>();
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    attributes.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? '' : attr.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

/** The share-session cookie set by an exchange response, if any. */
export function shareCookieOf(res: RawResponse): ParsedCookie | undefined {
  return res.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((c) => c.name === SHARE_COOKIE);
}

/** Asserts the three privacy headers of docs/workspace-sharing.md §2 on a /shared response. */
export function expectPrivacyHeaders(res: RawResponse, what: string): void {
  expect(res.headers.get('cache-control') ?? '', `${what}: Cache-Control`).toMatch(/no-store/);
  expect(res.headers.get('cache-control') ?? '', `${what}: Cache-Control`).toMatch(/private/);
  expect(res.headers.get('referrer-policy') ?? '', `${what}: Referrer-Policy`).toBe('no-referrer');
  expect(res.headers.get('x-robots-tag') ?? '', `${what}: X-Robots-Tag`).toMatch(
    /noindex.*nofollow|nofollow.*noindex/,
  );
}

// ---------------------------------------------------------------------------------------------
// Owner API (S1, S2)
// ---------------------------------------------------------------------------------------------

export async function createShareLink(
  owner: Member,
  workspaceId: string,
  body: { allow_fork?: boolean; expires_at?: string | null } = {},
): Promise<IssuedShareLink> {
  return owner.api.ok<IssuedShareLink>(
    'POST',
    `/workspaces/${workspaceId}/share-links`,
    body,
    [201],
  );
}

export async function listShareLinks(owner: Member, workspaceId: string): Promise<ShareLink[]> {
  const res = await owner.api.ok<{ items: ShareLink[] }>(
    'GET',
    `/workspaces/${workspaceId}/share-links`,
    undefined,
    [200],
  );
  return res.items;
}

export async function updateShareLink(
  owner: Member,
  workspaceId: string,
  linkId: string,
  patch: { allow_fork?: boolean; expires_at?: string | null },
): Promise<ShareLink> {
  return owner.api.ok<ShareLink>(
    'PATCH',
    `/workspaces/${workspaceId}/share-links/${linkId}`,
    patch,
    [200],
  );
}

export async function revokeShareLink(
  owner: Member,
  workspaceId: string,
  linkId: string,
): Promise<ShareLink> {
  return owner.api.ok<ShareLink>(
    'POST',
    `/workspaces/${workspaceId}/share-links/${linkId}/revoke`,
    {},
    [200],
  );
}

export async function rotateShareLink(
  owner: Member,
  workspaceId: string,
  linkId: string,
): Promise<IssuedShareLink> {
  return owner.api.ok<IssuedShareLink>(
    'POST',
    `/workspaces/${workspaceId}/share-links/${linkId}/rotate`,
    {},
    [201],
  );
}

// ---------------------------------------------------------------------------------------------
// Share session (S3, S4)
// ---------------------------------------------------------------------------------------------

export function exchangeRequest(
  shareId: string,
  secret: string,
  origin?: string | null,
): Promise<RawResponse> {
  return rawApi('POST', `/shared/${shareId}/sessions`, { body: { secret }, origin });
}

/** A guest's share session held in memory (the cookie is sent by hand, like a browser would). */
export class ShareSession {
  readonly shareId: string;
  readonly cookie: string;

  private constructor(shareId: string, cookie: string) {
    this.shareId = shareId;
    this.cookie = cookie;
  }

  /** Exchanges the fragment secret; fails unless a share cookie is issued. */
  static async open(shareId: string, secret: string): Promise<ShareSession> {
    const res = await exchangeRequest(shareId, secret);
    expectStatus(res, [200, 201, 204], 'POST', `/shared/${shareId}/sessions`);
    const cookie = shareCookieOf(res);
    if (!cookie) throw new Error(`exchange set no ${SHARE_COOKIE} cookie`);
    return new ShareSession(shareId, `${cookie.name}=${cookie.value}`);
  }

  get<T = unknown>(path = ''): Promise<RawResponse<T>> {
    return rawApi<T>('GET', `/shared/${this.shareId}${path}`, { cookie: this.cookie });
  }

  call<T = unknown>(
    method: string,
    path: string,
    options: RawOptions = {},
  ): Promise<RawResponse<T>> {
    return rawApi<T>(method, path, { ...options, cookie: this.cookie });
  }

  async ok<T>(path = ''): Promise<T> {
    const res = await this.get<T>(path);
    expectStatus(res, [200], 'GET', `/shared/${this.shareId}${path}`);
    return res.body as T;
  }

  workspace(): Promise<SharedWorkspace> {
    return this.ok<SharedWorkspace>();
  }

  document(documentId: string): Promise<SharedDocument> {
    return this.ok<SharedDocument>(`/documents/${documentId}`);
  }

  async questions(): Promise<Question[]> {
    return (await this.ok<{ items: Question[] }>('/questions')).items;
  }

  async search(
    query: string,
  ): Promise<RawResponse<{ items: { document_id: string; page: number; text: string }[] }>> {
    return rawApi('POST', `/shared/${this.shareId}/search`, {
      cookie: this.cookie,
      body: { query, mode: 'keyword' },
    });
  }

  /** POST /shared/{id}/forks as `recipient` (JWT) with this share session. */
  fork(
    recipient: Member | undefined,
    name: string,
    idempotencyKey: string = randomUUID(),
    origin?: string | null,
  ): Promise<RawResponse<Fork>> {
    return rawApi<Fork>('POST', `/shared/${this.shareId}/forks`, {
      cookie: this.cookie,
      bearer: recipient?.session.accessToken,
      body: { name },
      origin,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Fork API (S5)
// ---------------------------------------------------------------------------------------------

export async function startFork(
  recipient: Member,
  session: ShareSession,
  name: string,
  idempotencyKey: string = randomUUID(),
): Promise<Fork> {
  const res = await session.fork(recipient, name, idempotencyKey);
  expectStatus(res, [202], 'POST', `/shared/${session.shareId}/forks`);
  return res.body as Fork;
}

export async function getFork(member: Member, forkId: string): Promise<Fork> {
  return member.api.ok<Fork>('GET', `/me/forks/${forkId}`, undefined, [200]);
}

/** Polls GET /me/forks/{id} (no sleeps) until `status`; returns the fork. */
export async function waitForFork(
  member: Member,
  forkId: string,
  status: Fork['status'],
): Promise<Fork> {
  let fork: Fork | undefined;
  await expect
    .poll(async () => (fork = await getFork(member, forkId)).status, {
      message: `fork reaches ${status}`,
      timeout: FORK_TIMEOUT_MS,
    })
    .toBe(status);
  if (!fork) throw new Error('no fork');
  return fork;
}

// ---------------------------------------------------------------------------------------------
// Shared content: what an owner publishes before sharing (M3/M4 public APIs)
// ---------------------------------------------------------------------------------------------

export const SHARED_BOOK = book('book-ko');
/** Published block every shared view must show (page 2). */
export const PUBLISHED_BLOCK = block(SHARED_BOOK, 'ch1-s2-p1');
/** Text of the owner's unpublished draft revision; must never reach a guest or a fork. */
export const DRAFT_TEXT = 'E2E 미발행 초안 문장 비공개';

export interface SharedContent {
  readonly documentId: string;
  readonly questions: readonly Question[];
}

/**
 * Owner content for share/fork tests: book-ko uploaded, parsed and indexed (its first revision is
 * published), two CONFIRMED MCQs with explanations sourced from it, and an unpublished draft
 * revision of one block (PATCH /documents/{id}/blocks/{blockId}, M3.4).
 */
export async function seedSharedContent(
  owner: Member,
  workspaceId: string,
): Promise<SharedContent> {
  const documentId = await uploadReadyBook(owner, workspaceId, 'book-ko');
  const questions: Question[] = [];
  for (const [i, stem] of [
    'E2E 공유 문제 하나: 비는 무엇인가?',
    'E2E 공유 문제 둘: 소독제는?',
  ].entries()) {
    questions.push(
      await createQuestion(owner, workspaceId, {
        ...mcqInput(stem, ['보기 A', '보기 B', '보기 C', '보기 D'], i),
        explanation: `E2E 해설 ${i + 1}`,
        sources: [{ document_id: documentId, page_start: 2, page_end: 2 }],
      }),
    );
  }
  const hit = (
    await search(owner, workspaceId, {
      query: snippet(PUBLISHED_BLOCK.text, 12),
      mode: 'keyword',
    })
  ).find((item) => item.document_id === documentId);
  if (!hit?.block_id) throw new Error('published block not found by owner search');
  await owner.api.ok(
    'PATCH',
    `/documents/${documentId}/blocks/${hit.block_id}`,
    { text: DRAFT_TEXT },
    [200, 201],
  );
  return { documentId, questions };
}

// ---------------------------------------------------------------------------------------------
// DB superuser (S8): seeds no public API can create yet, time travel, inspection, cleanup
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ids(...values: readonly string[]): string {
  for (const v of values) if (!UUID.test(v)) throw new Error('sharing fixture: invalid uuid');
  return values.map((v) => `'${v}'`).join(',');
}

function psql(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`sharing fixture: psql failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

/** Moves the link's expiry into the past (S8). */
export function expireShareLinkNow(linkId: string): void {
  const n = psql(
    `with u as (update public.workspace_share_links set expires_at = now() - interval '1 minute' ` +
      `where id = ${ids(linkId)} returning 1) select count(*) from u`,
  );
  if (n !== '1') throw new Error('sharing fixture: share link row not found');
}

/** The stored link row as JSON text (for "no plaintext secret" checks) and its digest length. */
export function shareLinkRow(linkId: string): {
  readonly json: string;
  readonly digestBytes: number;
} {
  const out = psql(
    `select json_build_object('row', row_to_json(l)::text, 'digest_bytes', octet_length(l.token_digest)) ` +
      `from public.workspace_share_links l where id = ${ids(linkId)}`,
  );
  if (!out) throw new Error('sharing fixture: share link row not found');
  const parsed = JSON.parse(out) as { row: string; digest_bytes: number };
  return { json: parsed.row, digestBytes: parsed.digest_bytes };
}

/** Owner's personal study state on a question: favourite + retry (S8; practice API is M5). */
export function seedOwnerStudyState(userId: string, workspaceId: string, questionId: string): void {
  psql(
    `insert into public.question_user_states (user_id, workspace_id, question_id, is_favorite, ` +
      `needs_retry, first_viewed_at, last_viewed_at) values (${ids(userId, workspaceId, questionId)}, ` +
      `true, true, now(), now())`,
  );
}

/** Row counts of per-user / private tables for one workspace (fork isolation checks). */
export function privateRowCounts(workspaceId: string): Record<string, number> {
  const w = ids(workspaceId);
  const out = psql(
    `select json_build_object(` +
      `'question_user_states', (select count(*) from public.question_user_states where workspace_id = ${w}), ` +
      `'question_attempts', (select count(*) from public.question_attempts where workspace_id = ${w}), ` +
      `'practice_sessions', (select count(*) from public.practice_sessions where workspace_id = ${w}), ` +
      `'question_drafts', (select count(*) from public.question_drafts where workspace_id = ${w}), ` +
      `'workspace_share_links', (select count(*) from public.workspace_share_links where workspace_id = ${w}))`,
  );
  return JSON.parse(out) as Record<string, number>;
}

/** Activity events in `workspaceId` whose actor is `userId`. */
export function activityCountBy(workspaceId: string, userId: string): number {
  return Number(
    psql(
      `select count(*) from public.activity_events where workspace_id = ${ids(workspaceId)} ` +
        `and actor_id = ${ids(userId)}`,
    ),
  );
}

/** Workspace rows (any status, incl. hidden fork targets) owned by `userId`. */
export function workspaceRowsOwnedBy(userId: string): number {
  return Number(psql(`select count(*) from public.workspaces where owner_id = ${ids(userId)}`));
}

/** Members of a workspace as [user_id, role] pairs. */
export function membershipsOf(workspaceId: string): [string, string][] {
  const out = psql(
    `select coalesce(json_agg(json_build_array(user_id, role)), '[]') from ` +
      `public.workspace_memberships where workspace_id = ${ids(workspaceId)}`,
  );
  return JSON.parse(out) as [string, string][];
}

/**
 * Deletes fork records and share links that reference these users or their workspaces, so the
 * workspace purge (fixtures/db.ts) and user deletion succeed. No-op before the tables exist.
 */
export function purgeSharingFor(userIds: readonly string[]): void {
  if (!userIds.length) return;
  const users = ids(...userIds);
  psql(
    `do $$ begin ` +
      `if to_regclass('public.workspace_forks') is not null then ` +
      `delete from public.workspace_forks where forked_by in (${users}) or target_workspace_id in ` +
      `(select id from public.workspaces where owner_id in (${users})) or source_workspace_id in ` +
      `(select id from public.workspaces where owner_id in (${users})); end if; ` +
      `if to_regclass('public.workspace_share_links') is not null then ` +
      `delete from public.workspace_share_links where created_by in (${users}) or workspace_id in ` +
      `(select id from public.workspaces where owner_id in (${users})); end if; end $$`,
  );
}

// ---------------------------------------------------------------------------------------------
// Playwright fixture: `sharing` cleans up share links and forks before workspaces/users go
// ---------------------------------------------------------------------------------------------

export interface SharingFixtures {
  /** Auto fixture: purges share links and fork records before workspaces and users go. */
  sharingCleanup: null;
}

export const test = base.extend<SharingFixtures>({
  sharingCleanup: [
    async ({ userFactory, workspaceFactory }, use) => {
      void workspaceFactory; // torn down after this fixture (dependency order)
      try {
        await use(null);
      } finally {
        purgeSharingFor(userFactory.created.map((u) => u.id));
      }
    },
    { auto: true },
  ],
});

export { expect };

// ---------------------------------------------------------------------------------------------
// UI contract
// ---------------------------------------------------------------------------------------------

const button = (scope: Page | Locator, name: RegExp) => scope.getByRole('button', { name });
const buttonOrLink = (scope: Page | Locator, name: RegExp) =>
  scope.getByRole('button', { name }).or(scope.getByRole('link', { name }));

export const sharingUi = {
  heading: (page: Page) => page.getByRole('heading', { level: 1 }),
  offStatus: (page: Page) =>
    main(page)
      .getByText(/공유 (꺼짐|안 함|비활성)|공유 중이 아님|sharing (is )?off|not shared/i)
      .first(),
  scopeNotice: (page: Page) =>
    main(page)
      .getByText(
        /(발행|published).*(읽기 전용|보기 전용|view[- ]only|read[- ]only)|(읽기 전용|보기 전용|view[- ]only|read[- ]only).*(발행|published)/i,
      )
      .first(),
  copyrightNotice: (page: Page) =>
    main(page)
      .getByText(/저작권|copyright/i)
      .first(),
  forkSwitch: (page: Page) => main(page).getByRole('switch', { name: /fork 허용|allow fork/i }),
  createButton: (page: Page) =>
    button(
      main(page),
      /링크 (만들기|생성)|공유 링크 (만들기|생성)|(create|generate) (share )?link/i,
    ),
  linkField: (page: Page) => main(page).getByRole('textbox', { name: /공유 링크|share link/i }),
  copyButton: (page: Page) => button(main(page), /링크 복사|^복사$|copy( link)?/i),
  onceNotice: (page: Page) =>
    main(page)
      .getByText(
        /다시 (볼|표시할|확인할) 수 없|한 번만|only (be )?shown once|shown only once|won.t be shown again/i,
      )
      .first(),
  expiry: (page: Page) => main(page).getByLabel(/만료(일| 날짜| 일시)?|expir(y|es|ation)/i),
  revokeButton: (page: Page) => button(main(page), /링크 철회|^철회$|revoke( link)?/i),
  rotateButton: (page: Page) => button(main(page), /링크 재발급|재발급|새 링크|rotate|regenerate/i),
  confirmDialog: (page: Page) => page.getByRole('alertdialog'),
  confirmButton: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(철회|재발급|확인|revoke|rotate|confirm)/i }),
  revokedStatus: (page: Page) =>
    main(page)
      .getByText(/철회됨|revoked/i)
      .first(),
};

export const sharedUi = {
  readOnlyNotice: (page: Page) =>
    page.getByText(/읽기 전용|보기 전용|view[- ]only|read[- ]only/i).first(),
  heading: (page: Page) => page.getByRole('heading', { level: 1 }),
  outline: (page: Page) =>
    page
      .getByRole('tree', { name: /목차|outline|contents/i })
      .or(page.getByRole('navigation', { name: /목차|outline|contents/i })),
  documentLink: (page: Page, title: string) =>
    sharedUi
      .outline(page)
      .getByRole('link', { name: title })
      .or(sharedUi.outline(page).getByRole('treeitem', { name: title })),
  questions: (page: Page) => page.getByRole('list', { name: /^(문제|questions?)/i }),
  question: (page: Page, stem: string) =>
    sharedUi.questions(page).getByRole('listitem').filter({ hasText: stem }),
  questionPanel: (page: Page) => page.getByRole('dialog', { name: /문제|question/i }),
  searchBox: (page: Page) => page.getByRole('searchbox', { name: /검색|search/i }),
  results: (page: Page) => page.getByRole('list', { name: /검색 결과|search results/i }),
  pdfViewer: (page: Page) => page.getByRole('region', { name: /pdf/i }),
  /** Every control that would write, practice or show personal data (must not exist). */
  forbiddenControls: (page: Page) =>
    page.getByRole('button', {
      name: /답안 제출|제출|즐겨찾기|다시 풀기|편집|수정|삭제|업로드|발행|문제 (생성|등록)|공유 설정|submit|favou?rite|retry|edit|delete|upload|publish|generate|share settings/i,
    }),
  personalData: (page: Page) =>
    page.getByText(/내 풀이|풀이 기록|정답률|오답|my (attempts|progress)|accuracy/i),
  unavailable: (page: Page) =>
    page.getByRole('heading', {
      name: /링크를 사용할 수 없|사용할 수 없는 링크|접근할 수 없|link (is )?(unavailable|invalid|expired)|no longer available/i,
    }),
  forkButton: (page: Page) =>
    buttonOrLink(page, /^fork|내 workspace로 (fork|복제)|fork (this )?workspace/i),
};

export const forkUi = {
  dialog: (page: Page) => page.getByRole('dialog', { name: /fork|복제/i }),
  scope: (dialog: Locator) =>
    dialog.getByText(/(발행|published).*(문서|문제|해설|documents|questions)/i).first(),
  independent: (dialog: Locator) => dialog.getByText(/독립|independent/i).first(),
  noProgress: (dialog: Locator) =>
    dialog
      .getByText(
        /(풀이|진행|학습|즐겨찾기).*(복사|복제|포함)(되지|하지) 않|(progress|attempts|favou?rites).*not (copied|included)/i,
      )
      .first(),
  copyright: (dialog: Locator) => dialog.getByText(/저작권|copyright/i).first(),
  nameField: (dialog: Locator) =>
    dialog.getByRole('textbox', { name: /(새 )?workspace 이름|(new )?workspace name/i }),
  submit: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(fork 시작|복제 시작|fork|start fork|confirm fork)$/i }),
  progress: (page: Page) =>
    page
      .getByRole('progressbar', { name: /fork|복제/i })
      .or(
        page.getByRole('status').filter({ hasText: /복제 중|진행 중|copying|in progress|대기/i }),
      ),
  done: (page: Page) =>
    page.getByText(/fork 완료|복제 완료|fork (completed|complete|done)/i).first(),
  cancelled: (page: Page) => page.getByText(/취소됨|취소되었|cancell?ed/i).first(),
  alert: (page: Page) => page.getByRole('alert').filter({ hasText: /실패|failed|error/i }),
  retry: (page: Page) => button(page, /다시 시도|재시도|retry/i),
};
