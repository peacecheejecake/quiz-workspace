'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FlagSync,
  type FlagEvent,
  type FlagPatch,
  type FlagResult,
  type StudyFlags,
} from '@/lib/questions/flag-sync';
import { subscribePracticeResets } from '@/lib/questions/practice-reset-events';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';

/**
 * One FlagSync (optimistic favorite / retry, UX9-RETRY-OPT) for the mounted screen. `send` and
 * `onEvent` may change every render: the latest ones are used. While a save is in flight,
 * leaving or reloading the page asks the browser's standard confirmation (user decision
 * 2026-11-02); the listener is attached only then, one per FlagSync.
 */
export function useFlagSync<R extends StudyFlags>(
  send: (questionId: string, patch: FlagPatch) => Promise<FlagResult<R>>,
  onEvent: (questionId: string, event: FlagEvent<R>) => void,
  workspaceId?: string,
): FlagSync<R> {
  const latest = useRef({ send, onEvent });
  useLayoutEffect(() => {
    latest.current = { send, onEvent };
  });
  const [state] = useState(() => {
    const confirmLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = '';
    };
    const sync = new FlagSync<R>(
      (questionId, patch) => latest.current.send(questionId, patch),
      (questionId, event) => latest.current.onEvent(questionId, event),
      QUESTION_FAILURE_MESSAGES.unavailable,
      (busy) => {
        if (busy) window.addEventListener('beforeunload', confirmLeave);
        else window.removeEventListener('beforeunload', confirmLeave);
      },
    );
    return { sync, confirmLeave };
  });
  useEffect(() => () => window.removeEventListener('beforeunload', state.confirmLeave), [state]);
  useEffect(
    () =>
      workspaceId
        ? subscribePracticeResets(workspaceId, (id) => state.sync.invalidate(id))
        : undefined,
    [state, workspaceId],
  );
  return state.sync;
}
