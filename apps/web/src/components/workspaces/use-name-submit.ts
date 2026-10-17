'use client';

// Submission state for a workspace name dialog, owned by a component that outlives the dialog
// (the create provider, the list row). The result handler therefore runs even when the dialog
// was dismissed while the request was in flight — success feedback and Idempotency-Key
// bookkeeping never depend on the form still being mounted.
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { WorkspaceFormState } from '@/lib/workspaces/actions';

export type NameAction = (
  prev: WorkspaceFormState,
  formData: FormData,
) => Promise<WorkspaceFormState>;

export interface NameSubmit {
  readonly state: WorkspaceFormState;
  readonly pending: boolean;
  readonly submit: (formData: FormData) => void;
  /** Clears the previous result (call when the dialog opens again). */
  readonly reset: () => void;
}

const IDLE: WorkspaceFormState = { status: 'idle' };

export function useNameSubmit(
  action: NameAction,
  onResult: (state: WorkspaceFormState) => void,
): NameSubmit {
  const [state, setState] = useState<WorkspaceFormState>(IDLE);
  const [pending, startTransition] = useTransition();
  const latest = useRef<WorkspaceFormState>(IDLE);
  const attempts = useRef(0);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const submit = useCallback(
    (formData: FormData) => {
      startTransition(async () => {
        const next = await action({ ...latest.current, attempt: attempts.current }, formData);
        attempts.current = next.attempt ?? attempts.current + 1;
        latest.current = next;
        setState(next);
        onResultRef.current(next);
      });
    },
    [action],
  );

  const reset = useCallback(() => {
    latest.current = IDLE;
    setState(IDLE);
  }, []);

  return { state, pending, submit, reset };
}
