'use client';

// Whether the workspace takes new AI questions (ASK-01 GET /workspaces/{id}/ask), read once per
// home. Callers hide new-action entry points until the current workspace state is known.
import { useEffect, useMemo, useState } from 'react';
import { createAskClient, type AskClient, type AskState } from '@/lib/ask/client';

export function useAskState(workspaceId: string): {
  readonly state: AskState | null;
  readonly client: AskClient;
} {
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
  return { state: result?.workspaceId === workspaceId ? result.state : null, client };
}
