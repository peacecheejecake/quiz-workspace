// Dedicated module worker for PDF.js (pdfjs.ts). Importing the pinned pdfjs-dist worker build
// registers its message handler on this worker's global scope. Bundled by Next and served from
// this origin, so CSP `worker-src 'self'` covers it (no CDN, no blob: worker).
/// <reference lib="webworker" />
import 'pdfjs-dist/build/pdf.worker.min.mjs';
