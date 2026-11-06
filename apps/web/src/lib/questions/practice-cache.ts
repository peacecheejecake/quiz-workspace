// UX7-CACHE (docs/screens/questions-practice.md, QPLAY-01-AC06): the practice sessions this screen
// opened, so re-opening an unanswered question (close/reopen, previous/next) keeps its session; the
// server confirms it in the opening call (UX12-OPEN).
// In memory only, one instance per mounted panel and workspace: it is dropped with the screen
// (sign-out, another workspace or route), never written to browser storage. It holds only the
// answer-free `PracticeSession` fields (copied field by field, so an unexpected field never gets
// in) of sessions that are still open; a session whose submission started is never handed out
// again (not even when a late duplicate open response for it arrives), and submit results
// (answers, explanations) are never stored. `해설 보기` retires the session on the server, so it
// is dropped here too.
import type { PracticeSession } from './practice-actions';

/** How long an open session is reused (an edit made elsewhere shows up at most this late). */
export const PRACTICE_CACHE_TTL_MS = 10 * 60_000;
export const PRACTICE_CACHE_MAX_ENTRIES = 200;

interface Entry {
  readonly session: PracticeSession;
  readonly storedAt: number;
  readonly epoch: number;
  readonly baselineAttemptId: string | null;
}

export interface PracticeCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/** The answer-free fields of `session`, copied one by one (never a spread of the payload). */
export function answerFreeSession(session: PracticeSession): PracticeSession {
  return {
    id: session.id,
    workspace_id: session.workspace_id,
    question_id: session.question_id,
    question_revision_id: session.question_revision_id,
    question_number: session.question_number,
    question_type: session.question_type,
    chapter_id: session.chapter_id,
    stem: session.stem,
    stem_tables: session.stem_tables,
    is_multi_answer: session.is_multi_answer,
    displayed_option_ids: [...session.displayed_option_ids],
    options: session.options.map((o) => ({ id: o.id, text: o.text })),
    state: session.state,
    opened_at: session.opened_at,
  };
}

export class PracticeSessionCache {
  readonly workspaceId: string;
  private readonly entries = new Map<string, Entry>();
  /** Session ids dropped at submission (→ when), refused by `put`; same cap and TTL. */
  private readonly dropped = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(workspaceId: string, options: PracticeCacheOptions = {}) {
    this.workspaceId = workspaceId.toLowerCase();
    this.ttlMs = options.ttlMs ?? PRACTICE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? PRACTICE_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** The open session of `questionId` this screen may show again, or null. */
  get(questionId: string | null): PracticeSession | null {
    if (!questionId) return null;
    const key = questionId.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.session;
  }

  /** Epoch pinned when the open session was created. */
  epoch(questionId: string): number | undefined {
    return this.get(questionId) ? this.entries.get(questionId.toLowerCase())?.epoch : undefined;
  }

  /** Latest attempt known when this unanswered session was opened. */
  baselineAttemptId(questionId: string): string | null | undefined {
    return this.get(questionId)
      ? this.entries.get(questionId.toLowerCase())?.baselineAttemptId
      : undefined;
  }

  /** Keeps an open session of this workspace; anything else (submitted, foreign) is ignored. */
  put(session: PracticeSession, epoch = 0, baselineAttemptId: string | null = null): void {
    if (session.workspace_id.toLowerCase() !== this.workspaceId) return;
    if (this.wasDropped(session.id)) return;
    const key = session.question_id.toLowerCase();
    if (session.state !== 'open') {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, {
      session: answerFreeSession(session),
      storedAt: this.now(),
      epoch,
      baselineAttemptId,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Forgets `sessionId` (its submission started: it can no longer be answered). */
  dropSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.session.id === sessionId) this.entries.delete(key);
    }
    this.dropped.delete(sessionId);
    this.dropped.set(sessionId, this.now());
    while (this.dropped.size > this.maxEntries) {
      const oldest = this.dropped.keys().next().value;
      if (oldest === undefined) break;
      this.dropped.delete(oldest);
    }
  }

  private wasDropped(sessionId: string): boolean {
    const at = this.dropped.get(sessionId);
    if (at === undefined) return false;
    if (this.now() - at >= this.ttlMs) {
      this.dropped.delete(sessionId);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * What one opening of the panel already put on screen, by question: previous/next shows it at once
 * (UX12-SOLVEDOPEN-AC09). Unlike `PracticeSessionCache`, it may hold a result, but only one this
 * opening has shown: closing the panel clears it, and it never reaches browser storage.
 */
export class OpeningViews<T> {
  private readonly views = new Map<string, T>();
  private readonly drops = new Map<string, number>();
  private opening = 0;

  get(questionId: string): T | undefined {
    return this.views.get(questionId.toLowerCase());
  }

  /** Taken before awaiting: `put` refuses it once the question or the opening has been dropped. */
  token(questionId: string): string {
    return `${this.opening}:${this.drops.get(questionId.toLowerCase()) ?? 0}`;
  }

  put(questionId: string, view: T, token: string): void {
    if (token === this.token(questionId)) this.views.set(questionId.toLowerCase(), view);
  }

  drop(questionId: string): void {
    const key = questionId.toLowerCase();
    this.views.delete(key);
    this.drops.set(key, (this.drops.get(key) ?? 0) + 1);
  }

  clear(): void {
    this.views.clear();
    this.drops.clear();
    this.opening += 1;
  }
}
