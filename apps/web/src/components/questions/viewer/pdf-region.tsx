'use client';

// PdfRegion (QSRC-01, docs/screens/question-source-preview.md): draws ONLY the bbox of a question's
// source region — one canvas per (document, page), cropped to the region at its own aspect ratio,
// stacked in page order with a `p.<n>` label. There is no page navigation, scroll area, zoom,
// search, download or open link, and no text layer: nothing outside the region (an answer key, the
// neighbouring question) is in the DOM, and the canvas is exactly region-sized. The PDF bytes
// arrive through the source-url relay (QuestionSourcePreview), as for the DOC-02 viewer.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { canvasRatio } from '@/lib/documents/pdf-layout';
import type { PdfDocument, PdfRenderTask } from '@/lib/documents/pdfjs';
import { fitRegion, type SourceRegion } from '@/lib/questions/source-region';
import styles from './question-source-preview.module.css';

export interface PdfRegionsProps {
  readonly regions: readonly SourceRegion[];
  /** The opened PDF per document id. */
  readonly documents: ReadonlyMap<string, PdfDocument>;
  /** `tooltip`: at most `maxWidth` x `maxHeight` per figure; `dialog`: the width of the dialog. */
  readonly fit: { readonly maxWidth: number; readonly maxHeight: number } | 'container';
  /** A page could not be drawn. */
  readonly onFailed: () => void;
}

/** Width of the element, following resizes (0 until measured). */
function useWidth(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return undefined;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}

export function PdfRegions({ regions, documents, fit, onFailed }: PdfRegionsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measured = useWidth(rootRef, fit === 'container');
  const maxWidth = fit === 'container' ? measured : fit.maxWidth;
  const maxHeight = fit === 'container' ? null : fit.maxHeight;
  return (
    <div ref={rootRef} className={styles.regions}>
      {maxWidth > 0
        ? regions.map((region) => {
            const doc = documents.get(region.document_id);
            if (!doc) return null;
            return (
              <figure key={`${region.document_id}:${region.page}`} className={styles.figure}>
                <figcaption className={styles.pageLabel}>p.{region.page}</figcaption>
                <RegionCanvas
                  doc={doc}
                  region={region}
                  maxWidth={maxWidth}
                  maxHeight={maxHeight}
                  onFailed={onFailed}
                />
              </figure>
            );
          })
        : null}
    </div>
  );
}

function RegionCanvas({
  doc,
  region,
  maxWidth,
  maxHeight,
  onFailed,
}: {
  readonly doc: PdfDocument;
  readonly region: SourceRegion;
  readonly maxWidth: number;
  readonly maxHeight: number | null;
  readonly onFailed: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });
  const { bbox, page } = region;
  const size = fitRegion(bbox, maxWidth, maxHeight);
  // Fractional sizes keep the bbox's aspect ratio exact (a rounded height of ~20px is 2% off).
  const width = size.width;
  const height = size.height;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let task: PdfRenderTask | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        // CSS pixels per PDF point; the bitmap is the region only, at device resolution.
        const scale = size.width / (bbox.x1 - bbox.x0);
        const viewport = pdfPage.getViewport({ scale });
        const ratio = canvasRatio(size.width, size.height, window.devicePixelRatio);
        canvas.width = Math.max(Math.floor(size.width * ratio), 1);
        canvas.height = Math.max(Math.floor(size.height * ratio), 1);
        task = pdfPage.render({
          canvas,
          viewport,
          transform: [ratio, 0, 0, ratio, -bbox.x0 * scale * ratio, -bbox.y0 * scale * ratio],
        });
        await task.promise;
      } catch (error) {
        if (cancelled || (error as { name?: string }).name === 'RenderingCancelledException') {
          return;
        }
        failed.current();
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // `width`/`height` are the display size; the effect redraws when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, bbox.x0, bbox.y0, bbox.x1, bbox.y1, width, height]);

  return (
    <div
      className={styles.image}
      role="img"
      aria-label={`문제 원문 p.${page}`}
      style={{ width: `${width}px`, aspectRatio: `${bbox.x1 - bbox.x0} / ${bbox.y1 - bbox.y0}` }}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    </div>
  );
}
