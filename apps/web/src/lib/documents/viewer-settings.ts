// DOCVIEW-01 보기 설정 (docs/screens/documents-viewer-layout.md "설정 저장"): one browser-wide setting
// for the DOC-02 document screen and the WS-VIEW-01 shared document view, kept only in this
// browser's localStorage under `quiz.documentViewer.v1`. Never sent to the server or the URL.
// Every read and write is guarded: unusable storage, broken JSON or unknown/out-of-range fields
// fall back per field to the defaults (pdfRatio is clamped to 20…80) without an error.

export const VIEWER_SETTINGS_KEY = 'quiz.documentViewer.v1';

export type ViewMode = 'both' | 'pdf' | 'text';
/** `horizontal` = 좌우 (side by side), `vertical` = 상하 (stacked). */
export type SplitOrientation = 'horizontal' | 'vertical';
export type PaneOrder = 'pdf-first' | 'text-first';
export type PaneId = 'pdf' | 'text';

export interface ViewerSettings {
  readonly mode: ViewMode;
  readonly orientation: SplitOrientation;
  readonly order: PaneOrder;
  /** The PDF (원본) pane's share in %, whatever its position (20…80). */
  readonly pdfRatio: number;
  /** Desktop only: tablets start collapsed and narrow screens use a full-height panel. */
  readonly outlineOpen: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  mode: 'both',
  orientation: 'horizontal',
  order: 'pdf-first',
  pdfRatio: 50,
  outlineOpen: true,
};

export const MIN_PDF_RATIO = 20;
export const MAX_PDF_RATIO = 80;

const MODES: readonly ViewMode[] = ['both', 'pdf', 'text'];
const ORIENTATIONS: readonly SplitOrientation[] = ['horizontal', 'vertical'];
const ORDERS: readonly PaneOrder[] = ['pdf-first', 'text-first'];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** An integer PDF share within 20…80; anything that is not a finite number is the default. */
export function clampPdfRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VIEWER_SETTINGS.pdfRatio;
  return Math.min(MAX_PDF_RATIO, Math.max(MIN_PDF_RATIO, Math.round(value)));
}

/** Parses a stored value field by field; never throws. Unknown fields are dropped. */
export function parseViewerSettings(raw: string | null | undefined): ViewerSettings {
  if (raw === null || raw === undefined) return DEFAULT_VIEWER_SETTINGS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_VIEWER_SETTINGS;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return DEFAULT_VIEWER_SETTINGS;
  }
  const record = data as Record<string, unknown>;
  const d = DEFAULT_VIEWER_SETTINGS;
  return {
    mode: oneOf(record.mode, MODES, d.mode),
    orientation: oneOf(record.orientation, ORIENTATIONS, d.orientation),
    order: oneOf(record.order, ORDERS, d.order),
    pdfRatio: 'pdfRatio' in record ? clampPdfRatio(record.pdfRatio) : d.pdfRatio,
    outlineOpen: typeof record.outlineOpen === 'boolean' ? record.outlineOpen : d.outlineOpen,
  };
}

export function serializeViewerSettings(settings: ViewerSettings): string {
  const { mode, orientation, order, pdfRatio, outlineOpen } = settings;
  return JSON.stringify({ mode, orientation, order, pdfRatio, outlineOpen });
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The stored settings, or the defaults when storage is missing, blocked or holds junk. */
export function readStoredViewerSettings(storage: StorageLike | null): ViewerSettings {
  if (!storage) return DEFAULT_VIEWER_SETTINGS;
  try {
    return parseViewerSettings(storage.getItem(VIEWER_SETTINGS_KEY));
  } catch {
    return DEFAULT_VIEWER_SETTINGS;
  }
}

/** Saves the settings; false when storage is missing or refuses (the page keeps them anyway). */
export function writeStoredViewerSettings(
  storage: StorageLike | null,
  settings: ViewerSettings,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(VIEWER_SETTINGS_KEY, serializeViewerSettings(settings));
    return true;
  } catch {
    return false;
  }
}

// --- pane order and ratio --------------------------------------------------------------------

export function paneOrder(order: PaneOrder): readonly [PaneId, PaneId] {
  return order === 'pdf-first' ? ['pdf', 'text'] : ['text', 'pdf'];
}

/** The first pane's share (SplitView `ratio`) for a stored PDF share. */
export function firstPaneRatio(order: PaneOrder, pdfRatio: number): number {
  return order === 'pdf-first' ? pdfRatio : 100 - pdfRatio;
}

/** The PDF share for a first-pane share reported by SplitView. */
export function pdfRatioFromFirst(order: PaneOrder, firstRatio: number): number {
  return clampPdfRatio(order === 'pdf-first' ? firstRatio : 100 - firstRatio);
}

export function swappedOrder(order: PaneOrder): PaneOrder {
  return order === 'pdf-first' ? 'text-first' : 'pdf-first';
}

/** The live-region text after a swap: "변환본이 왼쪽, 원본이 오른쪽에 있습니다". */
export function layoutAnnouncement(orientation: SplitOrientation, order: PaneOrder): string {
  const [first, second] = paneOrder(order).map((pane) => (pane === 'pdf' ? '원본' : '변환본'));
  return orientation === 'horizontal'
    ? `${first}이 왼쪽, ${second}이 오른쪽에 있습니다`
    : `${first}이 위, ${second}이 아래에 있습니다`;
}

/** The separator's aria-valuetext for a first-pane share. */
export function splitValueText(order: PaneOrder, firstRatio: number): string {
  const pdf = order === 'pdf-first' ? firstRatio : 100 - firstRatio;
  return `원본 ${pdf}%, 변환본 ${100 - pdf}%`;
}

export interface PaneRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Whether a pane-header drag released at (x, y) drops on the other pane: along the split axis
 * from the middle of the gap (the separator) to the far edge of the other pane, and across it
 * within the two panes. Anywhere else (page margins, the dragged pane itself) cancels.
 */
export function isOverOtherPane(
  orientation: SplitOrientation,
  self: PaneRect,
  other: PaneRect,
  x: number,
  y: number,
): boolean {
  const horizontal = orientation === 'horizontal';
  const [along, across] = horizontal ? [x, y] : [y, x];
  const crossStart = horizontal ? Math.min(self.top, other.top) : Math.min(self.left, other.left);
  const crossEnd = horizontal
    ? Math.max(self.bottom, other.bottom)
    : Math.max(self.right, other.right);
  if (across < crossStart || across > crossEnd) return false;
  const [selfStart, selfEnd, otherStart, otherEnd] = horizontal
    ? [self.left, self.right, other.left, other.right]
    : [self.top, self.bottom, other.top, other.bottom];
  return otherStart > selfStart
    ? along >= (selfEnd + otherStart) / 2 && along <= otherEnd
    : along <= (otherEnd + selfStart) / 2 && along >= otherStart;
}

/** Narrow screens show one pane: 변환본 when that is the saved mode, otherwise 원본. */
export function narrowInitialPane(mode: ViewMode): PaneId {
  return mode === 'text' ? 'text' : 'pdf';
}

// --- width classes -----------------------------------------------------------------------------

export type ViewerWidth = 'narrow' | 'tablet' | 'desktop';

/** < 768px narrow, 768–1023px tablet, ≥ 1024px desktop (--breakpoint-md / --breakpoint-lg). */
export function viewerWidthFor(width: number): ViewerWidth {
  if (width < 768) return 'narrow';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

// --- store -------------------------------------------------------------------------------------

export interface ViewerSettingsStore {
  subscribe(listener: () => void): () => void;
  /** The current settings (read from storage on first use; a stable object between changes). */
  getSnapshot(): ViewerSettings;
  /** Applies a change on this page and tries to save it. */
  update(change: Partial<ViewerSettings>): void;
  /** Reads the stored value again (tests; a later page load does this by itself). */
  reload(): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * One in-memory copy per page: other tabs' changes apply from the next load (not live), and a
 * page whose storage throws keeps working with the settings changed on it.
 */
export function createViewerSettingsStore(
  getStorage: () => StorageLike | null = browserStorage,
): ViewerSettingsStore {
  let current: ViewerSettings | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const snapshot = () => {
    current ??= readStoredViewerSettings(getStorage());
    return current;
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: snapshot,
    update(change) {
      const prev = snapshot();
      const next: ViewerSettings = {
        ...prev,
        ...change,
        pdfRatio: change.pdfRatio === undefined ? prev.pdfRatio : clampPdfRatio(change.pdfRatio),
      };
      if (
        next.mode === prev.mode &&
        next.orientation === prev.orientation &&
        next.order === prev.order &&
        next.pdfRatio === prev.pdfRatio &&
        next.outlineOpen === prev.outlineOpen
      ) {
        return;
      }
      current = next;
      writeStoredViewerSettings(getStorage(), next);
      notify();
    },
    reload() {
      current = readStoredViewerSettings(getStorage());
      notify();
    },
  };
}

export const viewerSettingsStore = createViewerSettingsStore();
