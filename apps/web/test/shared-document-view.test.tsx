// @vitest-environment jsdom
// WS-VIEW-01 SharedDocumentView: a PDF request refused because the link was revoked/expired (or
// the session ended) switches the whole share view to the unavailable notice; an ordinary PDF
// failure stays inside the viewer.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PdfLoadError } from '../src/lib/documents/pdf-source';
import { SharedApiError, type SharedClient } from '../src/lib/shared/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The real viewer needs PDF.js; this stand-in calls the source and shows its own error like it.
vi.mock('../src/components/documents/editor/pdf-viewer', () => ({
  PdfViewer: ({ source }: { source: (signal: AbortSignal) => Promise<Uint8Array> }) => {
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      const controller = new AbortController();
      source(controller.signal).catch(() => setFailed(true));
      return () => controller.abort();
    }, [source]);
    return failed ? <p role="alert">PDF 오류</p> : <p>PDF</p>;
  },
}));

const { SharedDocumentView } = await import('../src/components/shared/shared-document-view');

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const DOC = '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e';

function fakeClient(pdfError: unknown): SharedClient {
  return {
    exchange: vi.fn(),
    workspace: vi.fn(),
    document: vi.fn(async () => ({
      id: DOC,
      title: '책',
      document_type: 'book',
      revision_id: DOC,
      outline: [],
      blocks: [],
      next_after: null,
    })),
    questions: vi.fn(),
    search: vi.fn(),
    question: vi.fn(),
    chapterNotes: vi.fn(),
    chapterNote: vi.fn(),
    pdf: vi.fn(async () => {
      throw pdfError;
    }),
  };
}

function renderDoc(client: SharedClient, onUnavailable: () => void) {
  return render(
    <SharedDocumentView
      shareId={SHARE}
      client={client}
      documentId={DOC}
      summary={null}
      page={null}
      blockId={null}
      onUnavailable={onUnavailable}
    />,
  );
}

describe('SharedDocumentView PDF failures', () => {
  it.each([
    ['revoked or expired link', new SharedApiError('unavailable', 404)],
    ['ended session', new SharedApiError('sessionRequired', 401)],
  ])('ends the share view for a %s', async (_name, error) => {
    const onUnavailable = vi.fn();
    renderDoc(fakeClient(error), onUnavailable);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
  });

  it('keeps an ordinary PDF failure inside the viewer', async () => {
    const onUnavailable = vi.fn();
    renderDoc(fakeClient(new PdfLoadError('unavailable')), onUnavailable);
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 오류');
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
