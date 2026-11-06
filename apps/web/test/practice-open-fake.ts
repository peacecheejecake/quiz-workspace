// A stand-in for `openQuestionPractice` in viewer tests, deciding like `POST .../practice-open`
// (tests/integration/questions/test_practice_open.py pins the real decision): `latest` is what the
// server would find, `open` a new session, whose calls the tests count. An opening carries a
// result only while it waits for self-grading; `해설 보기` goes through `fakePracticeReveal`.
import type { PracticeSession } from '../src/lib/questions/practice-actions';
import type { PracticeOpenRequest } from '../src/lib/questions/practice-open-client';

interface Latest {
  readonly reset_epoch?: number;
  readonly previous_revision?: boolean;
  readonly active_revision_id?: string;
  readonly latest_attempt_id?: string | null;
  readonly submitted_answer?: unknown;
  readonly session?: { readonly outcome?: { readonly result?: string } } | null;
}

type Outcome<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

export function fakePracticeOpen(deps: {
  readonly latest?: () => Promise<unknown>;
  readonly open: (workspaceId: string, questionId: string, key: string) => Promise<unknown>;
}) {
  const known = new Map<string, { session: PracticeSession; epoch: number }>();
  return async (
    workspaceId: string,
    questionId: string,
    key: string,
    request: PracticeOpenRequest = {},
  ): Promise<unknown> => {
    const found = ((await deps.latest?.()) ?? { ok: true, data: {} }) as Outcome<Latest>;
    if (!found.ok) return found;
    const epoch = found.data.reset_epoch ?? 0;
    const attempt = found.data.latest_attempt_id ?? null;
    const metadata = {
      reset_epoch: epoch,
      latest_attempt_id: attempt,
      previous_revision: found.data.previous_revision ?? false,
      result: null,
      reused: false,
    };
    const pending = found.data.session?.outcome?.result === 'pending';
    const cached = request.cached ? known.get(request.cached.sessionId) : undefined;
    if (
      cached &&
      cached.epoch === epoch &&
      request.cached?.baselineAttemptId === attempt &&
      (found.data.active_revision_id ?? cached.session.question_revision_id) ===
        cached.session.question_revision_id &&
      !pending
    ) {
      return { ok: true, data: { ...metadata, session: cached.session, reused: true } };
    }
    if (pending) {
      return {
        ok: true,
        data: {
          ...metadata,
          session: null,
          result: found.data.session,
          submitted_answer: found.data.submitted_answer,
        },
      };
    }
    const opened = (await deps.open(workspaceId, questionId, key)) as Outcome<PracticeSession>;
    if (!opened.ok) return opened;
    known.set(opened.data.id, { session: opened.data, epoch });
    return { ok: true, data: { ...metadata, session: opened.data } };
  };
}

/** `revealQuestionPractice` over the same `latest`: the submission, or the 404 of none. */
export function fakePracticeReveal(deps: { readonly latest?: () => Promise<unknown> }) {
  return async (): Promise<unknown> => {
    const found = ((await deps.latest?.()) ?? { ok: true, data: {} }) as Outcome<Latest>;
    if (!found.ok) return found;
    const result = found.data.session;
    if (!result?.outcome) return { ok: false, kind: 'notFound', message: '없음' };
    return {
      ok: true,
      data: {
        reset_epoch: found.data.reset_epoch ?? 0,
        result,
        submitted_answer: found.data.submitted_answer,
      },
    };
  };
}
