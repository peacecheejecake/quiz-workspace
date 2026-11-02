// UX9-RETRY-OPT (docs/screens/questions-practice.md "즐겨찾기·다시 풀기 toggle"): optimistic
// favorite / retry toggles. A press shows its new state at once; the my-state requests of one
// question run one at a time, and presses made while one is in flight are coalesced into the next
// request, so the last press always wins and a late response never overwrites a newer intent. A
// failed request rolls the fields it carried back to the server's state.

export interface StudyFlags {
  readonly is_favorite: boolean;
  readonly needs_retry: boolean;
}

export type FlagPatch = Partial<StudyFlags>;

const FIELDS = ['is_favorite', 'needs_retry'] as const;

/** One question's flags while a change is being saved. */
export interface FlagEntry {
  /** The server's flags as last known (the base, then each response). */
  readonly confirmed: StudyFlags;
  /** What the toggles show: the latest intent. */
  readonly desired: StudyFlags;
  /** The request in flight (null: none). */
  readonly sending: FlagPatch | null;
}

/** The fields of `to` that differ from `from`. */
export function flagDiff(from: StudyFlags, to: StudyFlags): FlagPatch {
  const patch: { is_favorite?: boolean; needs_retry?: boolean } = {};
  for (const field of FIELDS) if (from[field] !== to[field]) patch[field] = to[field];
  return patch;
}

function isEmpty(patch: FlagPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** The entry with its next request started, if the intent still differs from the server. */
function dispatch(entry: FlagEntry): { entry: FlagEntry; send: FlagPatch | null } {
  if (entry.sending) return { entry, send: null };
  const send = flagDiff(entry.confirmed, entry.desired);
  if (isEmpty(send)) return { entry, send: null };
  return { entry: { ...entry, sending: send }, send };
}

/** A press: the toggles show `patch` at once; returns the request to start now (if any). */
export function intendFlags(
  entry: FlagEntry | undefined,
  base: StudyFlags,
  patch: FlagPatch,
): { entry: FlagEntry; send: FlagPatch | null } {
  const current = entry ?? { confirmed: base, desired: base, sending: null };
  return dispatch({ ...current, desired: { ...current.desired, ...patch } });
}

/**
 * The request in flight finished. Success: the response is the server's state. Failure: the
 * fields it carried return to the server's state (a newer press of another field still goes).
 * Returns the next request (if any); `done` when nothing is left to save.
 */
export function settleFlags(
  entry: FlagEntry,
  outcome: { readonly ok: true; readonly flags: StudyFlags } | { readonly ok: false },
): { entry: FlagEntry; send: FlagPatch | null; done: boolean } {
  const sent = entry.sending ?? {};
  let next: FlagEntry;
  if (outcome.ok) {
    next = { confirmed: outcome.flags, desired: entry.desired, sending: null };
  } else {
    const desired = { ...entry.desired };
    for (const field of FIELDS) if (field in sent) desired[field] = entry.confirmed[field];
    next = { confirmed: entry.confirmed, desired, sending: null };
  }
  const started = dispatch(next);
  return { ...started, done: started.send === null };
}

export type FlagResult<R> =
  { readonly ok: true; readonly data: R } | { readonly ok: false; readonly message: string };

export type FlagEvent<R> =
  /** The flags to show changed (a press, or a failure while more is still being saved). */
  | { readonly type: 'change'; readonly flags: StudyFlags }
  /** Everything is saved: `result` is the last response. */
  | { readonly type: 'saved'; readonly flags: StudyFlags; readonly result: R }
  /**
   * A request failed and its fields rolled back. `pending`: more is still being saved.
   * `saved`: the last successful response of this burst, if any (the server state changed).
   */
  | {
      readonly type: 'failed';
      readonly flags: StudyFlags;
      readonly message: string;
      readonly pending: boolean;
      readonly saved: R | null;
    };

/**
 * Drives the entries above: one serial request queue per question. `send` saves a patch;
 * `onEvent` reports what to show. Entries are dropped once nothing is left to save.
 */
export class FlagSync<R extends StudyFlags> {
  private readonly entries = new Map<string, FlagEntry & { readonly saved: R | null }>();

  constructor(
    private readonly send: (questionId: string, patch: FlagPatch) => Promise<FlagResult<R>>,
    private readonly onEvent: (questionId: string, event: FlagEvent<R>) => void,
    private readonly failureMessage: string,
  ) {}

  /** The flags to show while a change of `questionId` is being saved (null: none). */
  active(questionId: string): StudyFlags | null {
    return this.entries.get(questionId)?.desired ?? null;
  }

  /** A press on `questionId`, whose flags on screen are `base` unless a change is active. */
  toggle(questionId: string, base: StudyFlags, patch: FlagPatch): void {
    const prev = this.entries.get(questionId);
    const { entry, send } = intendFlags(prev, base, patch);
    this.entries.set(questionId, { ...entry, saved: prev?.saved ?? null });
    this.onEvent(questionId, { type: 'change', flags: entry.desired });
    if (send) void this.run(questionId, send);
  }

  private async run(questionId: string, patch: FlagPatch): Promise<void> {
    let result: FlagResult<R>;
    try {
      result = await this.send(questionId, patch);
    } catch {
      result = { ok: false, message: this.failureMessage };
    }
    const entry = this.entries.get(questionId);
    if (!entry) return;
    const settled = settleFlags(
      entry,
      result.ok
        ? {
            ok: true,
            flags: { is_favorite: result.data.is_favorite, needs_retry: result.data.needs_retry },
          }
        : { ok: false },
    );
    const saved = result.ok ? result.data : entry.saved;
    if (settled.done) this.entries.delete(questionId);
    else this.entries.set(questionId, { ...settled.entry, saved });
    const flags = settled.entry.desired;
    if (!result.ok) {
      this.onEvent(questionId, {
        type: 'failed',
        flags,
        message: result.message,
        pending: !settled.done,
        saved,
      });
    } else if (settled.done) {
      this.onEvent(questionId, { type: 'saved', flags, result: result.data });
    }
    // A success with more to save keeps showing the intent: no event.
    if (settled.send) void this.run(questionId, settled.send);
  }
}
