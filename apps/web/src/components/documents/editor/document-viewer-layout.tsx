'use client';

// DOCVIEW-01 PDF 열람 보기 설정 (docs/screens/documents-viewer-layout.md): the layout of the DOC-02
// document screen and the WS-VIEW-01 shared document view. A "보기 설정" bar (outline toggle,
// 보기 방식, 분할 방향, 위치 바꾸기), the outline in a left docked FloatingSidePanel (inset on
// desktop, overlay on tablets, full-height panel on narrow screens) and 원본 / 변환본 in a SplitView.
// Hidden panes stay mounted (`hidden`), so edits, the PDF page and scroll positions survive mode
// switches; swapping reorders keyed panes, which moves their DOM instead of remounting it.
// Settings live in this browser only (lib/documents/viewer-settings.ts); nothing here calls the API
// or touches the address.
import { FloatingSidePanel, SplitView } from '@quiz/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  firstPaneRatio,
  isOverOtherPane,
  layoutAnnouncement,
  narrowInitialPane,
  paneOrder,
  pdfRatioFromFirst,
  splitValueText,
  swappedOrder,
  viewerSettingsStore,
  viewerWidthFor,
  type PaneId,
  type SplitOrientation,
  type ViewerSettings,
  type ViewerWidth,
  type ViewMode,
} from '@/lib/documents/viewer-settings';
import { fitAreaToViewport } from './viewer-fit';
import styles from './viewer-layout.module.css';

// --- width class ---------------------------------------------------------------------------------

const WIDTH_QUERIES = ['(min-width: 768px)', '(min-width: 1024px)'] as const;

function subscribeWidth(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const lists = WIDTH_QUERIES.map((query) => window.matchMedia(query));
  lists.forEach((list) => list.addEventListener('change', listener));
  return () => lists.forEach((list) => list.removeEventListener('change', listener));
}

function currentWidth(): ViewerWidth {
  if (typeof window.matchMedia !== 'function') return viewerWidthFor(window.innerWidth || 1280);
  if (window.matchMedia(WIDTH_QUERIES[1]).matches) return 'desktop';
  return window.matchMedia(WIDTH_QUERIES[0]).matches ? 'tablet' : 'narrow';
}

const serverWidth = (): ViewerWidth => 'desktop';
/** The server renders no layout (the settings are not known there): see DocumentViewerLayout. */
const serverSettings = (): ViewerSettings | null => null;

// --- controller ----------------------------------------------------------------------------------

export interface DocumentViewer {
  /** null until the client has read the stored settings (the server renders a skeleton). */
  readonly settings: ViewerSettings | null;
  readonly width: ViewerWidth;
  readonly pdfVisible: boolean;
  readonly textVisible: boolean;
  /** A splitter drag is in progress (the PDF canvas waits for the release to redraw). */
  readonly resizing: boolean;
  /** Call after an outline jump: tablets fold the panel, narrow screens close it and show 원본. */
  outlineChosen(): void;
  /** Call after a text block was chosen: narrow screens switch to 원본. */
  blockChosen(): void;
  /** Internal state for DocumentViewerLayout. */
  readonly internal: ViewerInternal;
}

interface ViewerInternal {
  readonly narrowPane: PaneId;
  setNarrowPane(pane: PaneId): void;
  readonly outlineOpen: boolean;
  setOutlineOpen(open: boolean): void;
  readonly liveRatio: number | null;
  setLiveRatio(ratio: number | null): void;
}

/** The viewer's settings and per-width state; pass the result to DocumentViewerLayout. */
export function useDocumentViewer(): DocumentViewer {
  const settings = useSyncExternalStore(
    viewerSettingsStore.subscribe,
    viewerSettingsStore.getSnapshot,
    serverSettings,
  );
  const width = useSyncExternalStore(subscribeWidth, currentWidth, serverWidth);
  // Narrow-screen and tablet state is never saved; it starts over whenever the width class changes.
  const [narrowPane, setNarrowPane] = useState<PaneId | null>(null);
  const [tabletOutlineOpen, setTabletOutlineOpen] = useState(false);
  const [narrowOutlineOpen, setNarrowOutlineOpen] = useState(false);
  const [seenWidth, setSeenWidth] = useState(width);
  if (seenWidth !== width) {
    setSeenWidth(width);
    setNarrowPane(null);
    setTabletOutlineOpen(false);
    setNarrowOutlineOpen(false);
  }
  const [liveRatio, setLiveRatio] = useState<number | null>(null);

  const mode: ViewMode = settings?.mode ?? 'both';
  const shownNarrow = narrowPane ?? narrowInitialPane(mode);
  const pdfVisible = width === 'narrow' ? shownNarrow === 'pdf' : mode !== 'text';
  const textVisible = width === 'narrow' ? shownNarrow === 'text' : mode !== 'pdf';
  const outlineOpen =
    width === 'desktop'
      ? (settings?.outlineOpen ?? false)
      : width === 'tablet'
        ? tabletOutlineOpen
        : narrowOutlineOpen;

  const setOutlineOpen = useCallback(
    (open: boolean) => {
      if (width === 'desktop') viewerSettingsStore.update({ outlineOpen: open });
      else if (width === 'tablet') setTabletOutlineOpen(open);
      else setNarrowOutlineOpen(open);
    },
    [width],
  );

  const outlineChosen = useCallback(() => {
    if (width === 'tablet') setTabletOutlineOpen(false);
    if (width === 'narrow') {
      setNarrowOutlineOpen(false);
      setNarrowPane('pdf');
    }
  }, [width]);

  const blockChosen = useCallback(() => {
    if (width === 'narrow') setNarrowPane('pdf');
  }, [width]);

  return {
    settings,
    width,
    pdfVisible,
    textVisible,
    resizing: liveRatio !== null,
    outlineChosen,
    blockChosen,
    internal: {
      narrowPane: shownNarrow,
      setNarrowPane,
      outlineOpen,
      setOutlineOpen,
      liveRatio,
      setLiveRatio,
    },
  };
}

// --- layout --------------------------------------------------------------------------------------

export interface DocumentViewerLayoutProps {
  readonly viewer: DocumentViewer;
  /** The outline content (nav + DocumentOutlineTree, or a loading/empty note). */
  readonly outline: ReactNode;
  /** The 원본 pane body (PdfViewer). */
  readonly pdf: ReactNode;
  /** The 변환본 pane body (text blocks). */
  readonly text: ReactNode;
  /** Heading level of the pane titles (2 under the DOC-02 h1, 3 under the shared view's h2). */
  readonly headingLevel?: 2 | 3;
}

const PANE_TITLE: Record<PaneId, string> = { pdf: '원본', text: '변환본' };
const PANE_REGION: Record<PaneId, string> = { pdf: 'PDF 원본', text: '변환본 텍스트' };

const MODE_OPTIONS: readonly RadioOption<ViewMode>[] = [
  { value: 'both', label: '함께 보기', name: '원본과 변환본 함께 보기' },
  { value: 'pdf', label: '원본', name: 'PDF 원본만 보기' },
  { value: 'text', label: '변환본', name: '변환본 텍스트만 보기' },
];

const ORIENTATION_OPTIONS: readonly RadioOption<SplitOrientation>[] = [
  { value: 'horizontal', label: '좌우', name: '좌우로 나누기' },
  { value: 'vertical', label: '상하', name: '상하로 나누기' },
];

const SPLIT_MIN_SIZE = { horizontal: 320, vertical: 200 } as const;
/** Pointer travel before a pane-header press becomes a drag. */
const DRAG_SLOP_PX = 4;

interface HeaderDrag {
  readonly pane: PaneId;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
  cancelled: boolean;
}

export function DocumentViewerLayout({
  viewer,
  outline,
  pdf,
  text,
  headingLevel = 2,
}: DocumentViewerLayoutProps) {
  const { settings, width, internal } = viewer;
  const panelId = useId();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // The split area fills the viewport height the rest of the page leaves (viewer-fit.ts).
  useEffect(() => (host ? fitAreaToViewport(host) : undefined), [host]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const outlineBodyRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Record<PaneId, HTMLElement | null>>({ pdf: null, text: null });
  const handleRefs = useRef<Record<PaneId, HTMLButtonElement | null>>({ pdf: null, text: null });
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<{ pane: PaneId; over: boolean } | null>(null);
  const dragRef = useRef<HeaderDrag | null>(null);
  const suppressClickRef = useRef(false);
  const refocusHandleRef = useRef<PaneId | null>(null);

  const order = settings?.order ?? 'pdf-first';
  const orientation = settings?.orientation ?? 'horizontal';
  const both = width !== 'narrow' && settings?.mode === 'both';

  const swap = useCallback(() => {
    const current = viewerSettingsStore.getSnapshot();
    const next = swappedOrder(current.order);
    viewerSettingsStore.update({ order: next });
    setAnnouncement(layoutAnnouncement(current.orientation, next));
  }, []);

  // A swap started from a pane handle keeps focus on that handle after its pane moved.
  useEffect(() => {
    const pane = refocusHandleRef.current;
    refocusHandleRef.current = null;
    const handle = pane ? handleRefs.current[pane] : null;
    if (handle && document.activeElement !== handle) handle.focus();
  }, [order]);

  // Escape cancels a pane-header drag.
  useEffect(() => {
    if (!dragging) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current.cancelled = true;
      setDragging(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragging]);

  if (!settings) {
    // Server render and hydration: the stored layout is unknown, so nothing is laid out yet.
    return <div className={styles.skeleton} aria-busy="true" />;
  }

  const [firstPane, secondPane] = paneOrder(order);
  const visible: 'both' | 'first' | 'second' = both
    ? 'both'
    : width === 'narrow'
      ? internal.narrowPane === firstPane
        ? 'first'
        : 'second'
      : settings.mode === firstPane
        ? 'first'
        : 'second';
  const ratio = internal.liveRatio ?? firstPaneRatio(order, settings.pdfRatio);

  /** The pointer is over the other pane (or in the gap past the separator towards it). */
  const overOther = (pane: PaneId, x: number, y: number): boolean => {
    const self = paneRefs.current[pane]?.getBoundingClientRect();
    const other = paneRefs.current[pane === 'pdf' ? 'text' : 'pdf']?.getBoundingClientRect();
    return self && other ? isOverOtherPane(orientation, self, other, x, y) : false;
  };

  const onHandlePointerDown = (pane: PaneId, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // No text selection (and no compatibility mousedown) starts from the handle.
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or released pointers cannot be captured; their events still reach the handle.
    }
    dragRef.current = {
      pane,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      cancelled: false,
    };
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.cancelled) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_SLOP_PX
    ) {
      return;
    }
    drag.moved = true;
    const over = overOther(drag.pane, event.clientX, event.clientY);
    setDragging((prev) =>
      prev && prev.pane === drag.pane && prev.over === over ? prev : { pane: drag.pane, over },
    );
  };

  const endHeaderDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Nothing captured.
    }
    setDragging(null);
    if (!drag.moved) return;
    // The click that follows a drag release is not a keyboard-style swap.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (!cancelled && !drag.cancelled && overOther(drag.pane, event.clientX, event.clientY)) {
      refocusHandleRef.current = drag.pane;
      swap();
    }
  };

  const onHandleClick = (id: PaneId) => {
    if (suppressClickRef.current) return;
    refocusHandleRef.current = id;
    swap();
  };
  const registerPane = (id: PaneId, el: HTMLElement | null) => {
    paneRefs.current[id] = el;
  };
  const registerHandle = (id: PaneId, el: HTMLButtonElement | null) => {
    handleRefs.current[id] = el;
  };
  const bodies: Record<PaneId, ReactNode> = { pdf, text };
  const [firstPaneNode, secondPaneNode] = [firstPane, secondPane].map((id) => (
    <ViewerPane
      key={id}
      id={id}
      body={bodies[id]}
      headingLevel={headingLevel}
      handle={both}
      dragged={dragging?.pane === id}
      dropTarget={dragging !== null && dragging.over && dragging.pane !== id}
      registerPane={registerPane}
      registerHandle={registerHandle}
      onHandlePointerDown={onHandlePointerDown}
      onHandlePointerMove={onHandlePointerMove}
      onHandlePointerEnd={endHeaderDrag}
      onHandleClick={onHandleClick}
    />
  ));

  const outlineOpen = internal.outlineOpen;
  const outlinePanel = (
    <FloatingSidePanel
      key={width}
      id={panelId}
      open={outlineOpen}
      onOpenChange={internal.setOutlineOpen}
      title="목차"
      closeLabel={width === 'narrow' ? '목차 닫기' : '목차 접기'}
      side="start"
      className={styles.outlinePanel}
      {...(width === 'narrow'
        ? { placement: 'viewport' as const, mobileLayout: 'full' as const }
        : {
            placement: 'docked' as const,
            container: host,
            dockMode: width === 'desktop' ? ('inset' as const) : ('overlay' as const),
          })}
      onOpenAutoFocus={(event) => {
        // A user open lands on the tree's current item (the roving tab stop), when there is one.
        const item = outlineBodyRef.current?.querySelector<HTMLElement>(
          '[role="treeitem"][tabindex="0"]',
        );
        if (!item) return;
        event.preventDefault();
        item.focus();
      }}
      onCloseAutoFocus={(event) => {
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected;
        if (lost && toggleRef.current) {
          event.preventDefault();
          toggleRef.current.focus();
        }
      }}
    >
      <div ref={outlineBodyRef}>{outline}</div>
    </FloatingSidePanel>
  );

  return (
    <div className={styles.viewer} data-width={width}>
      <div role="group" aria-label="보기 설정" className={styles.bar}>
        {width === 'narrow' ? (
          <>
            <div role="group" aria-label="보기 선택" className={styles.segmented}>
              {(['pdf', 'text'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.segment} qz-focus-ring`}
                  aria-pressed={internal.narrowPane === id}
                  onClick={() => internal.setNarrowPane(id)}
                >
                  {PANE_TITLE[id]}
                </button>
              ))}
            </div>
            <button
              ref={toggleRef}
              type="button"
              className={`${styles.barButton} qz-focus-ring`}
              aria-expanded={outlineOpen}
              aria-controls={panelId}
              onClick={() => internal.setOutlineOpen(!outlineOpen)}
            >
              목차
            </button>
          </>
        ) : (
          <>
            <button
              ref={toggleRef}
              type="button"
              className={`${styles.barButton} qz-focus-ring`}
              aria-expanded={outlineOpen}
              aria-controls={panelId}
              aria-label={outlineOpen ? '목차 접기' : '목차 펼치기'}
              onClick={() => internal.setOutlineOpen(!outlineOpen)}
            >
              <span aria-hidden="true" className={styles.outlineIcon} data-open={outlineOpen} />
              목차
            </button>
            <SegmentedRadioGroup
              label="보기 방식"
              options={MODE_OPTIONS}
              value={settings.mode}
              onChange={(mode) => viewerSettingsStore.update({ mode })}
            />
            {both ? (
              <>
                <SegmentedRadioGroup
                  label="분할 방향"
                  options={ORIENTATION_OPTIONS}
                  value={orientation}
                  onChange={(next) => viewerSettingsStore.update({ orientation: next })}
                />
                <button
                  type="button"
                  className={`${styles.barButton} qz-focus-ring`}
                  aria-label="원본과 변환본 위치 바꾸기"
                  onClick={swap}
                >
                  <span
                    aria-hidden="true"
                    className={styles.swapIcon}
                    data-orientation={orientation}
                  >
                    ⇄
                  </span>
                  위치 바꾸기
                </button>
              </>
            ) : null}
          </>
        )}
      </div>

      <div
        ref={setHost}
        className={styles.area}
        // Set in the same commit as the panel's open state (FloatingSidePanel also sets it from an
        // effect), so the panes never keep the inset for a frame after the panel folded.
        data-qz-dock-inset={width === 'desktop' && outlineOpen ? 'start' : undefined}
      >
        <SplitView
          className={styles.split}
          orientation={orientation}
          ratio={ratio}
          minSize={SPLIT_MIN_SIZE}
          separatorLabel="원본과 변환본 크기 조절"
          valueText={(first) => splitValueText(order, first)}
          visible={visible}
          onRatioChange={internal.setLiveRatio}
          onRatioCommit={(first) => {
            internal.setLiveRatio(null);
            viewerSettingsStore.update({ pdfRatio: pdfRatioFromFirst(order, first) });
          }}
        >
          {[firstPaneNode, secondPaneNode]}
        </SplitView>
        {outlinePanel}
      </div>

      <p className="qz-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

// --- pane ----------------------------------------------------------------------------------------

interface ViewerPaneProps {
  readonly id: PaneId;
  readonly body: ReactNode;
  readonly headingLevel: 2 | 3;
  /** 함께 보기 (desktop/tablet): the header has the drag handle. */
  readonly handle: boolean;
  readonly dragged: boolean;
  /** The other pane's handle is dragged over this pane: it shows the drop hint. */
  readonly dropTarget: boolean;
  readonly registerPane: (id: PaneId, el: HTMLElement | null) => void;
  readonly registerHandle: (id: PaneId, el: HTMLButtonElement | null) => void;
  readonly onHandlePointerDown: (id: PaneId, event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onHandlePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onHandlePointerEnd: (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled: boolean,
  ) => void;
  readonly onHandleClick: (id: PaneId) => void;
}

/** One pane: region (named for the pane) with a header (title + drag handle) above its body. */
function ViewerPane({
  id,
  body,
  headingLevel,
  handle,
  dragged,
  dropTarget,
  registerPane,
  registerHandle,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerEnd,
  onHandleClick,
}: ViewerPaneProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      ref={(el) => registerPane(id, el)}
      aria-label={PANE_REGION[id]}
      className={styles.pane}
      data-pane={id}
      data-dragged={dragged || undefined}
    >
      <div className={styles.paneHeader}>
        <Heading className={styles.paneTitle}>{PANE_TITLE[id]}</Heading>
        {handle ? (
          <button
            ref={(el) => registerHandle(id, el)}
            type="button"
            className={`${styles.paneHandle} qz-focus-ring`}
            aria-label={`${PANE_TITLE[id]} 위치 옮기기`}
            title="끌어서 위치 바꾸기"
            onPointerDown={(event) => onHandlePointerDown(id, event)}
            onPointerMove={onHandlePointerMove}
            onPointerUp={(event) => onHandlePointerEnd(event, false)}
            onPointerCancel={(event) => onHandlePointerEnd(event, true)}
            onClick={() => onHandleClick(id)}
          >
            <span aria-hidden="true" className={styles.grip} />
          </button>
        ) : null}
      </div>
      {body}
      {dropTarget ? (
        <div className={styles.dropTarget}>
          <p className={styles.dropHint}>여기에 놓아 위치 바꾸기</p>
        </div>
      ) : null}
    </section>
  );
}

// --- segmented radio group -------------------------------------------------------------------------

interface RadioOption<T extends string> {
  readonly value: T;
  /** Visible text. */
  readonly label: string;
  /** Accessible name (the visible text spelled out). */
  readonly name: string;
}

/**
 * Segmented `radiogroup` (one tab stop; arrows, Home/End move and select). The checked option has
 * the surface background and bold text, not only a color change (design-system §4.1).
 */
function SegmentedRadioGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly RadioOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[(next + options.length) % options.length];
    if (!option) return;
    onChange(option.value);
    refs.current.get(option.value)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={styles.segmented}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              if (el) refs.current.set(option.value, el);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.name}
            tabIndex={checked ? 0 : -1}
            className={`${styles.segment} qz-focus-ring`}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
