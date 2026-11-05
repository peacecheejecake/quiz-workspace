'use client';

// Whether the workspace takes new AI questions (ASK-01 GET /workspaces/{id}/ask), read once per
// home. Callers hide new-action entry points until the current workspace state is known.
import { useEffect, useMemo, useState } from 'react';
import { bindRecoveryIdentity } from './ask-recovery-identity';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { createAskRecoveryStore, type AskRecoveryStore } from './ask-recovery-store';
import { createAskClient, type AskClient, type AskState } from '@/lib/ask/client';

export function useAskState(workspaceId: string): {
  readonly state: AskState | null;
  readonly client: AskClient;
  readonly recovery: AskRecoveryStore;
  readonly identityGeneration: number;
} {
  const recovery = useMemo(() => createAskRecoveryStore(), []);
  const [identityReady, setIdentityReady] = useState(false);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  useEffect(() => {
    const auth = getSupabaseBrowserClient().auth;
    const identity = bindRecoveryIdentity(
      recovery,
      async () => {
        const response = await fetch('/api/auth/identity', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('Identity unavailable');
        const body: unknown = await response.json();
        return typeof body === 'object' &&
          body !== null &&
          'id' in body &&
          typeof body.id === 'string'
          ? body.id
          : null;
      },
      (ready) => {
        setIdentityReady(ready);
        if (!ready) setIdentityGeneration((generation) => generation + 1);
      },
    );
    const { data } = auth.onAuthStateChange((event, session) => {
      identity.event(event, session?.user.id ?? null);
    });
    const revalidate = () => {
      if (document.visibilityState === 'visible') void recovery.verify();
    };
    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pageshow', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
      data.subscription.unsubscribe();
      identity.close();
    };
  }, [recovery]);
  const client = useMemo(() => createAskClient(), []);
  const [result, setResult] = useState<{ workspaceId: string; state: AskState } | null>(null);
  useEffect(() => {
    setResult(null);
    const controller = new AbortController();
    client.state(workspaceId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setResult({ workspaceId, state: next });
      },
      () => undefined, // Unknown capability keeps new-action entry points hidden.
    );
    return () => controller.abort();
  }, [client, workspaceId]);
  return {
    state: identityReady && result?.workspaceId === workspaceId ? result.state : null,
    client,
    recovery,
    identityGeneration,
  };
}
