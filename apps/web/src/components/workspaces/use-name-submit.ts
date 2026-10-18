'use client';

// Submission state for a workspace name dialog, owned by a component that outlives the dialog
// (the create provider, the list row). The result handler therefore runs even when the dialog
// was dismissed while the request was in flight — success feedback and Idempotency-Key
// bookkeeping never depend on the form still being mounted. Each opening of the dialog is a
// session: a response for an earlier session reports itself (toast) but never touches the
// dialog now on screen.
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceFormState } from '@/lib/workspaces/actions';

export type NameAction = (
  prev: WorkspaceFormState,
  formData: FormData,
) => Promise<WorkspaceFormState>;

export interface NameSubmit {
  /** Result of the current dialog session's last submission. */
  readonly state: WorkspaceFormState;
  /** Whether the current dialog session has a submission in flight. */
  readonly pending: boolean;
  readonly submit: (formData: FormData) => void;
  /** Starts a new dialog session (call when the dialog opens): clears the previous result. */
  readonly reset: () => void;
}

export interface NameResultContext {
  /**
   * False when the dialog was reopened after this submission started: the response belongs to
   * an earlier session, so it must not close or update the dialog now on screen.
   */
  readonly current: boolean;
  /** The submitted form data (e.g. the Idempotency-Key it carried). */
  readonly formData: FormData;
}

const IDLE: WorkspaceFormState = { status: 'idle' };

export function useNameSubmit(
  action: NameAction,
  onResult: (state: WorkspaceFormState, context: NameResultContext) => void,
): NameSubmit {
  const [session, setSession] = useState(0);
  const sessionRef = useRef(0);
  const [state, setState] = useState<WorkspaceFormState>(IDLE);
  const [pendingSessions, setPendingSessions] = useState<readonly number[]>([]);
  const latest = useRef<WorkspaceFormState>(IDLE);
  const attempts = useRef(0);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const submit = useCallback(
    (formData: FormData) => {
      const submitted = sessionRef.current;
      setPendingSessions((list) => [...list, submitted]);
      startTransition(async () => {
        let next: WorkspaceFormState;
        try {
          next = await action({ ...latest.current, attempt: attempts.current }, formData);
        } finally {
          setPendingSessions((list) => {
            const index = list.indexOf(submitted);
            return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
          });
        }
        attempts.current = next.attempt ?? attempts.current + 1;
        const current = submitted === sessionRef.current;
        if (current) {
          latest.current = next;
          setState(next);
        }
        onResultRef.current(next, { current, formData });
      });
    },
    [action],
  );

  const reset = useCallback(() => {
    sessionRef.current += 1;
    setSession(sessionRef.current);
    latest.current = IDLE;
    setState(IDLE);
  }, []);

  return { state, pending: pendingSessions.includes(session), submit, reset };
}
