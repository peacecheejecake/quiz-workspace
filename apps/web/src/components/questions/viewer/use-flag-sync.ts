'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  FlagSync,
  type FlagEvent,
  type FlagPatch,
  type FlagResult,
  type StudyFlags,
} from '@/lib/questions/flag-sync';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';

/**
 * One FlagSync (optimistic favorite / retry, UX9-RETRY-OPT) for the mounted screen. `send` and
 * `onEvent` may change every render: the latest ones are used.
 */
export function useFlagSync<R extends StudyFlags>(
  send: (questionId: string, patch: FlagPatch) => Promise<FlagResult<R>>,
  onEvent: (questionId: string, event: FlagEvent<R>) => void,
): FlagSync<R> {
  const latest = useRef({ send, onEvent });
  useLayoutEffect(() => {
    latest.current = { send, onEvent };
  });
  const [sync] = useState(
    () =>
      new FlagSync<R>(
        (questionId, patch) => latest.current.send(questionId, patch),
        (questionId, event) => latest.current.onEvent(questionId, event),
        QUESTION_FAILURE_MESSAGES.unavailable,
      ),
  );
  return sync;
}
