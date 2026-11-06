// UX12-PDFPREVIEW: is a question open whose answer is still hidden? The practice and run viewers hold
// this while their position is unsubmitted. A layer that lives elsewhere in the tree (the AI 질문
// panel, which can reach any book page) reads it instead of opening a PDF over that question.
import { useEffect, useSyncExternalStore } from 'react';

let holds = 0;
const listeners = new Set<() => void>();

function change(by: 1 | -1): void {
  holds += by;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** While `active`, the answer of a question on screen is hidden. */
export function useHoldAnswerGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    change(1);
    return () => change(-1);
  }, [active]);
}

/** True while any viewer holds the guard (also before hydration: nothing is known yet). */
export function useAnswerGuarded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => holds > 0,
    () => true,
  );
}
