// A stand-in for `openQuestionPractice` in viewer tests, deciding like `POST .../practice-open`
// (tests/integration/questions/test_practice_open.py pins the real decision): `latest` is what the
// server would find, `open` a new session, whose calls the tests count.
import type { PracticeSession } from '../src/lib/questions/practice-actions';
import type { PracticeOpenRequest } from '../src/lib/questions/practice-open-client';

interface Latest {
  readonly reset_epoch?: number;
  readonly previous_revision?: boolean;
  readonly active_revision_id?: string;
  readonly latest_attempt_id?: string | null;
  readonly submitted_answer?: unknown;
  readonly session?: { readonly outcome?: { readonly result?: string } } | null;
  /** UX12-RETRYOPEN: marked 다시 풀기, so a graded result stays out of the opening. */
  readonly needs_retry?: boolean;
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
    const cached = request.cached ? known.get(request.cached.sessionId) : undefined;
    if (
      cached &&
      cached.epoch === epoch &&
      request.cached?.baselineAttemptId === attempt &&
      (found.data.active_revision_id ?? cached.session.question_revision_id) ===
        cached.session.question_revision_id
    ) {
      return { ok: true, data: { ...metadata, session: cached.session, reused: true } };
    }
    const outcome = found.data.session?.outcome;
    const retryClean = found.data.needs_retry === true && outcome?.result !== 'pending';
    if (!request.forceNew && outcome && !retryClean) {
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
