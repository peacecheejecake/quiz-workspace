'use client';

// PdfViewer (DOC-02, DOCVIEW AC07/AC08): the whole document as one continuous vertical scroll.
// The original is downloaded once and opened as one PDF.js document; every page has a placeholder
// box (page 1's size until the page itself was read) and only the pages on screen plus their
// neighbours are drawn — the visible ones first, one at a time — into off-screen canvases kept in
// a small LRU cache, so turning back to a recent page needs no PDF.js work at all and a zoom keeps
// showing the old bitmap until the new one is ready. Page turns and scrolling never reach the
// network. The current page is the page under the upper quarter line of the viewport; the toolbar
// keeps "현재 페이지", previous/next and zoom (fit width by default), and the selected block's
// source is highlighted from its bbox (PDF points, origin top-left). The reading area is an opaque
// surface; floating layers may blur over it (design-system §10). DOCVIEW-01: the viewer may be
// hidden (원본 hidden by a view mode, or the other pane on a narrow screen) and resized by the
// splitter; a hidden viewer keeps its document and drawings, takes jumps made meanwhile when it is
// shown again, and a splitter drag redraws only once, after the release.
import { Button, IconButton } from '@quiz/ui';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { ContentBlock } from '@/lib/documents/editor-api';
import {
  attachedRange,
  canvasRatio,
  currentPageAt,
  layoutPages,
  PAGE_PADDING,
  READING_LINE,
  RENDER_CACHE_PAGES,
  RenderCache,
  renderOrder,
  scrollTopForPage,
  visiblePages,
  type PageLayout,
  type PageSize,
} from '@/lib/documents/pdf-layout';
import { PdfLoadError, type PdfBytesSource } from '@/lib/documents/pdf-source';
import {
  loadPdfjs,
  openPdf,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfRenderTask,
} from '@/lib/documents/pdfjs';
import styles from './editor.module.css';
import { ViewerToolbarContext } from './viewer-toolbar-context';

/** Why the viewer changed the page: the reader scrolled, or used the toolbar. */
export type PageChangeReason = 'scroll' | 'navigate';

export interface PdfViewerProps {
  /** Downloads the original (owner: signed Storage URL; shared view: same-origin relay). */
  readonly source: PdfBytesSource;
  readonly page: number;
  readonly onPageChange: (page: number, reason: PageChangeReason) => void;
  readonly onPageCount?: (count: number) => void;
  /** Source locations of the selection, on any page (each is drawn on its own page). */
  readonly highlights: ContentBlock['locations'];
  /** Changes whenever the highlight should be scrolled into view. */
  readonly highlightKey?: string | null;
  /**
   * The pane is being resized (DOCVIEW-01 splitter drag): page boxes follow the width but drawing
   * waits; the pages are redrawn once for the final width when this turns false.
   */
  readonly deferResize?: boolean;
  readonly className?: string;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** A resize (splitter drag, window) redraws pages only once the width stopped changing. */
const REDRAW_DELAY_MS = 150;
type Zoom = 'fit' | number;

const LOADING = { status: 'loading' } as const;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly pdf: PdfDocument; readonly firstPage: PageSize }
  | { readonly status: 'error'; readonly message: string };

function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.01) ?? current;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01) ?? current;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.remove();
  // Frees the bitmap now instead of at garbage collection (matters on iOS).
  canvas.width = 0;
  canvas.height = 0;
}

interface PageFrameProps {
  readonly page: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly highlights: ContentBlock['locations'] | undefined;
  /** This page holds the first highlight (the named "원문 위치" image). */
  readonly labelledHighlight: boolean;
  readonly failed: boolean;
  readonly slotRef: (page: number, element: HTMLDivElement | null) => void;
  readonly highlightRef: (element: HTMLDivElement | null) => void;
}

const PageFrame = memo(function PageFrame({
  page,
  top,
  width,
  height,
  scale,
  highlights,
  labelledHighlight,
  failed,
  slotRef,
  highlightRef,
}: PageFrameProps) {
  const setSlot = useCallback(
    (element: HTMLDivElement | null) => slotRef(page, element),
    [page, slotRef],
  );
  return (
    <div
      className={styles.pageFrame}
      data-page={page}
      style={{ top: `${top}px`, width: `${width}px`, height: `${height}px` }}
    >
      {/* The drawn canvas is attached here imperatively (render cache); React renders no child. */}
      <div ref={setSlot} className={styles.canvasSlot} />
      {failed ? (
        <p className={styles.pageFailed} role="alert">
          {page}쪽을 그리지 못했습니다.
        </p>
      ) : null}
      {highlights?.map((location, index) => {
        if (!location.bbox) return null;
        const named = labelledHighlight && index === 0;
        return (
          <div
            key={`${location.page}-${index}`}
            ref={named ? highlightRef : undefined}
            className={styles.highlight}
            role={named ? 'img' : undefined}
            aria-label={named ? '원문 위치' : undefined}
            aria-hidden={named ? undefined : true}
            style={{
              left: `${location.bbox.x0 * scale}px`,
              top: `${location.bbox.y0 * scale}px`,
              width: `${Math.max((location.bbox.x1 - location.bbox.x0) * scale, 4)}px`,
              height: `${Math.max((location.bbox.y1 - location.bbox.y0) * scale, 4)}px`,
            }}
          />
        );
      })}
    </div>
  );
});

export function PdfViewer({
  source,
  page,
  onPageChange,
  onPageCount,
  highlights,
  highlightKey,
  deferResize = false,
  className,
}: PdfViewerProps) {
  const toolbarHost = useContext(ViewerToolbarContext);
  const [attempt, setAttempt] = useState(0);
  // Result of the download/open for one attempt; any other attempt is still loading.
  const [loaded, setLoaded] = useState<{ attempt: number; state: LoadState } | null>(null);
  const load: LoadState = loaded?.attempt === attempt ? loaded.state : LOADING;
  const pdf = load.status === 'ready' ? load.pdf : null;
  const firstPage = load.status === 'ready' ? load.firstPage : null;
  const pageCount = pdf ? pdf.numPages : null;
  const [zoom, setZoom] = useState<Zoom>('fit');
  /** Text typed into the page field; null shows the current page. */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const pageInput = pageDraft ?? String(page);
  const [containerWidth, setContainerWidth] = useState(0);
  /** Sizes of pages read so far that differ from page 1 (most PDFs have none). */
  const [sizes, setSizes] = useState<ReadonlyMap<number, PageSize>>(() => new Map());
  const [range, setRange] = useState<{ first: number; last: number }>({ first: 1, last: 1 });
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const onPageCountRef = useRef(onPageCount);
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    onPageCountRef.current = onPageCount;
    onPageChangeRef.current = onPageChange;
  }, [onPageCount, onPageChange]);

  // Download the original once (whole file, HTTP 200) and open it from memory.
  useEffect(() => {
    const controller = new AbortController();
    let task: PdfLoadingTask | null = null;
    const setLoad = (state: LoadState) => setLoaded({ attempt, state });
    void (async () => {
      try {
        const [bytes, pdfjs] = await Promise.all([source(controller.signal), loadPdfjs()]);
        if (controller.signal.aborted) return;
        task = openPdf(pdfjs, bytes);
        const opened = await task.promise;
        const first = (await opened.getPage(1)).getViewport({ scale: 1 });
        if (controller.signal.aborted) return;
        setSizes(new Map());
        setFailedPages(new Set());
        setLoad({
          status: 'ready',
          pdf: opened,
          firstPage: { width: first.width, height: first.height },
        });
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
  }, [source, attempt]);

  const scale = useMemo(() => {
    if (zoom !== 'fit') return zoom;
    if (!firstPage) return 1;
    const available = Math.max(containerWidth - 2 * PAGE_PADDING, 200);
    return available / firstPage.width;
  }, [containerWidth, firstPage, zoom]);
  const scaleRef = useRef(scale);
  useLayoutEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Fit-to-width follows the pane's width. A hidden pane (a DOCVIEW-01 view mode, the other pane
  // on a phone) measures 0 and keeps the last width; when it shows again, the reading spot is
  // restored (its scroll position may have been reset while hidden). Any size change — also a
  // height-only one (상하 split) — re-reads the viewport: the pages in view and the page at the
  // reading line. While the splitter is dragged that waits for the release (deferResize).
  const hidden = useRef(false);
  const selectedLocation = useRef<ContentBlock['locations'][number] | null>(null);
  const lastViewport = useRef<{
    layout: PageLayout;
    scrollTop: number;
    height: number;
    scale: number;
  } | null>(null);
  const pendingVisibleHighlight = useRef<ContentBlock['locations'][number] | null>(null);
  useLayoutEffect(() => {
    const next =
      highlights.find((location) => location.bbox !== null && location.page >= 1) ?? null;
    if (selectedLocation.current !== next) pendingVisibleHighlight.current = null;
    selectedLocation.current = next;
  }, [highlights]);
  const restoreAnchor = useRef<() => void>(() => undefined);
  const refreshViewport = useRef<() => void>(() => undefined);
  const deferResizeRef = useRef(deferResize);
  const viewportStale = useRef(false);
  useEffect(() => {
    deferResizeRef.current = deferResize;
    if (deferResize || !viewportStale.current) return;
    viewportStale.current = false;
    refreshViewport.current();
  }, [deferResize]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) {
        hidden.current = true;
        return;
      }
      setContainerWidth(element.clientWidth);
      if (hidden.current) {
        hidden.current = false;
        restoreAnchor.current();
      }
      // A width change in fit mode will replace the page layout. Keep the old reading anchor
      // until that layout arrives; re-reading with the new height and old scale would move it.
      const pendingFitScale =
        zoom === 'fit' &&
        firstPage !== null &&
        Math.abs(
          Math.max(element.clientWidth - 2 * PAGE_PADDING, 200) / firstPage.width -
            scaleRef.current,
        ) > 0.000001;
      if (pendingFitScale) {
        pendingVisibleHighlight.current = null;
        const previous = lastViewport.current;
        const location = selectedLocation.current;
        const pageTop = location ? previous?.layout.tops[location.page - 1] : undefined;
        if (previous && location?.bbox && pageTop !== undefined) {
          const top = pageTop + location.bbox.y0 * previous.scale;
          const bottom = pageTop + location.bbox.y1 * previous.scale;
          pendingVisibleHighlight.current =
            top < previous.scrollTop + previous.height && bottom > previous.scrollTop
              ? location
              : null;
        }
      }
      if (deferResizeRef.current) viewportStale.current = true;
      else if (!pendingFitScale) refreshViewport.current();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [firstPage, load.status, zoom]);

  // Pages are drawn at a settled scale: while the width is still changing, the boxes follow it
  // and the last drawing is stretched.
  const [renderScale, setRenderScale] = useState(scale);
  useEffect(() => {
    if (renderScale === scale || deferResize) return;
    const timer = setTimeout(() => setRenderScale(scale), zoom === 'fit' ? REDRAW_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [deferResize, renderScale, scale, zoom]);

  const layout: PageLayout | null = useMemo(
    () => (pageCount && firstPage ? layoutPages(pageCount, firstPage, sizes, scale) : null),
    [firstPage, pageCount, scale, sizes],
  );
  const layoutRef = useRef(layout);
  const sizesRef = useRef(sizes);
  const firstPageRef = useRef(firstPage);
  useLayoutEffect(() => {
    layoutRef.current = layout;
    sizesRef.current = sizes;
    firstPageRef.current = firstPage;
  }, [firstPage, layout, scale, sizes]);

  // --- scrolling ---------------------------------------------------------------------------

  /** The page this viewer last showed as current (reported to, or received from, the parent). */
  const shownPage = useRef<number | null>(null);
  /** A scroll position we set ourselves: its scroll event is not the reader's. */
  const ownScroll = useRef<number | null>(null);
  /** Where the reading line was, to keep the same spot in view across a zoom. */
  const anchor = useRef<{ page: number; fraction: number }>({ page: 1, fraction: 0 });

  const scrollToTop = useCallback((top: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const max = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    const target = Math.round(Math.min(Math.max(top, 0), max));
    if (Math.abs(scroller.scrollTop - target) < 1) return;
    ownScroll.current = target;
    scroller.scrollTop = target;
  }, []);

  const readViewport = useCallback(() => {
    const scroller = scrollRef.current;
    const current = layoutRef.current;
    if (!scroller || !current || scroller.clientHeight === 0) return null;
    const view = {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
    lastViewport.current = {
      layout: current,
      scrollTop: view.scrollTop,
      height: view.clientHeight,
      scale: scaleRef.current,
    };
    const visible = visiblePages(current, view);
    setRange((prev) =>
      prev.first === visible.first && prev.last === visible.last ? prev : visible,
    );
    const line = view.scrollTop + view.clientHeight * READING_LINE;
    const atLine = Math.min(Math.max(visible.first, 1), current.tops.length);
    let n = atLine;
    for (let p = visible.first; p <= visible.last; p += 1) {
      if ((current.tops[p - 1] ?? 0) <= line) n = p;
    }
    const top = current.tops[n - 1] ?? 0;
    const height = current.heights[n - 1] ?? 1;
    anchor.current = { page: n, fraction: Math.min(Math.max((line - top) / height, 0), 1) };
    return { view, current };
  }, []);

  const reportCurrent = useCallback((read: NonNullable<ReturnType<typeof readViewport>>) => {
    const current = currentPageAt(read.current, read.view);
    if (current !== shownPage.current) {
      shownPage.current = current;
      onPageChangeRef.current(current, 'scroll');
    }
  }, []);

  const onScroll = useCallback(() => {
    const read = readViewport();
    if (!read) return;
    const own = ownScroll.current;
    if (own !== null) {
      ownScroll.current = null;
      if (Math.abs(read.view.scrollTop - own) <= 2) return;
    }
    pendingVisibleHighlight.current = null;
    reportCurrent(read);
  }, [readViewport, reportCurrent]);

  // The area was resized without a scroll (e.g. a taller 상하 pane): new pages may be in view and
  // another page may sit at the reading line.
  useLayoutEffect(() => {
    refreshViewport.current = () => {
      const read = readViewport();
      if (read) reportCurrent(read);
    };
  }, [readViewport, reportCurrent]);

  // Keep the reading spot in place whenever the layout changes: a new scale (zoom, fit width
  // after a resize) or a page whose real size replaced its placeholder.
  const restore = useCallback(() => {
    const scroller = scrollRef.current;
    const current = layoutRef.current;
    if (!scroller || !current || scroller.clientHeight === 0) return;
    const { page: n, fraction } = anchor.current;
    const top = (current.tops[n - 1] ?? 0) + fraction * (current.heights[n - 1] ?? 0);
    scrollToTop(top - scroller.clientHeight * READING_LINE);
    const visibleHighlight = pendingVisibleHighlight.current;
    pendingVisibleHighlight.current = null;
    if (visibleHighlight?.bbox) {
      const pageTop = current.tops[visibleHighlight.page - 1];
      if (pageTop !== undefined) {
        const markTop = pageTop + visibleHighlight.bbox.y0 * scaleRef.current;
        const markBottom = pageTop + visibleHighlight.bbox.y1 * scaleRef.current;
        if (
          markTop >= scroller.scrollTop + scroller.clientHeight ||
          markBottom <= scroller.scrollTop
        ) {
          scrollToTop(markTop - scroller.clientHeight * READING_LINE);
        }
      }
    }
    readViewport();
  }, [readViewport, scrollToTop]);
  useLayoutEffect(() => {
    restoreAnchor.current = restore;
  }, [restore]);
  const laidOut = useRef<PageLayout | null>(null);
  useLayoutEffect(() => {
    if (!layout) return;
    const previous = laidOut.current;
    laidOut.current = layout;
    if (previous === null) {
      readViewport();
      return;
    }
    restore();
  }, [layout, readViewport, restore]);

  // A page or highlight chosen outside (outline, text pane, deep link, toolbar): scroll there
  // immediately — instant, so no intermediate page is reported.
  const shownHighlight = useRef<string | null | undefined>(undefined);
  const hasLayout = layout !== null;
  useLayoutEffect(() => {
    const current = layoutRef.current;
    const scroller = scrollRef.current;
    if (!hasLayout || !current || !scroller) return;
    const target = Math.min(Math.max(page, 1), current.tops.length);
    const highlightChanged = shownHighlight.current !== highlightKey;
    shownHighlight.current = highlightKey;
    const box = highlights.find((l) => l.bbox !== null && l.page >= 1);
    if (scroller.clientHeight === 0) {
      // Hidden (DOCVIEW-01 view mode or narrow-screen pane): nothing can scroll now. Remember the
      // spot instead; showing the viewer again restores it (see the width measurement above).
      if (highlightChanged && box?.bbox && box.page <= current.tops.length) {
        const height = current.heights[box.page - 1] ?? 1;
        anchor.current = {
          page: box.page,
          fraction: Math.min(Math.max((box.bbox.y0 * scaleRef.current) / height, 0), 1),
        };
      } else if (target !== shownPage.current) {
        anchor.current = { page: target, fraction: 0 };
      }
      shownPage.current = target;
      return;
    }
    if (highlightChanged && box?.bbox) {
      const y = (current.tops[box.page - 1] ?? 0) + box.bbox.y0 * scaleRef.current;
      scrollToTop(y - scroller.clientHeight * READING_LINE);
    } else if (target !== shownPage.current) {
      scrollToTop(scrollTopForPage(current, target));
    }
    shownPage.current = target;
    readViewport();
    // `highlights` is read for the jump only; a jump is triggered by the page or the highlight key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLayout, page, highlightKey, readViewport, scrollToTop]);

  // --- drawing -----------------------------------------------------------------------------

  const slots = useRef(new Map<number, HTMLDivElement>());
  const cache = useMemo(
    () => new RenderCache<HTMLCanvasElement>(RENDER_CACHE_PAGES, releaseCanvas),
    // A new document starts a new cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pdf],
  );
  useEffect(() => () => cache.clear(), [cache]);
  const attached = useRef<[number, number]>([1, 1]);

  /** Shows the best drawing of `n` we have (exact scale, else an older one stretched). */
  const attach = useCallback(
    (n: number) => {
      const slot = slots.current.get(n);
      if (!slot) return;
      const [from, to] = attached.current;
      const canvas =
        n >= from && n <= to ? (cache.get(n, renderScale) ?? cache.peek(n)) : undefined;
      if (canvas && slot.firstChild !== canvas) slot.replaceChildren(canvas);
      else if (!canvas && slot.firstChild) slot.replaceChildren();
    },
    [cache, renderScale],
  );

  const slotRef = useCallback(
    (n: number, element: HTMLDivElement | null) => {
      if (element) {
        slots.current.set(n, element);
        attach(n);
      } else {
        slots.current.delete(n);
      }
    },
    [attach],
  );

  // Draw the visible pages first, then their neighbours, one at a time; attach what is drawn and
  // detach pages that scrolled far away (their bitmap stays in the cache for a while). A draw in
  // flight is never cancelled by scrolling: its result is cached even if the page moved away.
  const inflight = useRef(new Map<string, Promise<void>>());
  const tasks = useRef(new Set<PdfRenderTask>());
  useEffect(
    () => () => {
      for (const task of tasks.current) task.cancel();
      tasks.current.clear();
      inflight.current.clear();
    },
    [cache],
  );

  const draw = useCallback(
    (doc: PdfDocument, n: number, drawScale: number): Promise<void> => {
      const key = `${n}@${drawScale}`;
      const running = inflight.current.get(key);
      if (running) return running;
      const job = (async () => {
        const pdfPage = await doc.getPage(n);
        const base = pdfPage.getViewport({ scale: 1 });
        const known = sizesRef.current.get(n) ?? firstPageRef.current;
        if (
          known &&
          (Math.abs(base.width - known.width) > 0.5 || Math.abs(base.height - known.height) > 0.5)
        ) {
          // A page of another size: lay it out at its own box (the effect then draws it).
          setSizes((prev) => new Map(prev).set(n, { width: base.width, height: base.height }));
          return;
        }
        const viewport = pdfPage.getViewport({ scale: drawScale });
        const ratio = canvasRatio(viewport.width, viewport.height, window.devicePixelRatio);
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.className = styles.pageCanvas ?? '';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `PDF ${n}쪽`);
        const task = pdfPage.render({
          canvas,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        tasks.current.add(task);
        try {
          await task.promise;
        } finally {
          tasks.current.delete(task);
        }
        const [from, to] = attached.current;
        cache.set(n, drawScale, canvas, (p) => p >= from && p <= to);
        attach(n);
      })()
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'RenderingCancelledException') return;
          setFailedPages((prev) => new Set(prev).add(n));
        })
        .finally(() => inflight.current.delete(key));
      inflight.current.set(key, job);
      return job;
    },
    [attach, cache],
  );

  useEffect(() => {
    if (!pdf || !layout) return;
    const count = layout.tops.length;
    const first = Math.min(range.first, count);
    const last = Math.min(range.last, count);
    attached.current = attachedRange(first, last, count);
    for (const n of slots.current.keys()) attach(n);
    const current = Math.min(Math.max(shownPage.current ?? 1, first), last);
    const queue = renderOrder(first, last, current, count).filter(
      (n) => !failedPages.has(n) && !cache.get(n, renderScale),
    );
    let stopped = false;
    void (async () => {
      for (const n of queue) {
        if (stopped) return;
        await draw(pdf, n, renderScale);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [attach, cache, draw, failedPages, layout, pdf, range, renderScale]);

  // --- toolbar -----------------------------------------------------------------------------

  const goTo = useCallback(
    (next: number) => {
      if (pageCount === null) return;
      const clamped = Math.min(Math.max(Math.round(next), 1), pageCount);
      if (clamped !== page) onPageChange(clamped, 'navigate');
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

  const currentZoom = zoom === 'fit' ? scale : zoom;
  const zoomPercent = `${Math.round(currentZoom * 100)}%`;

  const byPage = useMemo(() => {
    const map = new Map<number, ContentBlock['locations']>();
    for (const location of highlights) {
      if (!location.bbox) continue;
      map.set(location.page, [...(map.get(location.page) ?? []), location]);
    }
    return map;
  }, [highlights]);
  const labelledPage = highlights.find((l) => l.bbox !== null)?.page ?? null;
  const setHighlightRef = useCallback((element: HTMLDivElement | null) => {
    highlightRef.current = element;
  }, []);

  const toolbar = (
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
  );

  return (
    <div className={`${styles.viewer} ${className ?? ''}`}>
      {toolbarHost === undefined
        ? toolbar
        : toolbarHost
          ? createPortal(toolbar, toolbarHost)
          : null}

      <div
        ref={scrollRef}
        className={styles.pageScroller}
        // The page area scrolls: keyboard users need to reach it (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="group"
        aria-label="PDF 페이지 영역"
        aria-busy={load.status === 'loading' || undefined}
        onScroll={onScroll}
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
        {layout ? (
          <div
            className={styles.pageStack}
            style={{
              height: `${layout.totalHeight}px`,
              minWidth: `${layout.maxWidth + 2 * PAGE_PADDING}px`,
            }}
          >
            {layout.tops.map((top, index) => {
              const n = index + 1;
              return (
                <PageFrame
                  key={n}
                  page={n}
                  top={top}
                  width={layout.widths[index] ?? 0}
                  height={layout.heights[index] ?? 0}
                  scale={scale}
                  highlights={byPage.get(n)}
                  labelledHighlight={labelledPage === n}
                  failed={failedPages.has(n)}
                  slotRef={slotRef}
                  highlightRef={setHighlightRef}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
