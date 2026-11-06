// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChapterCreator } from '@/lib/chapters/use-chapter-creator';

const WRITE = {
  chapter: { id: 'new', title: '범위', level: 1 },
  version: 1,
  document_id: null,
  document_title: 'Workspace 챕터',
};

function stubFetch(...responses: Response[]) {
  const keys: (string | null)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key'));
      return responses.shift() as Response;
    }),
  );
  return keys;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useChapterCreator (UX12-CHAPTERADD)', () => {
  it('reports the new chapter in the Workspace group', async () => {
    stubFetch(new Response(JSON.stringify(WRITE), { status: 201 }));
    const onCreated = vi.fn();
    const { result } = renderHook(() => useChapterCreator('ws', onCreated));
    await expect(result.current('범위', null)).resolves.toEqual({ value: 'new' });
    expect(onCreated).toHaveBeenCalledWith({
      id: 'new',
      title: '범위',
      level: 1,
      documentId: 'workspace',
      documentTitle: 'Workspace 챕터',
    });
  });

  it('retries a failure with the same key and a new name with a new one', async () => {
    const keys = stubFetch(
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify(WRITE), { status: 201 }),
      new Response(JSON.stringify(WRITE), { status: 201 }),
    );
    const { result } = renderHook(() => useChapterCreator('ws', vi.fn()));
    const failed = await result.current('범위', null);
    expect(failed).toMatchObject({ error: expect.stringContaining('저장하지 못했습니다') });
    await result.current('범위', null);
    await result.current('범위', null);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});
