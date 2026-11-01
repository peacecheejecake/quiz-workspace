'use client';

// The workspace home's dialog history (UX7-BACK, lib/workspaces/panel-history.ts): push on open,
// rewind on close, so Back after a close never reopens the dialog (QOV-01-AC14).
import { useEffect, useState } from 'react';
import { PanelHistory } from '@/lib/workspaces/panel-history';

export function usePanelHistory(): PanelHistory {
  const [history] = useState(() => new PanelHistory(() => window));
  useEffect(() => history.attach(), [history]);
  // Router navigations (the heatmap re-read, refreshes) drop the entry's depth: put it back.
  useEffect(() => {
    history.stamp();
  });
  return history;
}
