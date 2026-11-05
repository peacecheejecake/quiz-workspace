// DOCVIEW-01 보기 설정 storage (lib/documents/viewer-settings.ts): field-by-field parsing with
// defaults and pdfRatio clamping, guarded reads/writes, the PDF share ↔ first-pane ratio mapping
// across swaps, the live-region text and the width classes.
import { describe, expect, it, vi } from 'vitest';
import {
  clampPdfRatio,
  createViewerSettingsStore,
  DEFAULT_VIEWER_SETTINGS,
  firstPaneRatio,
  isOverOtherPane,
  layoutAnnouncement,
  paneOrder,
  parseViewerSettings,
  pdfRatioFromFirst,
  readStoredViewerSettings,
  serializeViewerSettings,
  splitValueText,
  swappedOrder,
  VIEWER_SETTINGS_KEY,
  viewerWidthFor,
  writeStoredViewerSettings,
} from '../src/lib/documents/viewer-settings';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
};

describe('parseViewerSettings', () => {
  it('UX10-DOC-AC01 uses the original by default when nothing is stored', () => {
    expect(parseViewerSettings(null)).toEqual(DEFAULT_VIEWER_SETTINGS);
    expect(DEFAULT_VIEWER_SETTINGS).toEqual({
      mode: 'pdf',
      orientation: 'horizontal',
      order: 'pdf-first',
      pdfRatio: 50,
      outlineOpen: true,
    });
  });

  it('reads a complete stored value', () => {
    const stored = {
      mode: 'text',
      orientation: 'vertical',
      order: 'text-first',
      pdfRatio: 35,
      outlineOpen: false,
    };
    expect(parseViewerSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it.each(['{"mode":"pdf",', 'null', '[]', '"both"', '42', ''])(
    'falls back to the defaults for broken or non-object JSON %j',
    (raw) => {
      expect(parseViewerSettings(raw)).toEqual(DEFAULT_VIEWER_SETTINGS);
    },
  );

  it('replaces only unknown or out-of-range fields and drops unknown keys', () => {
    const raw = JSON.stringify({
      mode: 'grid',
      orientation: 'vertical',
      order: 'sideways',
      pdfRatio: 5,
      outlineOpen: 'no',
      theme: 'unknown',
    });
    expect(parseViewerSettings(raw)).toEqual({
      mode: 'pdf',
      orientation: 'vertical',
      order: 'pdf-first',
      pdfRatio: 20,
      outlineOpen: true,
    });
  });

  it('clamps and rounds the PDF share into 20…80', () => {
    expect(clampPdfRatio(5)).toBe(20);
    expect(clampPdfRatio(95)).toBe(80);
    expect(clampPdfRatio(42.6)).toBe(43);
    expect(clampPdfRatio('60')).toBe(50);
    expect(clampPdfRatio(Number.NaN)).toBe(50);
    expect(parseViewerSettings('{"pdfRatio":null}').pdfRatio).toBe(50);
  });

  it('serializes exactly the five fields', () => {
    const value = { ...DEFAULT_VIEWER_SETTINGS, extra: 1 } as typeof DEFAULT_VIEWER_SETTINGS;
    expect(JSON.parse(serializeViewerSettings(value))).toEqual(DEFAULT_VIEWER_SETTINGS);
  });
});

describe('guarded storage access', () => {
  it('returns the defaults when storage is missing or throws', () => {
    expect(readStoredViewerSettings(null)).toEqual(DEFAULT_VIEWER_SETTINGS);
    expect(readStoredViewerSettings(throwing)).toEqual(DEFAULT_VIEWER_SETTINGS);
  });

  it('reports a refused write without throwing', () => {
    expect(writeStoredViewerSettings(throwing, DEFAULT_VIEWER_SETTINGS)).toBe(false);
    expect(writeStoredViewerSettings(null, DEFAULT_VIEWER_SETTINGS)).toBe(false);
    const storage = memoryStorage();
    expect(writeStoredViewerSettings(storage, DEFAULT_VIEWER_SETTINGS)).toBe(true);
    expect(storage.data.get(VIEWER_SETTINGS_KEY)).toBe(
      serializeViewerSettings(DEFAULT_VIEWER_SETTINGS),
    );
  });
});

describe('createViewerSettingsStore', () => {
  it('reads once, saves each change under the one key and notifies subscribers', () => {
    const storage = memoryStorage({
      [VIEWER_SETTINGS_KEY]: JSON.stringify({ mode: 'pdf', pdfRatio: 60 }),
    });
    const store = createViewerSettingsStore(() => storage);
    const listener = vi.fn();
    store.subscribe(listener);
    const first = store.getSnapshot();
    expect(first).toMatchObject({ mode: 'pdf', pdfRatio: 60, orientation: 'horizontal' });
    expect(store.getSnapshot()).toBe(first); // stable between changes
    expect(storage.getItem).toHaveBeenCalledTimes(1);

    store.update({ orientation: 'vertical', pdfRatio: 90 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ orientation: 'vertical', pdfRatio: 80 });
    expect(JSON.parse(storage.data.get(VIEWER_SETTINGS_KEY) ?? '')).toEqual({
      mode: 'pdf',
      orientation: 'vertical',
      order: 'pdf-first',
      pdfRatio: 80,
      outlineOpen: true,
    });
    expect([...storage.data.keys()]).toEqual([VIEWER_SETTINGS_KEY]);
  });

  it('does not write or notify when nothing changes', () => {
    const storage = memoryStorage();
    const store = createViewerSettingsStore(() => storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ mode: 'pdf', pdfRatio: 50 });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps working on this page when storage throws', () => {
    const store = createViewerSettingsStore(() => throwing);
    expect(store.getSnapshot()).toEqual(DEFAULT_VIEWER_SETTINGS);
    store.update({ mode: 'text' });
    expect(store.getSnapshot().mode).toBe('text');
  });

  it('reload() reads the stored value again', () => {
    const storage = memoryStorage();
    const store = createViewerSettingsStore(() => storage);
    expect(store.getSnapshot().mode).toBe('pdf');
    storage.data.set(VIEWER_SETTINGS_KEY, '{"mode":"text"}');
    expect(store.getSnapshot().mode).toBe('pdf'); // other tabs apply from the next load
    store.reload();
    expect(store.getSnapshot().mode).toBe('text');
  });
});

describe('pane order and ratio', () => {
  it('maps the PDF share to the first pane and back in both orders', () => {
    expect(paneOrder('pdf-first')).toEqual(['pdf', 'text']);
    expect(paneOrder('text-first')).toEqual(['text', 'pdf']);
    expect(firstPaneRatio('pdf-first', 60)).toBe(60);
    expect(firstPaneRatio('text-first', 60)).toBe(40);
    expect(pdfRatioFromFirst('pdf-first', 65)).toBe(65);
    expect(pdfRatioFromFirst('text-first', 65)).toBe(35);
    expect(pdfRatioFromFirst('text-first', 95)).toBe(20);
  });

  it('keeps each pane its size across a swap', () => {
    const pdfRatio = 60;
    const swapped = swappedOrder('pdf-first');
    expect(swapped).toBe('text-first');
    expect(firstPaneRatio(swapped, pdfRatio)).toBe(40);
    expect(pdfRatioFromFirst(swapped, firstPaneRatio(swapped, pdfRatio))).toBe(pdfRatio);
    expect(swappedOrder(swapped)).toBe('pdf-first');
  });

  it('names both panes in the separator value text', () => {
    expect(splitValueText('pdf-first', 60)).toBe('원본 60%, 변환본 40%');
    expect(splitValueText('text-first', 60)).toBe('원본 40%, 변환본 60%');
  });

  it('announces the new layout after a swap', () => {
    expect(layoutAnnouncement('horizontal', 'text-first')).toBe(
      '변환본이 왼쪽, 원본이 오른쪽에 있습니다',
    );
    expect(layoutAnnouncement('vertical', 'pdf-first')).toBe('원본이 위, 변환본이 아래에 있습니다');
  });
});

describe('narrow screens and width classes', () => {
  it('UX10-DOC-AC02 preserves each explicitly stored view mode', () => {
    for (const mode of ['pdf', 'text', 'both'] as const) {
      expect(parseViewerSettings(JSON.stringify({ mode })).mode).toBe(mode);
    }
  });

  it('splits widths at 768 and 1024', () => {
    expect(viewerWidthFor(390)).toBe('narrow');
    expect(viewerWidthFor(767)).toBe('narrow');
    expect(viewerWidthFor(768)).toBe('tablet');
    expect(viewerWidthFor(1023)).toBe('tablet');
    expect(viewerWidthFor(1024)).toBe('desktop');
  });
});

describe('isOverOtherPane (pane-header drop target)', () => {
  // 좌우: dragged pane 0–500, gap 500–512, other pane 512–1000; both 100–700 tall.
  const left = { left: 0, top: 100, right: 500, bottom: 700 };
  const right = { left: 512, top: 100, right: 1000, bottom: 700 };

  it('accepts the other pane and the gap past the separator', () => {
    expect(isOverOtherPane('horizontal', left, right, 750, 400)).toBe(true);
    expect(isOverOtherPane('horizontal', left, right, 507, 400)).toBe(true);
    expect(isOverOtherPane('horizontal', right, left, 250, 400)).toBe(true);
  });

  it('rejects the dragged pane, the page margin past the other pane and outside the panes', () => {
    expect(isOverOtherPane('horizontal', left, right, 300, 400)).toBe(false);
    expect(isOverOtherPane('horizontal', left, right, 1040, 400)).toBe(false);
    expect(isOverOtherPane('horizontal', right, left, -20, 400)).toBe(false);
    expect(isOverOtherPane('horizontal', left, right, 750, 60)).toBe(false);
    expect(isOverOtherPane('horizontal', left, right, 750, 760)).toBe(false);
  });

  it('bounds the stacked split the same way', () => {
    const top = { left: 0, top: 0, right: 800, bottom: 300 };
    const bottom = { left: 0, top: 312, right: 800, bottom: 600 };
    expect(isOverOtherPane('vertical', top, bottom, 400, 450)).toBe(true);
    expect(isOverOtherPane('vertical', bottom, top, 400, 150)).toBe(true);
    expect(isOverOtherPane('vertical', top, bottom, 400, 650)).toBe(false);
    expect(isOverOtherPane('vertical', bottom, top, 400, -10)).toBe(false);
    expect(isOverOtherPane('vertical', top, bottom, 900, 450)).toBe(false);
  });
});
