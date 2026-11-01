// Per-browser DOC-02 viewer preferences (DOCVIEW: outline panel open/closed, PDF/text split).
// localStorage behind useSyncExternalStore: the server renders the default and the stored value
// takes over right after hydration. Storage may be blocked (private mode, previews); writes then
// last for this page only and reads fall back to the default.
import { useCallback, useSyncExternalStore } from 'react';

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    // Storage blocked: kept in memory for this page.
    memory.set(key, value);
  }
  for (const listener of listeners) listener();
}

/** The stored value of `key` (null on the server, before hydration and when none is stored). */
export function usePreference(key: string): [string | null, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback((next: string) => writePreference(key, next), [key]);
  return [value, set];
}

/** Whether `query` matches; null on the server and before hydration. */
export function useMediaQuery(query: string): boolean | null {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => null,
  );
}

/** Test helper: forget in-memory values. */
export function resetPreferencesForTests(): void {
  memory.clear();
}
