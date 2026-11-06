// UX9-RETRY-OPT: the optimistic favorite / retry state machine (flag-sync.ts).
import { describe, expect, it, vi } from 'vitest';
import {
  FlagSync,
  flagDiff,
  intendFlags,
  settleFlags,
  type FlagEvent,
  type FlagPatch,
  type FlagResult,
  type StudyFlags,
} from '../src/lib/questions/flag-sync';

const OFF: StudyFlags = { is_favorite: false, needs_retry: false };

describe('flag state machine', () => {
  it('a press shows at once and starts one request with only the changed field', () => {
    const { entry, send } = intendFlags(undefined, OFF, { needs_retry: true });
    expect(entry.desired).toEqual({ is_favorite: false, needs_retry: true });
    expect(entry.confirmed).toEqual(OFF);
    expect(send).toEqual({ needs_retry: true });
  });

  it('presses while a request is in flight start nothing and are coalesced', () => {
    let { entry } = intendFlags(undefined, OFF, { needs_retry: true });
    ({ entry } = intendFlags(entry, OFF, { needs_retry: false }));
    const third = intendFlags(entry, OFF, { is_favorite: true });
    expect(third.send).toBeNull();
    const settled = settleFlags(third.entry, {
      ok: true,
      flags: { is_favorite: false, needs_retry: true },
    });
    // The response (retry on) is older than the intent (retry off, favorite on).
    expect(settled.entry.desired).toEqual({ is_favorite: true, needs_retry: false });
    expect(settled.send).toEqual({ is_favorite: true, needs_retry: false });
    expect(settled.done).toBe(false);
  });

  it('nothing more is sent when the intent returns to the saved state', () => {
    let { entry } = intendFlags(undefined, OFF, { is_favorite: true });
    ({ entry } = intendFlags(entry, OFF, { is_favorite: false }));
    const settled = settleFlags(entry, { ok: true, flags: OFF });
    expect(settled).toMatchObject({ send: null, done: true });
    expect(settled.entry.desired).toEqual(OFF);
  });

  it('a failure rolls back only the fields it carried', () => {
    let { entry } = intendFlags(undefined, OFF, { needs_retry: true });
    ({ entry } = intendFlags(entry, OFF, { is_favorite: true }));
    const settled = settleFlags(entry, { ok: false });
    expect(settled.entry.desired).toEqual({ is_favorite: true, needs_retry: false });
    expect(settled.send).toEqual({ is_favorite: true });
  });

  it('a field the user did not press takes the server value (another tab changed it)', () => {
    // This screen loaded retry off; another tab turned it on. Only favorite is pressed here.
    const { entry, send } = intendFlags(undefined, OFF, { is_favorite: true });
    expect(send).toEqual({ is_favorite: true });
    const settled = settleFlags(entry, {
      ok: true,
      flags: { is_favorite: true, needs_retry: true },
    });
    expect(settled.entry.desired).toEqual({ is_favorite: true, needs_retry: true });
    expect(settled).toMatchObject({ send: null, done: true });
  });

  it('a newer press of one field still goes while the other follows the server', () => {
    let { entry } = intendFlags(undefined, OFF, { is_favorite: true });
    ({ entry } = intendFlags(entry, OFF, { is_favorite: false }));
    const settled = settleFlags(entry, {
      ok: true,
      flags: { is_favorite: true, needs_retry: true },
    });
    expect(settled.entry.desired).toEqual({ is_favorite: false, needs_retry: true });
    expect(settled.send).toEqual({ is_favorite: false });
  });

  it('flagDiff lists only differing fields', () => {
    expect(flagDiff(OFF, OFF)).toEqual({});
    expect(flagDiff(OFF, { is_favorite: true, needs_retry: false })).toEqual({ is_favorite: true });
  });
});

describe('FlagSync', () => {
  function setup() {
    const calls: { qid: string; patch: FlagPatch; resolve: (r: FlagResult<StudyFlags>) => void }[] =
      [];
    const send = vi.fn(
      (qid: string, patch: FlagPatch) =>
        new Promise<FlagResult<StudyFlags>>((resolve) => calls.push({ qid, patch, resolve })),
    );
    const events: [string, FlagEvent<StudyFlags>][] = [];
    const sync = new FlagSync<StudyFlags>(send, (qid, e) => events.push([qid, e]), 'failed');
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { calls, send, events, sync, flush };
  }

  it('UX12-RETRYOPEN settled waits for every queued change of that question only', async () => {
    const { calls, sync, flush } = setup();
    let done = false;
    await sync.settled('q');
    sync.toggle('q', OFF, { needs_retry: true });
    sync.toggle('q', OFF, { is_favorite: true });
    void sync.settled('q').then(() => {
      done = true;
    });
    await sync.settled('other');
    calls[0]?.resolve({ ok: true, data: { ...OFF, needs_retry: true } });
    await flush();
    expect(done).toBe(false);
    calls[1]?.resolve({ ok: true, data: { is_favorite: true, needs_retry: true } });
    await flush();
    expect(done).toBe(true);
  });

  it('UX12-RETRYOPEN settled also ends on a failure and on a reset', async () => {
    const { calls, sync, flush } = setup();
    let ended = 0;
    sync.toggle('q', OFF, { needs_retry: true });
    void sync.settled('q').then(() => (ended += 1));
    calls[0]?.resolve({ ok: false, message: 'no' });
    await flush();
    expect(ended).toBe(1);
    sync.toggle('q', OFF, { needs_retry: true });
    void sync.settled('q').then(() => (ended += 1));
    sync.invalidate('q');
    await flush();
    expect(ended).toBe(2);
  });

  it('drops a pre-reset response without affecting a fresh flag change', async () => {
    const { calls, events, sync, flush } = setup();
    sync.toggle('q', OFF, { is_favorite: true });
    sync.invalidate('q');
    sync.toggle('q', OFF, { needs_retry: true });
    expect(calls).toHaveLength(2);
    const count = events.length;
    calls[0]?.resolve({ ok: true, data: { is_favorite: true, needs_retry: false } });
    await flush();
    expect(events).toHaveLength(count);
    calls[1]?.resolve({ ok: true, data: { is_favorite: false, needs_retry: true } });
    await flush();
    expect(events.at(-1)?.[1]).toMatchObject({
      type: 'saved',
      flags: { is_favorite: false, needs_retry: true },
    });
  });

  it('never has two requests of one question in flight, so responses cannot arrive out of order', async () => {
    const { calls, events, sync, flush } = setup();
    sync.toggle('q', OFF, { needs_retry: true });
    sync.toggle('q', OFF, { needs_retry: false });
    sync.toggle('q', OFF, { needs_retry: true });
    expect(calls).toHaveLength(1);
    expect(sync.active('q')).toEqual({ is_favorite: false, needs_retry: true });
    calls[0]?.resolve({ ok: true, data: { is_favorite: false, needs_retry: true } });
    await flush();
    expect(calls).toHaveLength(1);
    expect(sync.active('q')).toBeNull();
    expect(events.map(([, e]) => e.type)).toEqual(['change', 'change', 'change', 'saved']);
    expect(events.at(-1)?.[1].flags).toEqual({ is_favorite: false, needs_retry: true });
  });

  it('the last press wins over an older response', async () => {
    const { calls, events, sync, flush } = setup();
    sync.toggle('q', OFF, { needs_retry: true });
    sync.toggle('q', OFF, { needs_retry: false });
    calls[0]?.resolve({ ok: true, data: { is_favorite: false, needs_retry: true } });
    await flush();
    // No event flips the toggle back to the older response.
    expect(events.map(([, e]) => e.type)).toEqual(['change', 'change']);
    expect(calls[1]?.patch).toEqual({ needs_retry: false });
    calls[1]?.resolve({ ok: true, data: OFF });
    await flush();
    expect(events.at(-1)?.[1]).toMatchObject({ type: 'saved', flags: OFF });
  });

  it('a failure (or a thrown request) rolls back, reports, and remembers what was saved', async () => {
    const { calls, send, events, sync, flush } = setup();
    sync.toggle('q', OFF, { needs_retry: true });
    calls[0]?.resolve({ ok: true, data: { is_favorite: false, needs_retry: true } });
    await flush();
    send.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    sync.toggle('q', { is_favorite: false, needs_retry: true }, { is_favorite: true });
    await flush();
    expect(events.at(-1)?.[1]).toEqual({
      type: 'failed',
      flags: { is_favorite: false, needs_retry: true },
      message: 'failed',
      pending: false,
      saved: null,
    });
    expect(sync.active('q')).toBeNull();
  });

  it('a response that changes an untouched field is shown while more is still being saved', async () => {
    const { calls, events, sync, flush } = setup();
    sync.toggle('q', OFF, { is_favorite: true });
    sync.toggle('q', OFF, { is_favorite: false });
    calls[0]?.resolve({ ok: true, data: { is_favorite: true, needs_retry: true } });
    await flush();
    expect(events.at(-1)?.[1]).toEqual({
      type: 'change',
      flags: { is_favorite: false, needs_retry: true },
    });
    expect(calls[1]?.patch).toEqual({ is_favorite: false });
  });

  it('questions are independent', async () => {
    const { calls, sync } = setup();
    sync.toggle('a', OFF, { is_favorite: true });
    sync.toggle('b', OFF, { is_favorite: true });
    expect(calls.map((c) => c.qid)).toEqual(['a', 'b']);
  });
});
