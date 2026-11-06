// @vitest-environment jsdom
// QSRC-01 문제 원문 보기 (docs/screens/question-source-preview.md): the region client and sizing,
// the relays, and the button's states — hidden without a region (404, error), shown with one, and
// no PDF request until a preview or the dialog is used (QSRC-01-AC01).
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@quiz/ui';
import type * as Bff from '../src/lib/documents/bff';

const relay = vi.hoisted(() => ({ relayToApi: vi.fn() }));
vi.mock('@/lib/documents/bff', async (original) => ({
  ...(await original<typeof Bff>()),
  relayToApi: relay.relayToApi,
}));

const sheetMode = vi.hoisted(() => ({ value: false }));
vi.mock('@quiz/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  usePairedSheet: () => sheetMode.value,
}));

const { QuestionFigures, QuestionSourceButton, QuestionSourceDialog, useQuestionSource } =
  await import('../src/components/questions/viewer/question-source-preview');
const { fetchSourceRegions, fitRegion, sourceRegionPath, tooltipFit } =
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

type Target = Parameters<typeof useQuestionSource>[0];

/** What every viewer renders of a question's source. */
function QuestionSourcePreview({ target }: { readonly target: Target }) {
  const source = useQuestionSource(target);
  return (
    <>
      <QuestionSourceButton source={source} />
      <QuestionSourceDialog source={source} />
      <QuestionFigures source={source} />
    </>
  );
}

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
    ).toEqual({ regions: [REGION], figures: [] });
    const flatFigure = { ...REGION, bbox: { x0: 1, y0: 1, x1: 1, y1: 9 } };
    expect(
      await fetchSourceRegions(target, undefined, () =>
        Promise.resolve(ok({ regions: [REGION], figures: [REGION, flatFigure] })),
      ),
    ).toEqual({ regions: [REGION], figures: [REGION] });
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

describe('QSRC-01 narrow sheet history', () => {
  const ui = () => <QuestionSourcePreview target={{ kind: 'question', id: ID }} />;

  it('pushes one entry when the viewport narrows while open, and pops it once on close', async () => {
    const { fireEvent, act } = await import('@testing-library/react');
    stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    sheetMode.value = false;
    const view = render(ui());
    fireEvent.click(await screen.findByRole('button', { name: '문제 원문 보기' }));
    await screen.findByRole('dialog', { name: '문제 원문' });
    expect(push).not.toHaveBeenCalled();

    sheetMode.value = true;
    view.rerender(ui());
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    // Wide again, then narrow again: the entry is kept, not pushed twice.
    sheetMode.value = false;
    view.rerender(ui());
    sheetMode.value = true;
    view.rerender(ui());
    expect(push).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    });
    expect(back).toHaveBeenCalledTimes(1);
    push.mockRestore();
    back.mockRestore();
  });

  it('pushes at open in sheet mode and closes on popstate without another back()', async () => {
    const { fireEvent, act } = await import('@testing-library/react');
    stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    sheetMode.value = true;
    render(ui());
    fireEvent.click(await screen.findByRole('button', { name: '문제 원문 보기' }));
    await screen.findByRole('dialog', { name: '문제 원문' });
    expect(push).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    expect(back).not.toHaveBeenCalled();
    push.mockRestore();
    back.mockRestore();
  });
});

describe('QSRC-01 tooltip budget', () => {
  it.each([1, 2, 3])('%i tall regions fit the 320px maximum', (count) => {
    const fit = tooltipFit(count, 1280, 800);
    // padding + border, gaps between figures, a caption (with its gap) per figure
    const total = 2 * 17 + (count - 1) * 12 + count * (24 + fit.maxHeight);
    expect(total).toBeLessThanOrEqual(320);
    expect(fit.maxHeight).toBeGreaterThan(0);
    expect(fit.maxWidth).toBeLessThanOrEqual(360);
  });

  it('shrinks with a short viewport and never exceeds it', () => {
    const fit = tooltipFit(3, 375, 400);
    expect(2 * 17 + 2 * 12 + 3 * (24 + fit.maxHeight)).toBeLessThanOrEqual(400 - 32);
    expect(fit.maxWidth).toBeLessThanOrEqual(375 - 32);
  });
});

describe('UX12-SRCMENU shared source state', () => {
  const MENU = { name: '메뉴' };
  const OTHER = '22222222-2222-4222-8222-222222222222';

  /** A panel whose header control opens the dialog the way the 더보기 menu does. */
  function Host({ id }: { readonly id: string | null }) {
    const source = useQuestionSource(id ? { kind: 'question', id } : null);
    const { onShowSource } = source;
    return (
      <div role="dialog" aria-label="문제" data-testid="host">
        {onShowSource ? (
          <button type="button" onClick={(event) => onShowSource(event.currentTarget)}>
            메뉴
          </button>
        ) : null}
        <QuestionSourceDialog source={source} />
      </div>
    );
  }

  it('offers no control without a region', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    render(<Host id={ID} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', MENU)).toBeNull();
  });

  it('makes the panel around the trigger inert while open', async () => {
    const { fireEvent } = await import('@testing-library/react');
    stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    render(<Host id={ID} />);
    fireEvent.click(await screen.findByRole('button', MENU));
    await screen.findByRole('dialog', { name: '문제 원문' });
    expect(screen.getByTestId('host').hasAttribute('inert')).toBe(true);
  });

  it('closes and reads the region again when the question changes', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const fetchMock = stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    const view = render(<Host id={ID} />);
    fireEvent.click(await screen.findByRole('button', MENU));
    await screen.findByRole('dialog', { name: '문제 원문' });

    view.rerender(<Host id={OTHER} />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    await screen.findByRole('button', MENU);
    expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      `/api/questions/${OTHER}/source-region`,
    );
  });

  it('a closing panel keeps the region, and reopening does not reopen the dialog', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const fetchMock = stubFetch(() => Response.json({ question_id: ID, regions: [REGION] }));
    const view = render(<Host id={ID} />);
    fireEvent.click(await screen.findByRole('button', MENU));
    await screen.findByRole('dialog', { name: '문제 원문' });

    view.rerender(<Host id={null} />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull());
    expect(screen.getByRole('button', MENU)).toBeTruthy();

    const requests = fetchMock.mock.calls.length;
    view.rerender(<Host id={ID} />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(requests + 1));
    await screen.findByRole('button', MENU);
    expect(screen.queryByRole('dialog', { name: '문제 원문' })).toBeNull();
  });
});

describe('UX12-REEXTRACT figures', () => {
  const target = { kind: 'question', id: ID } as const;
  const body = (figures: unknown[]) =>
    new Response(JSON.stringify({ question_id: ID, regions: [REGION], figures }), { status: 200 });
  const isPdf = (url: string) => String(url).includes('source-url');

  function stubObserver() {
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observers.push(callback);
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    return () =>
      observers.at(-1)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
  }

  it('asks for the PDF only when the figures enter the viewport', async () => {
    const enter = stubObserver();
    const fetchMock = stubFetch((url) =>
      isPdf(url) ? new Response('{}', { status: 503 }) : body([REGION]),
    );
    render(<QuestionSourcePreview target={target} />);
    await screen.findByRole('group', { name: '문제 그림' });
    expect(fetchMock.mock.calls.some(([url]) => isPdf(url))).toBe(false);

    expect(screen.queryByRole('alert')).toBeNull();

    // pdf.js does not load in jsdom: opening the PDF fails, which shows that it was started.
    enter();
    expect(await screen.findByRole('alert')).toHaveTextContent('그림을 불러오지 못했습니다');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('renders nothing and fetches no PDF without figures', async () => {
    stubObserver();
    const fetchMock = stubFetch(() => body([]));
    render(<QuestionSourcePreview target={target} />);
    await screen.findByRole('button', { name: '문제 원문 보기' });
    expect(screen.queryByRole('group', { name: '문제 그림' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => isPdf(url))).toBe(false);
  });
});
