// @vitest-environment jsdom
// SEARCH-01-AC12 (UX7-SEARCH, QSEARCH-CACHE): the live 문제 search box. Commits non-empty text once
// typing pauses (350ms), commits immediately (0ms) when cleared to empty, never commits in the
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
  it('uses a 350ms debounce delay for non-empty queries', () => {
    expect(LIVE_QUERY_DELAY_MS).toBe(350);
  });

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
  return (
    <div>
      <input type="search" aria-label="문제 검색" {...query.inputProps} />
      <button type="button" onClick={() => query.flush()}>
        flush
      </button>
      <button type="button" onClick={() => query.replace('')}>
        reset
      </button>
    </div>
  );
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

  it('commits non-empty input after 350ms, only the last value, and clears immediately in 0ms', () => {
    const onCommit = vi.fn();
    render(<Box urlValue="" onCommit={onCommit} />);
    type('c');
    pause(349);
    expect(onCommit).not.toHaveBeenCalled();
    type('ch');
    pause(349);
    expect(onCommit).not.toHaveBeenCalled();
    type('chl ');
    pause(349);
    expect(onCommit).not.toHaveBeenCalled();
    pause(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith('chl');
    type('chl');
    pause();
    expect(onCommit).toHaveBeenCalledTimes(1); // same normalized value

    // Start typing a longer query, then clear before the timer fires: 0ms immediate commit of '',
    // and the cancelled timer never fires later.
    type('chlorine');
    expect(onCommit).toHaveBeenCalledTimes(1);
    type('');
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith('');
    pause(LIVE_QUERY_DELAY_MS * 2);
    expect(onCommit).toHaveBeenCalledTimes(2);

    // Clearing to whitespace-only also normalizes to '' and commits in 0ms.
    type('water');
    pause();
    expect(onCommit).toHaveBeenCalledTimes(3);
    expect(onCommit).toHaveBeenLastCalledWith('water');
    type('   ');
    expect(onCommit).toHaveBeenCalledTimes(4);
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

  it('does not commit or flush while an IME composition is in progress, then commits after 350ms or 0ms on empty', () => {
    const onCommit = vi.fn();
    render(<Box urlValue="이전" onCommit={onCommit} />);

    // Even if intermediate IME updates become empty or flush() is called, nothing commits mid-IME.
    fireEvent.compositionStart(box());
    type('');
    fireEvent.click(screen.getByRole('button', { name: 'flush' }));
    type('ㅇ');
    type('여');
    type('염');
    pause(LIVE_QUERY_DELAY_MS * 4);
    expect(onCommit).not.toHaveBeenCalled();
    expect(box().value).toBe('염');

    // Non-empty compositionend schedules the 350ms debounce.
    fireEvent.compositionEnd(box(), { data: '염' });
    pause(349);
    expect(onCommit).not.toHaveBeenCalled();
    pause(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith('염');

    // Composition ending empty commits immediately in 0ms without advancing timers.
    fireEvent.compositionStart(box());
    type('');
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(box(), { data: '' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith('');
  });

  it('keeps committedRef and pending writes consistent across replace()', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Box urlValue="chlorine" onCommit={onCommit} />);

    type('chlorine extra');
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(box().value).toBe('');
    pause(LIVE_QUERY_DELAY_MS * 2);
    expect(onCommit).not.toHaveBeenCalled();

    // User immediately starts typing again before the URL catches up with the reset to '':
    // when urlValue='' arrives, it settles as ours instead of clobbering the new input.
    type('염소');
    rerender(<Box urlValue="" onCommit={onCommit} />);
    expect(box().value).toBe('염소');
    pause();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith('염소');
  });
});
