// UX12-OPEN: the client side of the opening measurement (docs/screens/ux12-question-open.md). The
// entry names carry no ids: only durations reach the performance timeline.
export const PRACTICE_OPEN_MEASURE = 'practice-open';

/** Records `name` from `start` (a `performance.now()` value) until now. */
export function measurePracticeOpen(name: string, start: number): void {
  try {
    performance.measure(name, { start, end: performance.now() });
  } catch {
    // Older browsers lack the options form; the measurement is never worth an error.
  }
}
