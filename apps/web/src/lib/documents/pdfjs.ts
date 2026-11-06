// Lazy PDF.js (pdfjs-dist, pinned) for the DOC-02 viewer. Loaded in the browser only, with its
// worker started from our own bundle (pdf.worker.ts) — never from a CDN — so the CSP stays
// `worker-src 'self'`, `script-src` without 'unsafe-eval' and `connect-src` unchanged (PDF.js
// gets the bytes, it never fetches).
import type * as PdfjsModule from 'pdfjs-dist';

export type Pdfjs = typeof PdfjsModule;
export type PdfDocument = PdfjsModule.PDFDocumentProxy;
export type PdfPage = PdfjsModule.PDFPageProxy;
export type PdfRenderTask = PdfjsModule.RenderTask;
export type PdfLoadingTask = PdfjsModule.PDFDocumentLoadingTask;
type PdfWorker = InstanceType<Pdfjs['PDFWorker']>;

let loading: Promise<Pdfjs> | null = null;
let worker: PdfWorker | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist')
    .then((pdfjs) => {
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(
          new URL('./pdf.worker.ts', import.meta.url),
          { type: 'module', name: 'pdfjs' },
        );
      }
      return pdfjs;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * Opens a PDF from bytes already in memory (no range/stream requests, no wasm). PDF.js 6 no
 * longer compiles fonts with `eval`, so `script-src` needs no 'unsafe-eval'. Destroy the returned
 * loading task to release the document.
 *
 * Every document shares one `PDFWorker` passed in explicitly, so destroying a task leaves it alone.
 * Without it each task owns the worker of the port: one viewer closing while another opens (the
 * 원본 PDF dialog handing over to DOC-02) makes the open throw "the worker is being destroyed".
 */
export function openPdf(pdfjs: Pdfjs, data: Uint8Array): PdfLoadingTask {
  worker ??= pdfjs.PDFWorker.create({ port: pdfjs.GlobalWorkerOptions.workerPort ?? undefined });
  return pdfjs.getDocument({
    data,
    worker,
    enableXfa: false,
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false,
  });
}
