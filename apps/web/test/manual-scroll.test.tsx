// @vitest-environment jsdom
// HOMEDLG-01-AC03 (UX9-MODAL): the home's dialog history entries are "manual" for scroll
// restoration while dialogs open and close, and the browser's own mode comes back once the last
// dialog has closed — the push that opens a dialog must not make "manual" the mode to restore.
import './dom-setup';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelHistory } from '../src/lib/workspaces/panel-history';
import {
  useManualScrollWhile,
  usePanelHistory,
} from '../src/components/workspaces/use-panel-history';

const captured: { history: PanelHistory | null } = { history: null };

function Home({ open }: { open: boolean }) {
  const history = usePanelHistory({
    open: (search) => new URLSearchParams(search).getAll('panel'),
    close: (search) => search,
    closeAll: () => '',
    read: () => undefined,
  });
  useEffect(() => {
    captured.history = history;
  });
  useManualScrollWhile(open);
  return null;
}

describe('dialog history scroll restoration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/workspaces/w');
    window.history.scrollRestoration = 'auto';
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    captured.history = null;
  });

  it('is manual while a dialog is open and back to auto after the last one closed', () => {
    const view = render(<Home open={false} />);
    act(() => captured.history?.push('/workspaces/w?panel=documents'));
    view.rerender(<Home open />);
    expect(window.history.scrollRestoration).toBe('manual');
    view.rerender(<Home open={false} />);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('a push made after the dialogs closed is restored as well', () => {
    const view = render(<Home open={false} />);
    act(() => captured.history?.push('/workspaces/w?panel=documents'));
    view.rerender(<Home open />);
    view.rerender(<Home open={false} />);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => captured.history?.push('/workspaces/w?panel=history'));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(window.history.scrollRestoration).toBe('auto');
  });
});
