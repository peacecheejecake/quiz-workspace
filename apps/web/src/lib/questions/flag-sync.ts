// UX9-RETRY-OPT (docs/screens/questions-practice.md "즐겨찾기·다시 풀기 toggle"): optimistic
// favorite / retry toggles. A press shows its new state at once; the my-state requests of one
// question run one at a time, and presses made while one is in flight are coalesced into the next
// request, so the last press always wins and a late response never overwrites a newer intent. A
// failed request rolls the fields it carried back to the server's state. Only fields the user
// pressed are ever sent: the others follow the server (a change made in another tab is kept).

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
  /** The fields the user pressed and not yet saved, with the value last pressed. */
  readonly intent: FlagPatch;
  /** What the toggles show: the server's flags with the intent on top. */
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

function entryOf(confirmed: StudyFlags, intent: FlagPatch, sending: FlagPatch | null): FlagEntry {
  return { confirmed, intent, desired: { ...confirmed, ...intent }, sending };
}

/** The entry with its next request started, if the intent still differs from the server. */
function dispatch(entry: FlagEntry): { entry: FlagEntry; send: FlagPatch | null } {
  if (entry.sending) return { entry, send: null };
  const send = flagDiff(entry.confirmed, entry.desired);
  if (isEmpty(send)) return { entry: entryOf(entry.confirmed, {}, null), send: null };
  return { entry: { ...entry, sending: send }, send };
}

/** A press: the toggles show `patch` at once; returns the request to start now (if any). */
export function intendFlags(
  entry: FlagEntry | undefined,
  base: StudyFlags,
  patch: FlagPatch,
): { entry: FlagEntry; send: FlagPatch | null } {
  const current = entry ?? entryOf(base, {}, null);
  return dispatch(entryOf(current.confirmed, { ...current.intent, ...patch }, current.sending));
}

/**
 * The request in flight finished. Success: the response is the server's state (a pressed field
 * it already matches is saved; an untouched field takes its value). Failure: the fields it
 * carried return to the server's state (a newer press of another field still goes). Returns the
 * next request (if any); `done` when nothing is left to save.
 */
export function settleFlags(
  entry: FlagEntry,
  outcome: { readonly ok: true; readonly flags: StudyFlags } | { readonly ok: false },
): { entry: FlagEntry; send: FlagPatch | null; done: boolean } {
  const sent = entry.sending ?? {};
  const confirmed = outcome.ok ? outcome.flags : entry.confirmed;
  const intent: { is_favorite?: boolean; needs_retry?: boolean } = {};
  for (const field of FIELDS) {
    const wanted = entry.intent[field];
    if (wanted === undefined || wanted === confirmed[field]) continue;
    if (!outcome.ok && field in sent) continue;
    intent[field] = wanted;
  }
  const started = dispatch(entryOf(confirmed, intent, null));
  return { ...started, done: started.send === null };
}

export type FlagResult<R> =
  { readonly ok: true; readonly data: R } | { readonly ok: false; readonly message: string };

export type FlagEvent<R> =
  /** The flags to show changed (a press, a response changing an untouched field, a failure). */
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

function sameFlags(a: StudyFlags, b: StudyFlags): boolean {
  return a.is_favorite === b.is_favorite && a.needs_retry === b.needs_retry;
}

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
    /** Called when saving starts (true) or nothing is left to save (false). */
    private readonly onBusyChange?: (busy: boolean) => void,
  ) {}

  /** Whether any question still has a change to save. */
  busy(): boolean {
    return this.entries.size > 0;
  }

  private update(apply: () => void): void {
    const before = this.busy();
    apply();
    const after = this.busy();
    if (before !== after) this.onBusyChange?.(after);
  }

  /** The flags to show while a change of `questionId` is being saved (null: none). */
  active(questionId: string): StudyFlags | null {
    return this.entries.get(questionId)?.desired ?? null;
  }

  /** A press on `questionId`, whose flags on screen are `base` unless a change is active. */
  toggle(questionId: string, base: StudyFlags, patch: FlagPatch): void {
    const prev = this.entries.get(questionId);
    const { entry, send } = intendFlags(prev, base, patch);
    this.update(() => {
      // Nothing in flight and nothing to send: no entry (the press restored the saved state).
      if (entry.sending) this.entries.set(questionId, { ...entry, saved: prev?.saved ?? null });
      else this.entries.delete(questionId);
    });
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
    this.update(() => {
      if (settled.done) this.entries.delete(questionId);
      else this.entries.set(questionId, { ...settled.entry, saved });
    });
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
    } else if (!sameFlags(flags, entry.desired)) {
      // More to save, but the server changed a field the user did not touch: show it.
      this.onEvent(questionId, { type: 'change', flags });
    }
    if (settled.send) void this.run(questionId, settled.send);
  }
}
