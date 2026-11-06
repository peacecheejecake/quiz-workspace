'use client';

// DOCVIEW-01 PDF 열람 보기 설정 (docs/screens/documents-viewer-layout.md): the layout of the DOC-02
// document screen and the WS-VIEW-01 shared document view. A "보기 설정" bar (outline toggle,
// 보기 방식, 분할 방향, 위치 바꾸기), the outline in a left docked FloatingSidePanel (inset on
// desktop, overlay on tablets, full-height panel on narrow screens) and 원본 / 변환본 in a SplitView.
// Hidden panes stay mounted (`hidden`), so edits, the PDF page and scroll positions survive mode
// switches; swapping reorders keyed panes, which moves their DOM instead of remounting it.
// Settings live in this browser only (lib/documents/viewer-settings.ts); nothing here calls the API
// or touches the address. The chrome is a glass bar over the panes: it hides after 3 seconds without
// moving them, and comes back from the top edge, a tap on the PDF or keyboard focus (UX12-PDFPREVIEW).
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
import styles from './viewer-layout.module.css';
import { ViewerToolbarContext } from './viewer-toolbar-context';

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
  /** Call after an outline jump to close the tablet or mobile outline. */
  outlineChosen(): void;
  /** Called after a text block was chosen; both selected panes remain visible. */
  blockChosen(): void;
  /** Internal state for DocumentViewerLayout. */
  readonly internal: ViewerInternal;
}

interface ViewerInternal {
  readonly outlineOpen: boolean;
  setOutlineOpen(open: boolean): void;
  readonly mobileRatio: number;
  setMobileRatio(ratio: number): void;
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
  const [tabletOutlineOpen, setTabletOutlineOpen] = useState(false);
  const [narrowOutlineOpen, setNarrowOutlineOpen] = useState(false);
  const [seenWidth, setSeenWidth] = useState(width);
  if (seenWidth !== width) {
    setSeenWidth(width);
    setTabletOutlineOpen(false);
    setNarrowOutlineOpen(false);
  }
  const [liveRatio, setLiveRatio] = useState<number | null>(null);
  const [mobileRatio, setMobileRatio] = useState(50);

  const mode: ViewMode = settings?.mode ?? 'pdf';
  const pdfVisible = mode !== 'text';
  const textVisible = mode !== 'pdf';
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
    }
  }, [width]);

  const blockChosen = useCallback(() => undefined, []);

  return {
    settings,
    width,
    pdfVisible,
    textVisible,
    resizing: liveRatio !== null,
    outlineChosen,
    blockChosen,
    internal: {
      outlineOpen,
      setOutlineOpen,
      liveRatio,
      setLiveRatio,
      mobileRatio,
      setMobileRatio,
    },
  };
}

// --- layout --------------------------------------------------------------------------------------

export interface DocumentViewerLayoutProps {
  readonly viewer: DocumentViewer;
  readonly chrome?: ReactNode;
  readonly preventAutoHide?: boolean;
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

const ORIENTATION_OPTIONS: readonly RadioOption<SplitOrientation>[] = [
  { value: 'horizontal', label: '좌우', name: '좌우로 나누기' },
  { value: 'vertical', label: '상하', name: '상하로 나누기' },
];

const SPLIT_MIN_SIZE = { horizontal: 320, vertical: 200 } as const;
/** Pointer travel before a pane-header press becomes a drag. */
const DRAG_SLOP_PX = 4;
/** A touch that stays this close, this briefly, is a tap on the page rather than a scroll. */
const TAP_SLOP_PX = 10;
const TAP_MS = 500;
const TAP_IGNORED = 'a, button, input, select, textarea, label, [role="separator"]';

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
  chrome,
  preventAutoHide = false,
  outline,
  pdf,
  text,
  headingLevel = 2,
}: DocumentViewerLayoutProps) {
  const { settings, width, internal } = viewer;
  const panelId = useId();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const showToolsRef = useRef<HTMLButtonElement>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chromeFocused, setChromeFocused] = useState(false);
  const [alertVisible, setAlertVisible] = useState(false);
  const [activity, setActivity] = useState(0);
  const showChrome = useCallback(() => {
    setChromeVisible(true);
    setActivity((n) => n + 1);
  }, []);
  const chromeShown = chromeVisible || preventAutoHide || alertVisible || chromeFocused;
  const chromeShownRef = useRef(chromeShown);
  useEffect(() => {
    chromeShownRef.current = chromeShown;
  }, [chromeShown]);
  useEffect(() => {
    if (!preventAutoHide && !alertVisible) return undefined;
    const timer = window.setTimeout(showChrome, 0);
    return () => window.clearTimeout(timer);
  }, [preventAutoHide, alertVisible, showChrome]);
  useEffect(() => {
    if (preventAutoHide || alertVisible || chromeFocused) return undefined;
    let timer: number;
    const hide = () => {
      if (
        document.querySelector(
          '[role="menu"], [role="dialog"]:not([data-modal="false"]), [role="alertdialog"]',
        )
      ) {
        timer = window.setTimeout(hide, 300);
      } else {
        setChromeVisible(false);
      }
    };
    timer = window.setTimeout(hide, 3000);
    return () => window.clearTimeout(timer);
  }, [activity, preventAutoHide, alertVisible, chromeFocused]);
  useEffect(() => {
    const root = viewerRef.current;
    if (!host || !root) return undefined;
    const update = () =>
      setAlertVisible(
        Array.from(root.querySelectorAll('[role="alert"]')).some(
          (alert) => !alert.closest('[hidden]'),
        ),
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'role'],
    });
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    const root = viewerRef.current;
    if (!host || !root) return undefined;
    const original = new Map<HTMLElement, boolean>();
    const parents: HTMLElement[] = [];
    let child: HTMLElement = root;
    while (child.parentElement) {
      const parent = child.parentElement;
      parents.push(parent);
      child = parent;
    }
    let initialized = false;
    const sync = () => {
      let current: HTMLElement = root;
      for (const parent of parents) {
        for (const sibling of parent.children) {
          if (
            !(sibling instanceof HTMLElement) ||
            sibling === current ||
            sibling.matches(
              'script, style, link, [data-radix-portal], [data-radix-focus-guard], [data-app-global-control="practice-return"], [aria-live], [role="status"], [role="alert"]',
            )
          )
            continue;
          // Portalled menus and dialogs are appended to body after the viewer mounts.
          if (parent === document.body && initialized && !original.has(sibling)) continue;
          if (!original.has(sibling)) original.set(sibling, sibling.inert);
          if (sibling.contains(document.activeElement)) showToolsRef.current?.focus();
          sibling.inert = true;
        }
        current = parent;
      }
      initialized = true;
    };
    sync();
    const observer = new MutationObserver(sync);
    parents.forEach((parent) => observer.observe(parent, { childList: true }));
    return () => {
      observer.disconnect();
      original.forEach((inert, element) => {
        element.inert = inert;
      });
    };
  }, [host]);
  useEffect(() => {
    const chrome = chromeRef.current;
    if (!host || !chrome) return undefined;
    const update = () =>
      host.style.setProperty('--viewer-chrome-height', `${chrome.offsetHeight}px`);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => {
    if (!toolbarHost) return undefined;
    const onFocus = (event: FocusEvent) => {
      setChromeFocused(true);
      showChrome();
      (event.target as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const onBlur = (event: FocusEvent) => {
      if (!toolbarHost.contains(event.relatedTarget as Node | null)) setChromeFocused(false);
    };
    toolbarHost.addEventListener('focusin', onFocus);
    toolbarHost.addEventListener('focusout', onBlur);
    toolbarHost.addEventListener('pointerdown', showChrome);
    toolbarHost.addEventListener('pointermove', showChrome);
    return () => {
      toolbarHost.removeEventListener('focusin', onFocus);
      toolbarHost.removeEventListener('focusout', onBlur);
      toolbarHost.removeEventListener('pointerdown', showChrome);
      toolbarHost.removeEventListener('pointermove', showChrome);
    };
  }, [toolbarHost, showChrome]);
  // A touch has no hover, so a tap on the PDF toggles the chrome. Whether it was shown is read at the
  // press: the top-edge rule below may show it before the release.
  useEffect(() => {
    if (!host) return undefined;
    let press: { id: number; x: number; y: number; at: number; shown: boolean } | null = null;
    const onDown = (event: globalThis.PointerEvent) => {
      press = null;
      if (event.pointerType === 'mouse' || event.isPrimary === false) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('[data-pane="pdf"]')) return;
      if (target.closest(TAP_IGNORED)) return;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
        shown: chromeShownRef.current,
      };
    };
    const onUp = (event: globalThis.PointerEvent) => {
      const down = press;
      press = null;
      if (!down || event.pointerId !== down.id || Date.now() - down.at > TAP_MS) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (moved > TAP_SLOP_PX) return;
      if (down.shown) setChromeVisible(false);
      else showChrome();
    };
    const onCancel = () => {
      press = null;
    };
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointerup', onUp, true);
    host.addEventListener('pointercancel', onCancel, true);
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointerup', onUp, true);
      host.removeEventListener('pointercancel', onCancel, true);
    };
  }, [host, showChrome]);
  useEffect(() => {
    const onPointer = (event: globalThis.PointerEvent) => {
      if (event.clientY <= 48) showChrome();
    };
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [showChrome]);
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
  const orientation = width === 'narrow' ? 'vertical' : (settings?.orientation ?? 'horizontal');
  const both = settings?.mode === 'both';

  const swap = useCallback(() => {
    const current = viewerSettingsStore.getSnapshot();
    const next = swappedOrder(current.order);
    viewerSettingsStore.update({ order: next });
    setAnnouncement(
      layoutAnnouncement(width === 'narrow' ? 'vertical' : current.orientation, next),
    );
  }, [width]);

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
    : settings.mode === firstPane
      ? 'first'
      : 'second';
  const ratio =
    internal.liveRatio ??
    (width === 'narrow'
      ? firstPaneRatio(order, internal.mobileRatio)
      : firstPaneRatio(order, settings.pdfRatio));

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
    <div
      ref={viewerRef}
      className={styles.viewer}
      data-width={width}
      data-chrome-pinned={preventAutoHide || alertVisible || undefined}
    >
      <button
        ref={showToolsRef}
        type="button"
        className="qz-visually-hidden"
        onFocus={showChrome}
        onClick={showChrome}
      >
        보기 도구 표시
      </button>
      {/* Activity tracking does not make the chrome itself an interactive control. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={chromeRef}
        className={`${styles.chrome} glass-surface`}
        data-hidden={!chromeShown || undefined}
        onPointerDown={showChrome}
        onPointerMove={showChrome}
        onKeyDown={showChrome}
        onFocus={(event) => {
          setChromeFocused(true);
          showChrome();
          event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setChromeFocused(false);
        }}
      >
        {chrome}
        <div role="group" aria-label="보기 설정" className={styles.bar}>
          <button
            ref={toggleRef}
            type="button"
            className={`${styles.barButton} qz-focus-ring`}
            aria-expanded={outlineOpen}
            aria-label={outlineOpen ? '목차 접기' : '목차 펼치기'}
            aria-controls={panelId}
            onClick={() => internal.setOutlineOpen(!outlineOpen)}
          >
            목차
          </button>
          <div role="group" aria-label="보기 선택" className={styles.segmented}>
            {(['pdf', 'text'] as const).map((id) => {
              const checked = settings.mode === 'both' || settings.mode === id;
              return (
                <label key={id} className={styles.segment}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      if (checked && settings.mode !== 'both') {
                        setAnnouncement('하나 이상 선택하세요');
                        return;
                      }
                      viewerSettingsStore.update({
                        mode: checked ? (id === 'pdf' ? 'text' : 'pdf') : 'both',
                      });
                    }}
                  />{' '}
                  {PANE_TITLE[id]}
                </label>
              );
            })}
          </div>
          {both && width !== 'narrow' ? (
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
                위치 바꾸기
              </button>
            </>
          ) : null}
        </div>
        <div ref={setToolbarHost} className={styles.toolbarHost} hidden={!viewer.pdfVisible} />
      </div>
      <div
        ref={setHost}
        className={styles.area}
        // Set in the same commit as the panel's open state (FloatingSidePanel also sets it from an
        // effect), so the panes never keep the inset for a frame after the panel folded.
        data-qz-dock-inset={width === 'desktop' && outlineOpen ? 'start' : undefined}
      >
        <ViewerToolbarContext.Provider value={toolbarHost}>
          <SplitView
            className={styles.split}
            orientation={orientation}
            ratio={ratio}
            minSize={width === 'narrow' ? { horizontal: 0, vertical: 112 } : SPLIT_MIN_SIZE}
            separatorLabel="원본과 변환본 크기 조절"
            valueText={(first) => splitValueText(order, first)}
            visible={visible}
            onRatioChange={internal.setLiveRatio}
            onRatioCommit={(first) => {
              internal.setLiveRatio(null);
              if (width === 'narrow') internal.setMobileRatio(pdfRatioFromFirst(order, first));
              else viewerSettingsStore.update({ pdfRatio: pdfRatioFromFirst(order, first) });
            }}
          >
            {[firstPaneNode, secondPaneNode]}
          </SplitView>
        </ViewerToolbarContext.Provider>
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
