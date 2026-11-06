// @vitest-environment jsdom
// UX12-PDFPREVIEW (docs/screens/ux12-pdf-preview.md): what the source dialogs show. A cited block's
// box is marked; the 문제 원문 dialog stays cropped until the answers are out; the guard that tells
// the AI 질문 panel a question below is still unanswered.
import './dom-setup';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({
  props: [] as {
    page: number;
    highlights: readonly { page: number; bbox: unknown }[];
    highlightKey?: string | null;
  }[],
}));
vi.mock('@/components/documents/editor/pdf-viewer', () => ({
  PdfViewer: (props: (typeof viewer.props)[number]) => {
    viewer.props.push(props);
    return <p>PDF 보기</p>;
  },
}));
vi.mock('../src/components/documents/editor/pdf-viewer', () => ({
  PdfViewer: (props: (typeof viewer.props)[number]) => {
    viewer.props.push(props);
    return <p>PDF 보기</p>;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { PdfPageDialog } = await import('../src/components/documents/editor/pdf-page-dialog');
const { QuestionSourceButton, QuestionSourceDialog, useQuestionSource } =
  await import('../src/components/questions/viewer/question-source-preview');
const { useAnswerGuarded, useHoldAnswerGuard } = await import('../src/lib/questions/answer-guard');

const DOC = '22222222-2222-4222-8222-222222222222';
const OTHER_DOC = '44444444-4444-4444-8444-444444444444';
const REVISION = '33333333-3333-4333-8333-333333333333';
const BLOCK = '55555555-5555-4555-8555-555555555555';
const QUESTION = '11111111-1111-4111-8111-111111111111';
const BOX = { x0: 50, y0: 100, x1: 250, y1: 200 };
const region = (page: number, document_id = DOC) => ({
  document_id,
  document_revision_id: REVISION,
  page,
  bbox: BOX,
});

function stubFetch(handler: (url: string) => Response) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(handler(url)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  viewer.props = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UX12-PDFPREVIEW cited block', () => {
  const target = { documentId: DOC, page: 4, documentHref: '/d' };

  it('UX12-PDFPREVIEW-AC03 marks the box of the cited block on its page', async () => {
    const block = {
      block_id: BLOCK,
      text: '본문',
      locations: [
        { page: 4, bbox: BOX },
        { page: 5, bbox: null },
      ],
    };
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ block }), { status: 200 }));
    render(
      <PdfPageDialog
        target={{ ...target, block: { id: BLOCK, revisionId: REVISION } }}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(viewer.props.at(-1)?.highlights).toEqual([{ page: 4, bbox: BOX }]));
    expect(viewer.props.at(-1)?.page).toBe(4);
    expect(viewer.props.at(-1)?.highlightKey).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/blocks/${BLOCK}`);
  });

  it('UX12-PDFPREVIEW-AC03 keeps the page alone when the block cannot be read', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 500 }));
    render(
      <PdfPageDialog
        target={{ ...target, block: { id: BLOCK, revisionId: REVISION } }}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(viewer.props.at(-1)?.page).toBe(4);
    expect(viewer.props.at(-1)?.highlights).toEqual([]);
  });

  it('reads nothing for a source without a block', () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 200 }));
    render(<PdfPageDialog target={target} onClose={() => undefined} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(viewer.props.at(-1)?.highlights).toEqual([]);
  });
});

describe('UX12-PDFPREVIEW 문제 원문 dialog', () => {
  function Host({ whole }: { readonly whole: boolean }) {
    const source = useQuestionSource({ kind: 'question', id: QUESTION });
    return (
      <>
        <QuestionSourceButton source={source} />
        <QuestionSourceDialog source={source} wholeDocument={whole} />
      </>
    );
  }
  const regionFetch = (regions: unknown[]) =>
    stubFetch((url) =>
      url.includes('/source-region')
        ? new Response(JSON.stringify({ regions, figures: [] }), { status: 200 })
        : new Response('{}', { status: 500 }),
    );
  const open = async () => {
    await userEvent.click(await screen.findByRole('button', { name: '문제 원문 보기' }));
    return screen.findByRole('dialog', { name: '문제 원문' });
  };

  it('UX12-PDFPREVIEW-AC01 stays cropped while the answers are hidden', async () => {
    regionFetch([region(2), region(3)]);
    render(<Host whole={false} />);
    await open();
    expect(screen.queryByText('PDF 보기')).toBeNull();
    expect(viewer.props).toEqual([]);
  });

  it('UX12-PDFPREVIEW-AC02 opens the whole document at the region once answers are out', async () => {
    const fetchMock = regionFetch([region(2), region(3)]);
    render(<Host whole />);
    await open();
    expect(await screen.findByText('PDF 보기')).toBeInTheDocument();
    expect(viewer.props.at(-1)?.page).toBe(2);
    expect(viewer.props.at(-1)?.highlights).toEqual([
      { page: 2, bbox: BOX },
      { page: 3, bbox: BOX },
    ]);
    // The viewer downloads the PDF itself: the cropped figures' copy is not fetched as well.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('/source-url'))).toHaveLength(0);
  });

  it('stays cropped when the regions are in two documents', async () => {
    regionFetch([region(2), region(1, OTHER_DOC)]);
    render(<Host whole />);
    await open();
    expect(screen.queryByText('PDF 보기')).toBeNull();
  });
});

describe('UX12-PDFPREVIEW answer guard', () => {
  it('UX12-PDFPREVIEW-AC05 is on while any viewer holds it', () => {
    const watcher = renderHook(() => useAnswerGuarded());
    expect(watcher.result.current).toBe(false);
    const first = renderHook(({ on }) => useHoldAnswerGuard(on), {
      initialProps: { on: true },
    });
    const second = renderHook(() => useHoldAnswerGuard(true));
    expect(watcher.result.current).toBe(true);
    act(() => first.rerender({ on: false }));
    expect(watcher.result.current).toBe(true);
    act(() => second.unmount());
    expect(watcher.result.current).toBe(false);
    first.unmount();
  });
});
