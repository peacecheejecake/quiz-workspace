// SEARCH-01-AC12 live 문제 search (docs/screens/search.md, UX7-SEARCH): pure parts of the
// "filter as you type" box. The box commits its value to the URL after a pause (debounce); the URL
// later reports the value back. A reported value is "ours" when it is one we committed and has not
// been seen yet (the box must then keep what the user typed since), anything else came from outside
// (browser Back/Forward, a reset) and replaces the box.

/** Pause after the last keystroke before the heatmap is re-read. */
export const LIVE_QUERY_DELAY_MS = 250;

/** Committed values remembered until the URL reports them (older ones are dropped). */
export const MAX_PENDING_WRITES = 20;

/** The value a query box commits: trimmed and capped. */
export function normalizeQuery(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * Whether `reported` (the URL's value) is one of our `pending` writes, and the writes still
 * pending after it: a write the router superseded is never reported, so everything up to the
 * reported one is settled.
 */
export function settleWrites(
  pending: readonly string[],
  reported: string,
): { readonly ours: boolean; readonly pending: readonly string[] } {
  const index = pending.lastIndexOf(reported);
  if (index < 0) return { ours: false, pending: [] };
  return { ours: true, pending: pending.slice(index + 1) };
}

/** `pending` after committing `value` while the URL shows `current`. */
export function addWrite(
  pending: readonly string[],
  value: string,
  current: string,
): readonly string[] {
  // Back to what the URL already shows: no new report will come, and any write in flight is
  // superseded by this one.
  if (value === current) return [];
  return [...pending, value].slice(-MAX_PENDING_WRITES);
}
