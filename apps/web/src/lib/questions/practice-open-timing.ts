// UX12-OPEN: the client side of the opening measurement (docs/screens/ux12-question-open.md). The
// entry names carry no ids: only durations reach the performance timeline.
export const PRACTICE_OPEN_MEASURE = 'practice-open';

/** How long a question reached by previous/next must stay on screen before it is opened. */
export const PRACTICE_NAVIGATION_PAUSE_MS = 150;

/** Records `name` from `start` (a `performance.now()` value) until now. */
export function measurePracticeOpen(name: string, start: number): void {
  try {
    performance.measure(name, { start, end: performance.now() });
  } catch {
    // Older browsers lack the options form; the measurement is never worth an error.
  }
}
