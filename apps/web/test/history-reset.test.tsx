// @vitest-environment jsdom
import './dom-setup';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const list = vi.fn(async () => ({ items: [], next_cursor: null }));
vi.mock('../src/lib/history/client', () => ({
  createHistoryClient: () => ({ list }),
  retryFailureMessage: () => '',
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const { setPracticeViewer } = await import('../src/lib/questions/practice-reset-events');
const { HistoryPanel } = await import('../src/components/history/history-panel');

afterEach(() => {
  setPracticeViewer(null);
  vi.unstubAllGlobals();
  list.mockClear();
});

it('reloads history when another tab resets a question', async () => {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    close = vi.fn();
    constructor() {
      channels.push(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  setPracticeViewer('user-a');
  render(<HistoryPanel workspaceId="workspace" viewerId="user-a" />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  act(() => {
    channels[0]?.onmessage?.({ data: { viewerId: 'user-a', epochs: { question: 1 } } });
  });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(6));
});
