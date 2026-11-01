'use client';

// The workspace home's dialog history (UX7-BACK, UX7-BACK-2, lib/workspaces/panel-history.ts):
// push on open; every close (button or Back) drops the closed dialog's entries, so neither Back
// nor Forward ever reopens it (QOV-01-AC14).
import { useEffect, useRef, useState } from 'react';
import { type DialogUrls, PanelHistory } from '@/lib/workspaces/panel-history';

/** `dialogs` may change every render (it reads the page's content search); the latest is used. */
export function usePanelHistory(dialogs: DialogUrls): PanelHistory {
  const dialogsRef = useRef(dialogs);
  useEffect(() => {
    dialogsRef.current = dialogs;
  });
  const [history] = useState(
    () =>
      new PanelHistory(
        () => window,
        () => dialogsRef.current,
      ),
  );
  useEffect(() => history.attach(), [history]);
  // Router navigations (the heatmap re-read, refreshes) drop the entry's marks: put them back.
  useEffect(() => {
    history.stamp();
  });
  return history;
}
