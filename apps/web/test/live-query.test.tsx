// @vitest-environment jsdom
// SEARCH-01-AC12 (UX7-SEARCH): the live 문제 search box. Commits once typing pauses, never in the
// middle of an IME composition, keeps what the user typed while its own commits come back through
// the URL, and follows the URL when it changes from outside (Back/Forward).
import './dom-setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveQuery } from '../src/components/search/use-live-query';
import {
  addWrite,
  LIVE_QUERY_DELAY_MS,
  normalizeQuery,
  settleWrites,
} from '../src/lib/search/live-query';

describe('live query writes', () => {
  it('normalizes like the URL does', () => {
    expect(normalizeQuery('  염소 ', 200)).toBe('염소');
    expect(normalizeQuery('x'.repeat(300), 200)).toHaveLength(200);
  });

  it('recognises our own commits as they come back, settling superseded ones', () => {
    const pending = addWrite(addWrite([], 'a', ''), 'ab', '');
    expect(pending).toEqual(['a', 'ab']);
    // The router dropped the navigation for "a": "ab" comes back and settles both.
    expect(settleWrites(pending, 'ab')).toEqual({ ours: true, pending: [] });
    expect(settleWrites(pending, 'a')).toEqual({ ours: true, pending: ['ab'] });
    // Anything else came from outside.
    expect(settleWrites(pending, 'zzz')).toEqual({ ours: false, pending: [] });
    // Committing what the URL already shows expects no report and supersedes what is in flight.
    expect(addWrite(['a', 'ab'], 'x', 'x')).toEqual([]);
  });
});

function Box({ urlValue, onCommit }: { urlValue: string; onCommit: (q: string) => void }) {
  const query = useLiveQuery({ urlValue, max: 200, onCommit });
  return <input type="search" aria-label="문제 검색" {...query.inputProps} />;
}

describe('useLiveQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const box = () => screen.getByRole('searchbox', { name: '문제 검색' }) as HTMLInputElement;
  const type = (value: string) => fireEvent.change(box(), { target: { value } });
  const pause = (ms = LIVE_QUERY_DELAY_MS) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('commits once typing pauses, only the last value, and not twice', () => {
    const onCommit = vi.fn();
    render(<Box urlValue="" onCommit={onCommit} />);
    type('c');
    pause(LIVE_QUERY_DELAY_MS - 50);
    type('ch');
    pause(LIVE_QUERY_DELAY_MS - 50);
    expect(onCommit).not.toHaveBeenCalled();
    type('chl ');
    pause();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith('chl');
    type('chl');
    pause();
    expect(onCommit).toHaveBeenCalledTimes(1); // same normalized value
    type('');
    pause();
    expect(onCommit).toHaveBeenLastCalledWith('');
  });

  it('keeps what the user typed while its own commits come back through the URL', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Box urlValue="" onCommit={onCommit} />);
    type('chl');
    pause();
    type('chlorine');
    // The URL catches up with the first commit while the user is already further.
    rerender(<Box urlValue="chl" onCommit={onCommit} />);
    expect(box().value).toBe('chlorine');
    pause();
    expect(onCommit).toHaveBeenLastCalledWith('chlorine');
    rerender(<Box urlValue="chlorine" onCommit={onCommit} />);
    expect(box().value).toBe('chlorine');
  });

  it('follows the URL when it changes from outside, dropping a pending commit', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Box urlValue="chlorine" onCommit={onCommit} />);
    expect(box().value).toBe('chlorine');
    type('chlorine x');
    rerender(<Box urlValue="water" onCommit={onCommit} />); // browser Back
    expect(box().value).toBe('water');
    pause();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not filter while an IME composition is in progress, then commits the composed text', () => {
    const onCommit = vi.fn();
    render(<Box urlValue="" onCommit={onCommit} />);
    fireEvent.compositionStart(box());
    type('ㅇ');
    type('여');
    type('염');
    pause(LIVE_QUERY_DELAY_MS * 4);
    expect(onCommit).not.toHaveBeenCalled();
    expect(box().value).toBe('염');
    fireEvent.compositionEnd(box(), { data: '염' });
    pause();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith('염');
  });
});
