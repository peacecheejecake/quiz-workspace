'use client';

// The workspace home's dialog history (UX7-BACK, UX7-BACK-2, lib/workspaces/panel-history.ts):
// push on open; every close (button or Back) drops the closed dialog's entries, so neither Back
// nor Forward ever reopens it (QOV-01-AC14).
import { useEffect, useRef, useState } from 'react';
import {
  type DialogUrls,
  PanelHistory,
  type PanelHistoryWindow,
} from '@/lib/workspaces/panel-history';

/** The browser window as PanelHistory uses it (read lazily: Next patches `history` methods). */
function browserWindow(): PanelHistoryWindow {
  return {
    history: window.history,
    location: window.location,
    get navigation() {
      return 'navigation' in window ? window.navigation : undefined;
    },
    // The getter may throw (storage blocked): PanelHistory reads it inside try/catch.
    get sessionStorage() {
      return window.sessionStorage;
    },
    addEventListener: (type, listener, options) =>
      window.addEventListener(type, listener as EventListener, options),
    removeEventListener: (type, listener, options) =>
      window.removeEventListener(type, listener as EventListener, options),
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    now: () => Date.now(),
  };
}

/** `dialogs` may change every render (it reads the page's content search); the latest is used. */
export function usePanelHistory(dialogs: DialogUrls): PanelHistory {
  const dialogsRef = useRef(dialogs);
  useEffect(() => {
    dialogsRef.current = dialogs;
  });
  const [history] = useState(() => {
    let win: PanelHistoryWindow | null = null;
    return new PanelHistory(
      () => (win ??= browserWindow()),
      () => dialogsRef.current,
    );
  });
  useEffect(() => history.attach(), [history]);
  // Router navigations (the heatmap re-read, refreshes) drop the entry's marks: put them back.
  useEffect(() => {
    history.stamp();
  });
  return history;
}
