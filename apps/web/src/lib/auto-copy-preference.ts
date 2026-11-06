// The drag auto-copy setting (UX12-SETTINGS, decision D-5): per browser, off by default. Storage
// can throw (blocked site data, private windows), which reads as off.
const STORAGE_KEY = 'quiz-auto-copy';

const listeners = new Set<() => void>();

export function readAutoCopy(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeAutoCopy(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, 'on');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to keep: the switch shows what `readAutoCopy` reads back.
  }
  for (const listener of listeners) listener();
}

/** Changes from this tab (`writeAutoCopy`) and from others (`storage`). */
export function subscribeAutoCopy(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}
