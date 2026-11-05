import { describe, expect, it, vi } from 'vitest';
import { bindRecoveryIdentity } from '../src/components/ask/ask-recovery-identity';
import { createAskRecoveryStore } from '../src/components/ask/ask-recovery-store';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ASK recovery identity', () => {
  it('fences late A failures during A to B and retains data on same-user refresh', async () => {
    const store = createAskRecoveryStore();
    let verified = 'A';
    const identity = bindRecoveryIdentity(store, async () => verified, vi.fn());
    await flush();
    const tokenA = store.token();
    store.add(tokenA, { workspaceId: 'w', conversationId: 'c', text: 'private A' });
    identity.event('TOKEN_REFRESHED', 'A');
    expect(store.getSnapshot()).toHaveLength(1);
    verified = 'B';
    identity.event('SIGNED_IN', 'B');
    expect(store.getSnapshot()).toHaveLength(0);
    store.add(tokenA, { workspaceId: 'w', conversationId: 'c', text: 'late A' });
    await flush();
    expect(store.getSnapshot()).toHaveLength(0);
    store.add(store.token(), { workspaceId: 'w', conversationId: 'c', text: 'B' });
    expect(store.getSnapshot()[0]?.text).toBe('B');
    identity.event('SIGNED_OUT', null);
    expect(store.getSnapshot()).toHaveLength(0);
    identity.close();
  });
  it('ignores stale claims after sign-out', async () => {
    const store = createAskRecoveryStore();
    let resolve!: (value: string | null) => void;
    const identity = bindRecoveryIdentity(
      store,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      vi.fn(),
    );
    identity.event('SIGNED_OUT', null);
    resolve('A');
    await flush();
    store.add(store.token(), { workspaceId: 'w', conversationId: null, text: 'stale' });
    expect(store.getSnapshot()).toHaveLength(0);
    identity.close();
  });
  it('does not activate an event identity until verified claims match it', async () => {
    const store = createAskRecoveryStore();
    const ready = vi.fn();
    const identity = bindRecoveryIdentity(store, async () => 'A', ready);
    await flush();
    identity.event('SIGNED_IN', 'B');
    await flush();
    store.add(store.token(), { workspaceId: 'w', conversationId: null, text: 'wrong owner' });
    expect(store.getSnapshot()).toHaveLength(0);
    expect(ready).toHaveBeenLastCalledWith(false);
    identity.close();
  });
  it('rechecks a changed server session without an auth event and preserves same-owner recovery', async () => {
    const store = createAskRecoveryStore();
    let cookieOwner = 'A';
    const identity = bindRecoveryIdentity(store, async () => cookieOwner, vi.fn());
    await flush();
    const tokenA = store.token();
    store.add(tokenA, { workspaceId: 'w', conversationId: 'c', text: 'A private' });
    expect(await store.verify()).toBe(true);
    expect(store.getSnapshot()).toHaveLength(1);
    cookieOwner = 'B';
    expect(await store.verify()).toBe(true);
    expect(store.getSnapshot()).toHaveLength(0);
    store.add(tokenA, { workspaceId: 'w', conversationId: 'c', text: 'late A' });
    expect(store.getSnapshot()).toHaveLength(0);
    identity.close();
  });
  it('does not expose recovery from a stale verification while a newer check is pending', async () => {
    const store = createAskRecoveryStore();
    const pending: ((id: string | null) => void)[] = [];
    const identity = bindRecoveryIdentity(
      store,
      () => new Promise((resolve) => pending.push(resolve)),
      vi.fn(),
    );
    pending.shift()?.('A');
    await flush();
    store.add(store.token(), { workspaceId: 'w', conversationId: null, text: 'A secret' });
    const older = store.verify();
    const newer = store.verify();
    pending.shift()?.('A');
    await flush();
    expect(store.getSnapshot()).toHaveLength(0);
    pending.shift()?.('B');
    pending.shift()?.('B');
    await Promise.all([older, newer]);
    expect(store.getSnapshot()).toHaveLength(0);
    identity.close();
  });
  it('hides but retains recovery on a temporary identity 500 until the same owner returns', async () => {
    const store = createAskRecoveryStore();
    const ready = vi.fn();
    let failure = false;
    const identity = bindRecoveryIdentity(
      store,
      async () => {
        if (failure) throw new Error('500');
        return 'A';
      },
      ready,
    );
    await flush();
    const token = store.token();
    store.add(token, { workspaceId: 'w', conversationId: null, text: 'draft' });
    failure = true;
    expect(await store.verify()).toBe(false);
    expect(store.getSnapshot()).toHaveLength(0);
    expect(store.valid(token)).toBe(true);
    expect(ready).not.toHaveBeenCalledWith(false);
    failure = false;
    expect(await store.verify()).toBe(true);
    expect(store.getSnapshot()[0]?.text).toBe('draft');
    identity.close();
  });
  it('coalesces concurrent verification requests without a retry storm', async () => {
    const store = createAskRecoveryStore();
    const pending: ((id: string | null) => void)[] = [];
    const verify = vi.fn(() => new Promise<string | null>((resolve) => pending.push(resolve)));
    const identity = bindRecoveryIdentity(store, verify, vi.fn());
    const callers = Array.from({ length: 15 }, () => store.verify());
    expect(verify).toHaveBeenCalledTimes(1);
    pending.shift()?.('A');
    await flush();
    expect(verify).toHaveBeenCalledTimes(2);
    pending.shift()?.('A');
    expect((await Promise.all(callers)).every(Boolean)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    identity.close();
  });
});
