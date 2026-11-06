// The PDF.js worker outlives the documents: a viewer that closes while another opens (the 원본 PDF
// dialog handing over to DOC-02, SEARCH-01-AC03) must not take the worker with it.
import { describe, expect, it, vi } from 'vitest';
import { openPdf, type Pdfjs } from '../src/lib/documents/pdfjs';

describe('openPdf', () => {
  it('passes one long-lived worker to every document, so destroying a task keeps it', () => {
    const shared = { destroyed: false };
    const create = vi.fn(() => shared);
    const getDocument = vi.fn((options: { worker?: unknown }) => options);
    const pdfjs = {
      GlobalWorkerOptions: { workerPort: {} },
      PDFWorker: { create },
      getDocument,
    } as unknown as Pdfjs;

    openPdf(pdfjs, new Uint8Array([1]));
    openPdf(pdfjs, new Uint8Array([2]));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ port: pdfjs.GlobalWorkerOptions.workerPort });
    expect(getDocument.mock.calls.map(([options]) => options.worker)).toEqual([shared, shared]);
  });
});
