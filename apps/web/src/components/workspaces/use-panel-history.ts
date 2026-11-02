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
    history: {
      get state(): unknown {
        return window.history.state;
      },
      // The scroll restoration mode belongs to each entry and a pushed entry inherits it: the
      // entries of an open/close are "manual", so traversing between them (Back, a close's
      // rewind) never moves the page (useManualScrollWhile).
      pushState: (data, unused, url) => {
        window.history.scrollRestoration = 'manual';
        window.history.pushState(data, unused, url);
      },
      replaceState: (data, unused, url) => window.history.replaceState(data, unused, url),
      go: (delta) => window.history.go(delta),
    },
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
    arrivedByTraversal: () => {
      // The navigation type is the document's: it tells only about the first home it shows.
      const first = !attachedInDocument;
      attachedInDocument = true;
      const [entry] = performance.getEntriesByType('navigation');
      return first && (entry as PerformanceNavigationTiming | undefined)?.type === 'back_forward';
    },
  };
}

/** Whether a home of this document attached already (see arrivedByTraversal). */
let attachedInDocument = false;

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

/** How long after the last dialog closed the browser's own scroll restoration stays off. */
const SCROLL_SETTLE_MS = 1000;

// Module state: a close's traversal can remount the home, so component state would lose it.
let savedRestoration: ScrollRestoration | null = null;
let restoreTimer: number | null = null;

function holdManualScroll() {
  if (restoreTimer !== null) window.clearTimeout(restoreTimer);
  restoreTimer = null;
  savedRestoration ??= window.history.scrollRestoration;
  window.history.scrollRestoration = 'manual';
}

function releaseManualScroll() {
  if (savedRestoration === null) return;
  if (restoreTimer !== null) window.clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => {
    restoreTimer = null;
    if (savedRestoration !== null) window.history.scrollRestoration = savedRestoration;
    savedRestoration = null;
  }, SCROLL_SETTLE_MS);
}

/**
 * Keeps the browser from moving the page while dialogs open and close through history
 * (HOMEDLG-01-AC03: the home stays where it was). Closing a dialog traverses history (Back, or the
 * close's rewind); WebKit then restores the scroll position it saved for the entry when it was
 * written, which is stale, and jumped to the top. While a dialog is open — the page cannot scroll
 * then (the modal lock) — and for a moment after the last one closed (the close's traversals),
 * restoration is off.
 */
export function useManualScrollWhile(dialogsOpen: boolean): void {
  useEffect(() => {
    if (!dialogsOpen) return undefined;
    holdManualScroll();
    return releaseManualScroll;
  }, [dialogsOpen]);
}
