import type { AskRecoveryStore } from './ask-recovery-store';

/** Serializes server checks; only verified claims may expose the owner's local outbox. */
export function bindRecoveryIdentity(
  recovery: AskRecoveryStore,
  verify: () => Promise<string | null>,
  onReady: (ready: boolean) => void,
) {
  let owner: string | null = null;
  let enabled = false;
  let revision = 0;
  let closed = false;
  let signedOut = false;
  let running: Promise<boolean> | null = null;
  let refresh = false;
  let expected: string | null = null;
  const check = (): Promise<boolean> => {
    recovery.hide();
    if (running) {
      refresh = true;
      return running;
    }
    const run = async () => {
      let id: string | null = null;
      let unavailable: boolean;
      do {
        refresh = false;
        const request = revision;
        try {
          id = await verify();
          unavailable = false;
        } catch {
          unavailable = true;
        }
        if (closed || signedOut) return false;
        if (request !== revision) refresh = true;
      } while (refresh);
      if (unavailable) return false;
      if (!id) {
        owner = null;
        if (enabled) {
          enabled = false;
          recovery.deactivate();
          onReady(false);
        }
        return false;
      }
      if (enabled && owner !== id) {
        enabled = false;
        recovery.deactivate();
        onReady(false);
      }
      owner = id;
      if (expected && id !== expected) return false;
      expected = null;
      recovery.activate();
      enabled = true;
      onReady(true);
      return true;
    };
    running = run().finally(() => {
      running = null;
    });
    return running;
  };
  recovery.deactivate();
  recovery.setVerifier(check);
  void check();
  return {
    event(event: string, id: string | null) {
      if (
        event === 'SIGNED_OUT' ||
        ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && id !== owner)
      ) {
        const hadOwner = enabled;
        enabled = false;
        owner = null;
        signedOut = event === 'SIGNED_OUT';
        recovery.deactivate();
        if (hadOwner) onReady(false);
        revision += 1;
        expected = event === 'SIGNED_OUT' ? null : id;
        if (event !== 'SIGNED_OUT' && id)
          queueMicrotask(() => {
            if (!closed) void check();
          });
      }
    },
    close() {
      closed = true;
      revision += 1;
      recovery.deactivate();
    },
  };
}
