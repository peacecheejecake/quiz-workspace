'use client';

// PdfViewer (DOC-02): one page at a time on a canvas (PDF.js), page navigation with a
// "현재 페이지" field, zoom (fit width by default) and the selected block's source highlight drawn
// from its bbox (PDF points, origin top-left). The PDF reading area is an opaque surface — no
// glass/blur over it (design-system §1, checklist).
import { Button, IconButton } from '@quiz/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ContentBlock } from '@/lib/documents/editor-api';
import { loadPdfBytes, PdfLoadError, type SignedUrlCache } from '@/lib/documents/pdf-source';
import {
  loadPdfjs,
  openPdf,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfRenderTask,
} from '@/lib/documents/pdfjs';
import styles from './editor.module.css';

export interface PdfViewerProps {
  readonly urls: SignedUrlCache;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageCount?: (count: number) => void;
  /** Source locations of the selected block on the current page. */
  readonly highlights: ContentBlock['locations'];
  /** Changes whenever the highlight should be scrolled into view. */
  readonly highlightKey?: string | null;
  readonly className?: string;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
type Zoom = 'fit' | number;

interface Rendered {
  readonly page: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

const LOADING = { status: 'loading' } as const;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly pdf: PdfDocument }
  | { readonly status: 'error'; readonly message: string };

function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.01) ?? current;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01) ?? current;
}

export function PdfViewer({
  urls,
  page,
  onPageChange,
  onPageCount,
  highlights,
  highlightKey,
  className,
}: PdfViewerProps) {
  const [attempt, setAttempt] = useState(0);
  // Result of the download/open for one attempt; any other attempt is still loading.
  const [loaded, setLoaded] = useState<{ attempt: number; state: LoadState } | null>(null);
  const load: LoadState = loaded?.attempt === attempt ? loaded.state : LOADING;
  const pdf = load.status === 'ready' ? load.pdf : null;
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState(false);
  /** Text typed into the page field; null shows the current page. */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const pageInput = pageDraft ?? String(page);
  const [containerWidth, setContainerWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const onPageCountRef = useRef(onPageCount);
  useEffect(() => {
    onPageCountRef.current = onPageCount;
  }, [onPageCount]);

  const pageCount = pdf ? pdf.numPages : null;

  // Download the original once (whole file, HTTP 200) and open it from memory.
  useEffect(() => {
    const controller = new AbortController();
    let task: PdfLoadingTask | null = null;
    const setLoad = (state: LoadState) => setLoaded({ attempt, state });
    void (async () => {
      try {
        const [bytes, pdfjs] = await Promise.all([
          loadPdfBytes(urls, { signal: controller.signal }),
          loadPdfjs(),
        ]);
        if (controller.signal.aborted) return;
        task = openPdf(pdfjs, bytes);
        const opened = await task.promise;
        if (controller.signal.aborted) return;
        setLoad({ status: 'ready', pdf: opened });
        onPageCountRef.current?.(opened.numPages);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoad({
          status: 'error',
          message:
            error instanceof PdfLoadError
              ? error.message
              : 'PDF를 표시하지 못했습니다. 다시 시도해 주세요.',
        });
      }
    })();
    return () => {
      controller.abort();
      void task?.destroy();
    };
  }, [urls, attempt]);

  // Fit-to-width follows the pane's width.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [load.status]);

  // Render the current page; a newer render cancels the previous one.
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    const target = Math.min(Math.max(page, 1), pdf.numPages);
    const canvas = canvasRef.current;
    let task: PdfRenderTask | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(target);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const available = Math.max(containerWidth - 32, 200);
        const scale = zoom === 'fit' ? available / base.width : zoom;
        const viewport = pdfPage.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        task = pdfPage.render({
          canvas,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await task.promise;
        if (cancelled) return;
        setRenderError(false);
        setRendered({ page: target, scale, width: viewport.width, height: viewport.height });
      } catch (error) {
        if (cancelled || (error as { name?: string }).name === 'RenderingCancelledException') {
          return;
        }
        setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, zoom, containerWidth]);

  const visible = rendered !== null && rendered.page === page ? rendered : null;

  // Bring the highlighted source into view inside the viewer (not the whole page).
  useEffect(() => {
    const box = highlightRef.current;
    const scroller = scrollRef.current;
    if (!visible || !box || !scroller) return;
    // The box sits in the page frame, which sits in the (positioned) scroller.
    const frameTop = box.offsetParent instanceof HTMLElement ? box.offsetParent.offsetTop : 0;
    const top = frameTop + box.offsetTop - scroller.clientHeight / 4;
    scroller.scrollTo({ top: Math.max(top, 0) });
  }, [visible, highlightKey]);

  const goTo = useCallback(
    (next: number) => {
      if (pageCount === null) return;
      const clamped = Math.min(Math.max(Math.round(next), 1), pageCount);
      if (clamped !== page) onPageChange(clamped);
      setPageDraft(null);
    },
    [onPageChange, page, pageCount],
  );

  const commitPageInput = () => {
    const value = Number(pageInput.trim());
    if (pageInput.trim() !== '' && Number.isInteger(value) && value >= 1) goTo(value);
    else setPageDraft(null);
  };

  const onPageKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitPageInput();
    } else if (event.key === 'Escape') {
      setPageDraft(null);
    }
  };

  const currentZoom = zoom === 'fit' ? (visible?.scale ?? 1) : zoom;
  const zoomPercent = `${Math.round(currentZoom * 100)}%`;

  return (
    <div className={`${styles.viewer} ${className ?? ''}`}>
      <div className={styles.viewerToolbar} role="toolbar" aria-label="PDF 보기 도구">
        <div className={styles.toolbarGroup}>
          <IconButton
            label="이전 페이지"
            icon={<span aria-hidden="true">‹</span>}
            onClick={() => goTo(page - 1)}
            disabled={pageCount === null || page <= 1}
          />
          <label className={styles.pageField}>
            <span className="qz-visually-hidden">현재 페이지</span>
            <input
              className={styles.pageInput}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pageInput}
              aria-describedby="pdf-page-count"
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={commitPageInput}
              onKeyDown={onPageKey}
              disabled={pageCount === null}
            />
          </label>
          <span id="pdf-page-count" className={styles.pageCount}>
            / {pageCount ?? '–'}쪽
          </span>
          <IconButton
            label="다음 페이지"
            icon={<span aria-hidden="true">›</span>}
            onClick={() => goTo(page + 1)}
            disabled={pageCount === null || page >= pageCount}
          />
        </div>
        <div className={styles.toolbarGroup}>
          <IconButton
            label="축소"
            icon={<span aria-hidden="true">−</span>}
            onClick={() => setZoom(nextZoom(currentZoom, -1))}
            disabled={load.status !== 'ready' || currentZoom <= MIN_ZOOM + 0.01}
          />
          <span className={styles.zoomValue} aria-label={`확대 비율 ${zoomPercent}`}>
            {zoomPercent}
          </span>
          <IconButton
            label="확대"
            icon={<span aria-hidden="true">+</span>}
            onClick={() => setZoom(nextZoom(currentZoom, 1))}
            disabled={load.status !== 'ready' || currentZoom >= MAX_ZOOM - 0.01}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setZoom('fit')}
            disabled={zoom === 'fit'}
            aria-pressed={zoom === 'fit'}
          >
            폭 맞춤
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={styles.pageScroller}
        // The page area scrolls (zoomed pages): keyboard users need to reach it (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="group"
        aria-label="PDF 페이지 영역"
        aria-busy={load.status === 'loading' || undefined}
      >
        {load.status === 'loading' ? (
          <p className={styles.viewerNote}>PDF를 불러오는 중입니다…</p>
        ) : null}
        {load.status === 'error' ? (
          <div className={styles.viewerError} role="alert">
            <p>{load.message}</p>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              다시 시도
            </Button>
          </div>
        ) : null}
        {renderError ? (
          <p className={styles.viewerError} role="alert">
            이 페이지를 그리지 못했습니다.
          </p>
        ) : null}
        <div
          className={styles.pageFrame}
          hidden={load.status !== 'ready'}
          style={
            visible ? { width: `${visible.width}px`, height: `${visible.height}px` } : undefined
          }
        >
          <canvas
            ref={canvasRef}
            className={styles.pageCanvas}
            role="img"
            aria-label={`PDF ${page}쪽`}
          />
          {visible
            ? highlights.map((location, index) =>
                location.bbox ? (
                  <div
                    key={`${location.page}-${index}`}
                    ref={index === 0 ? highlightRef : undefined}
                    className={styles.highlight}
                    role={index === 0 ? 'img' : undefined}
                    aria-label={index === 0 ? '원문 위치' : undefined}
                    aria-hidden={index === 0 ? undefined : true}
                    style={{
                      left: `${location.bbox.x0 * visible.scale}px`,
                      top: `${location.bbox.y0 * visible.scale}px`,
                      width: `${Math.max((location.bbox.x1 - location.bbox.x0) * visible.scale, 4)}px`,
                      height: `${Math.max((location.bbox.y1 - location.bbox.y0) * visible.scale, 4)}px`,
                    }}
                  />
                ) : null,
              )
            : null}
        </div>
      </div>
    </div>
  );
}
