// UX7-CACHE (docs/screens/questions-practice.md, QPLAY-01-AC06): the practice sessions this screen
// opened, so re-opening an unanswered question (close/reopen, previous/next) needs no request.
// In memory only, one instance per mounted panel and workspace: it is dropped with the screen
// (sign-out, another workspace or route), never written to browser storage. It holds only the
// answer-free `PracticeSession` fields (copied field by field, so an unexpected field never gets
// in) of sessions that are still open; a session whose submission started is never handed out
// again, and submit results (answers, explanations) are never stored.
import type { PracticeSession } from './practice-actions';

/** How long an open session is reused (an edit made elsewhere shows up at most this late). */
export const PRACTICE_CACHE_TTL_MS = 10 * 60_000;
export const PRACTICE_CACHE_MAX_ENTRIES = 200;

interface Entry {
  readonly session: PracticeSession;
  readonly storedAt: number;
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

  /** Keeps an open session of this workspace; anything else (submitted, foreign) is ignored. */
  put(session: PracticeSession): void {
    if (session.workspace_id.toLowerCase() !== this.workspaceId) return;
    const key = session.question_id.toLowerCase();
    if (session.state !== 'open') {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { session: answerFreeSession(session), storedAt: this.now() });
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
  }

  get size(): number {
    return this.entries.size;
  }
}
