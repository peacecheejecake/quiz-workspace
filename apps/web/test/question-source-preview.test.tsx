// @vitest-environment jsdom
// QSRC-01 문제 원문 보기 (docs/screens/question-source-preview.md): the region client and sizing,
// the relays, and the button's states — hidden without a region (404, error), shown with one, and
// no PDF request until a preview or the dialog is used (QSRC-01-AC01).
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Bff from '../src/lib/documents/bff';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));

const { QuestionSourcePreview } =
  await import('../src/components/questions/viewer/question-source-preview');
const { fetchSourceRegions, fitRegion, sourceRegionPath } =
  await import('../src/lib/questions/source-region');
const bank = await import('../src/app/api/questions/[questionId]/source-region/route');
const mock = await import('../src/app/api/mock-exam-questions/[questionId]/source-region/route');

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const REGION = {
  document_id: DOC,
  document_revision_id: '33333333-3333-4333-8333-333333333333',
  page: 1,
  bbox: { x0: 50, y0: 100, x1: 250, y1: 200 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  relay.relayToApi.mockReset();
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(handler(url)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('QSRC-01 region client', () => {
  it('builds the bank and mock paths', () => {
    expect(sourceRegionPath({ kind: 'question', id: ID })).toBe(
      `/api/questions/${ID}/source-region`,
    );
    expect(sourceRegionPath({ kind: 'mock', id: ID })).toBe(
      `/api/mock-exam-questions/${ID}/source-region`,
    );
  });

  it('returns the regions, or null for 404, errors and unusable boxes', async () => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const target = { kind: 'question', id: ID } as const;
    expect(
      await fetchSourceRegions(target, undefined, () => Promise.resolve(ok({ regions: [REGION] }))),
    ).toEqual([REGION]);
    expect(
      await fetchSourceRegions(target, undefined, () =>
        Promise.resolve(new Response('{}', { status: 404 })),
      ),
    ).toBeNull();
    expect(
      await fetchSourceRegions(target, undefined, () => Promise.reject(new Error('offline'))),
    ).toBeNull();
    const flat = { ...REGION, bbox: { x0: 1, y0: 1, x1: 1, y1: 9 } };
    expect(
      await fetchSourceRegions(target, undefined, () => Promise.resolve(ok({ regions: [flat] }))),
    ).toBeNull();
  });

  it('keeps the bbox aspect ratio and honours the width and height limits', () => {
    const bbox = { x0: 0, y0: 0, x1: 200, y1: 100 };
    const wide = fitRegion(bbox, 300, null);
    expect(wide.width / wide.height).toBeCloseTo(2, 5);
    expect(wide.width).toBeCloseTo(300, 5);
    const short = fitRegion(bbox, 300, 60);
    expect(short.height).toBeCloseTo(60, 5);
    expect(short.width / short.height).toBeCloseTo(2, 5);
    // Never magnified past 3x of its size in PDF points.
    expect(fitRegion(bbox, 5000, null).width).toBeCloseTo(600, 5);
  });
});

describe('QSRC-01 relays', () => {
  it('forward the region reads and refuse malformed ids', async () => {
    relay.relayToApi.mockResolvedValue(Response.json({}));
    await bank.GET(new Request('http://web.test/x'), ctx({ questionId: ID }));
    expect(relay.relayToApi).toHaveBeenLastCalledWith(`/questions/${ID}/source-region`, {
      method: 'GET',
    });
    await mock.GET(new Request('http://web.test/x'), ctx({ questionId: ID }));
    expect(relay.relayToApi).toHaveBeenLastCalledWith(`/mock-exam-questions/${ID}/source-region`, {
      method: 'GET',
    });
    relay.relayToApi.mockClear();
    expect(
      (await bank.GET(new Request('http://web.test/x'), ctx({ questionId: 'x' }))).status,
    ).toBe(404);
    expect(relay.relayToApi).not.toHaveBeenCalled();
  });
});

describe('QSRC-01 button', () => {
  const BUTTON = { name: '문제 원문 보기' };

  it('shows with a region and requests no PDF', async () => {
    const fetchMock = stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    render(<QuestionSourcePreview target={{ kind: 'question', id: ID }} />);
    expect(await screen.findByRole('button', BUTTON)).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/questions/${ID}/source-region`,
    ]);
  });

  it('is absent on 404 and on a failed request, leaving no placeholder', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    const first = render(<QuestionSourcePreview target={{ kind: 'mock', id: ID }} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', BUTTON)).toBeNull();
    expect(first.container.innerHTML).toBe('');
    first.unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const second = render(<QuestionSourcePreview target={{ kind: 'question', id: ID }} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', BUTTON)).toBeNull();
    expect(second.container.innerHTML).toBe('');
  });
});
