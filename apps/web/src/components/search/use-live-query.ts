'use client';

// SEARCH-01-AC12: the 문제 search box filters as you type (docs/screens/search.md, UX7-SEARCH).
// The box shows every keystroke at once (a controlled input whose value only the user changes, so
// characters and the caret are never lost); `onCommit` runs once typing pauses for `delayMs`,
// never in the middle of an IME composition (compositionstart … compositionend), and not again for
// the same normalized value. The URL value (`urlValue`) the page reports back replaces the box only
// when it is not one of our own commits (lib/search/live-query.ts) — browser Back/Forward, a reset.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
} from 'react';
import {
  addWrite,
  LIVE_QUERY_DELAY_MS,
  normalizeQuery,
  settleWrites,
} from '@/lib/search/live-query';

export interface UseLiveQueryOptions {
  /** The committed value as the address bar has it now. */
  readonly urlValue: string;
  readonly max: number;
  /** Called with the normalized value once typing pauses (or on `flush`). */
  readonly onCommit: (value: string) => void;
  readonly delayMs?: number;
}

export interface LiveQuery {
  readonly value: string;
  readonly inputProps: {
    readonly value: string;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly onCompositionStart: () => void;
    readonly onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  };
  /** Commits the current value now (Enter). */
  readonly flush: () => void;
  /** Empties the box and commits that now, dropping a pending commit. */
  readonly clear: () => void;
  /** Sets the box from the page (a reset), dropping a pending commit; does not commit. */
  readonly replace: (value: string) => void;
}

interface Sync {
  /** The last `urlValue` seen. */
  readonly seen: string;
  /** Our commits the URL has not reported yet. */
  readonly pending: readonly string[];
  /** Bumped when the URL changed from outside. */
  readonly external: number;
}

export function useLiveQuery({
  urlValue,
  max,
  onCommit,
  delayMs = LIVE_QUERY_DELAY_MS,
}: UseLiveQueryOptions): LiveQuery {
  const [value, setValue] = useState(urlValue);
  const [sync, setSync] = useState<Sync>({ seen: urlValue, pending: [], external: 0 });
  if (sync.seen !== urlValue) {
    const settled = settleWrites(sync.pending, urlValue);
    setSync({
      seen: urlValue,
      pending: settled.pending,
      external: settled.ours ? sync.external : sync.external + 1,
    });
    if (!settled.ours && normalizeQuery(value, max) !== urlValue) setValue(urlValue);
  }

  const timerRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  /** The value last committed (or reported from outside): never committed twice in a row. */
  const committedRef = useRef(urlValue);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  });

  const cancel = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  // A change from outside replaces whatever was about to be committed.
  const handledExternalRef = useRef(0);
  const { external, seen } = sync;
  useEffect(() => {
    if (handledExternalRef.current === external) return;
    handledExternalRef.current = external;
    cancel();
    composingRef.current = false;
    committedRef.current = seen;
  }, [cancel, external, seen]);

  const commit = useCallback(
    (raw: string) => {
      cancel();
      const next = normalizeQuery(raw, max);
      if (next === committedRef.current) return;
      committedRef.current = next;
      setSync((s) => ({ ...s, pending: addWrite(s.pending, next, s.seen) }));
      onCommitRef.current(next);
    },
    [cancel, max],
  );

  const schedule = useCallback(
    (raw: string) => {
      cancel();
      if (normalizeQuery(raw, max) === '') {
        commit(raw);
        return;
      }
      timerRef.current = window.setTimeout(() => commit(raw), delayMs);
    },
    [cancel, commit, delayMs, max],
  );

  return {
    value,
    inputProps: {
      value,
      onChange: (event) => {
        const next = event.target.value;
        setValue(next);
        const native = event.nativeEvent as Partial<InputEvent>;
        if (!composingRef.current && native.isComposing !== true) schedule(next);
      },
      onCompositionStart: () => {
        composingRef.current = true;
        cancel();
      },
      onCompositionEnd: (event) => {
        composingRef.current = false;
        schedule(event.currentTarget.value);
      },
    },
    flush: () => {
      if (composingRef.current) return;
      commit(value);
    },
    clear: () => {
      composingRef.current = false;
      setValue('');
      commit('');
    },
    replace: (next) => {
      cancel();
      composingRef.current = false;
      const normalized = normalizeQuery(next, max);
      committedRef.current = normalized;
      setSync((s) => ({ ...s, pending: addWrite(s.pending, normalized, s.seen) }));
      setValue(next);
    },
  };
}
