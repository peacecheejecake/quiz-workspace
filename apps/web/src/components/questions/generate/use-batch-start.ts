'use client';

// Starts a batch variant generation (QGEN-MULTI) and goes to its results page. One
// Idempotency-Key per request body until it succeeds, so a retry after a lost response returns
// the same batch instead of starting another one.
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  batchPath,
  createGenerationClient,
  GenerationApiError,
  type GenerationBatchCreate,
} from '@/lib/questions/generation-client';
import { batchKey } from '@/lib/questions/generation-model';

export function useBatchStart(workspaceId: string, returnTo: string) {
  const router = useRouter();
  const client = useMemo(() => createGenerationClient(), []);
  const keys = useRef(new Map<string, string>());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(body: GenerationBatchCreate) {
    if (starting) return;
    const keyOf = batchKey(body);
    let key = keys.current.get(keyOf);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(keyOf, key);
    }
    setStarting(true);
    setError(null);
    try {
      const batch = await client.startBatch(workspaceId, body, key);
      keys.current.delete(keyOf);
      router.push(batchPath(workspaceId, batch.id));
    } catch (failure) {
      setStarting(false);
      if (failure instanceof GenerationApiError) {
        if (failure.kind === 'unauthenticated') {
          router.replace(loginRedirectPath(returnTo));
          return;
        }
        // A 4xx refusal created nothing: a later attempt is a new request. A lost or 5xx
        // response may have started the batch, so its retry keeps the key.
        if (failure.status >= 400 && failure.status < 500) keys.current.delete(keyOf);
        setError(
          failure.kind === 'noMatchingQuestions'
            ? failure.message
            : `변형 생성을 시작하지 못했습니다. ${failure.message}`,
        );
        return;
      }
      setError('변형 생성을 시작하지 못했습니다. 다시 시도해 주세요.');
    }
  }

  return { start, starting, error, clearError: () => setError(null) } as const;
}
