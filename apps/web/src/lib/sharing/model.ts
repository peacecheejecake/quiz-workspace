// WS-SHARE-01 screen model (docs/screens/workspace-sharing.md, docs/workspace-sharing.md §1–§5).
// Pure, so it is unit-tested; the API stays the authority on every decision (owner-only, archived
// rules, link status). The screen treats sharing as one current link: the newest active one.
import type { Schemas } from '@quiz/api-client';
import {
  classifyWorkspaceFailure,
  WORKSPACE_FAILURE_MESSAGES,
  type WorkspaceFailureKind,
} from '@/lib/workspaces/problems';

export type ShareLink = Schemas['ShareLink'];

export const SHARE_LINK_INACTIVE = 'urn:quiz-workspace:problem:share-link-inactive';

export type ShareFailureKind = WorkspaceFailureKind | 'inactive' | 'invalidExpiry';

export const SHARE_FAILURE_MESSAGES: Readonly<Record<ShareFailureKind, string>> = {
  ...WORKSPACE_FAILURE_MESSAGES,
  archived: '보관된 Workspace에서는 새 링크를 만들거나 재발급할 수 없습니다.',
  forbidden: 'Workspace 소유자만 공유 설정을 관리할 수 있습니다.',
  inactive: '이미 철회되었거나 만료된 링크입니다. 화면을 새로 고친 뒤 다시 시도해 주세요.',
  invalidExpiry: '만료일은 오늘 이후 날짜로 선택해 주세요.',
};

/** Classifies a failed share-link response (RFC 9457 problem bodies, implementation-plan §7). */
export function classifyShareFailure(status: number, body: unknown): ShareFailureKind {
  if (status === 409 && problemType(body) === SHARE_LINK_INACTIVE) return 'inactive';
  return classifyWorkspaceFailure(status, body);
}

function problemType(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('type' in body)) return undefined;
  return typeof body.type === 'string' ? body.type : undefined;
}

/** Newest first, whatever order the caller got them in. */
function newestFirst(links: readonly ShareLink[]): ShareLink[] {
  return [...links].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export interface SharingState {
  /**
   * The link the screen manages: the newest active link, else the newest expired (not revoked)
   * one — its policy can still be edited, and a later expiry reopens the URL already handed out.
   */
  readonly current: ShareLink | null;
  /** Sharing is on: `current` is active. */
  readonly active: boolean;
  /** Other links that are not revoked (e.g. issued through the API); "링크 철회" revokes them too. */
  readonly others: readonly ShareLink[];
  /** While sharing is off: why the managed (or newest) link stopped working, if there is one. */
  readonly lastEnded: 'revoked' | 'expired' | null;
}

export function sharingState(links: readonly ShareLink[]): SharingState {
  const sorted = newestFirst(links);
  const live = sorted.filter((link) => link.status !== 'revoked');
  const current =
    live.find((link) => link.status === 'active') ??
    live.find((link) => link.status === 'expired') ??
    null;
  const active = current?.status === 'active';
  const others = live.filter((link) => link !== current);
  const lastEnded = active ? null : current ? 'expired' : sorted.length > 0 ? 'revoked' : null;
  return { current, active, others, lastEnded };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD` of `date` in the runtime's local timezone (the viewer's, in the browser). */
export function localDateString(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local calendar date an `expires_at` instant falls on; `''` for no expiry. */
export function expiryDateValue(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const instant = new Date(expiresAt);
  return Number.isNaN(instant.getTime()) ? '' : localDateString(instant);
}

export type ExpiryParse =
  { readonly ok: true; readonly expiresAt: string | null } | { readonly ok: false };

/**
 * A `<input type="date">` value → `expires_at`: the link works through the whole chosen day
 * (local end of day). Empty clears the expiry; malformed dates and days before today fail.
 */
export function parseExpiryDate(value: string, now: Date = new Date()): ExpiryParse {
  if (value === '') return { ok: true, expiresAt: null };
  const match = DATE.exec(value);
  if (!match) return { ok: false };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) {
    return { ok: false };
  }
  if (end.getTime() <= now.getTime()) return { ok: false };
  return { ok: true, expiresAt: end.toISOString() };
}

const SECRET = /^[A-Za-z0-9_-]{43,}$/;

/** True for `<http(s) origin>/share/{linkId}#k={secret}` (the URL shown once after issuing). */
export function isShareUrl(value: unknown, linkId: string): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.pathname === `/share/${linkId}` &&
    url.search === '' &&
    url.hash.startsWith('#k=') &&
    SECRET.test(url.hash.slice(3))
  );
}
