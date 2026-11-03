'use client';

// Whether the workspace takes new AI questions (ASK-01 GET /workspaces/{id}/ask), read once per
// home. Until it answers, only an archived workspace counts as unavailable; the panel shows the
// server's reason either way.
import { useEffect, useMemo, useState } from 'react';
import { createAskClient, type AskClient, type AskState } from '@/lib/ask/client';

export function useAskState(workspaceId: string): {
  readonly state: AskState | null;
  readonly client: AskClient;
} {
  const client = useMemo(() => createAskClient(), []);
  const [state, setState] = useState<AskState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.state(workspaceId, controller.signal).then(
      (next) => setState(next),
      () => undefined, // The panel re-reads it; entry points stay usable meanwhile.
    );
    return () => controller.abort();
  }, [client, workspaceId]);
  return { state, client };
}
