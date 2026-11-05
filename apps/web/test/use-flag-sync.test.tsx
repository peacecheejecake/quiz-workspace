// @vitest-environment jsdom
// UX9-RETRY-OPT (user decision 2026-11-02): while a favorite / retry save is in flight, leaving
// or reloading the page asks the browser's standard beforeunload confirmation; never otherwise.
import './dom-setup';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { publishPracticeReset } from '../src/lib/questions/practice-reset-events';
import type { FlagResult, StudyFlags } from '../src/lib/questions/flag-sync';
import { useFlagSync } from '../src/components/questions/viewer/use-flag-sync';

const OFF: StudyFlags = { is_favorite: false, needs_retry: false };

function leave(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function setup() {
  const held: ((r: FlagResult<StudyFlags>) => void)[] = [];
  const hook = renderHook(() =>
    useFlagSync<StudyFlags>(
      () => new Promise((resolve) => held.push(resolve)),
      () => undefined,
    ),
  );
  return { held, hook };
}

describe('useFlagSync beforeunload guard', () => {
  it('invalidates in-flight saves on reset and accepts a new save afterward', async () => {
    const held: ((r: FlagResult<StudyFlags>) => void)[] = [];
    const events = vi.fn();
    const hook = renderHook(() =>
      useFlagSync<StudyFlags>(
        () => new Promise((resolve) => held.push(resolve)),
        events,
        'workspace',
      ),
    );
    act(() => hook.result.current.toggle('question', OFF, { is_favorite: true }));
    act(() => publishPracticeReset('workspace', { question: 1 }));
    expect(hook.result.current.active('question')).toBeNull();
    act(() => hook.result.current.toggle('question', OFF, { needs_retry: true }));
    const before = events.mock.calls.length;
    await act(async () => held[0]?.({ ok: true, data: { ...OFF, is_favorite: true } }));
    expect(events).toHaveBeenCalledTimes(before);
    await act(async () => held[1]?.({ ok: true, data: { ...OFF, needs_retry: true } }));
    expect(events.mock.calls.at(-1)?.[1]).toMatchObject({
      type: 'saved',
      flags: { needs_retry: true },
    });
  });

  it('asks to confirm leaving only while a save is in flight', async () => {
    const { held, hook } = setup();
    expect(leave()).toBe(false);
    act(() => hook.result.current.toggle('q', OFF, { needs_retry: true }));
    expect(leave()).toBe(true);
    act(() => hook.result.current.toggle('q', OFF, { needs_retry: false }));
    await act(async () => held[0]?.({ ok: true, data: { ...OFF, needs_retry: true } }));
    // The coalesced second request is still in flight.
    expect(leave()).toBe(true);
    await act(async () => held[1]?.({ ok: true, data: OFF }));
    expect(leave()).toBe(false);
  });

  it('one screen finishing its save keeps the guard of another still saving', async () => {
    const a = setup();
    const b = setup();
    act(() => a.hook.result.current.toggle('q', OFF, { is_favorite: true }));
    act(() => b.hook.result.current.toggle('q', OFF, { is_favorite: true }));
    await act(async () => a.held[0]?.({ ok: true, data: { ...OFF, is_favorite: true } }));
    expect(leave()).toBe(true);
    await act(async () => b.held[0]?.({ ok: true, data: { ...OFF, is_favorite: true } }));
    expect(leave()).toBe(false);
  });

  it('a failed save releases the guard too, and unmounting removes it', async () => {
    const { held, hook } = setup();
    act(() => hook.result.current.toggle('q', OFF, { is_favorite: true }));
    await act(async () => held[0]?.({ ok: false, message: 'x' }));
    expect(leave()).toBe(false);
    act(() => hook.result.current.toggle('q', OFF, { is_favorite: true }));
    expect(leave()).toBe(true);
    hook.unmount();
    expect(leave()).toBe(false);
  });
});
