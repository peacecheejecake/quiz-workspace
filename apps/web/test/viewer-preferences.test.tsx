// @vitest-environment jsdom
// DOCVIEW (DOC-02-AC06/AC10): per-browser viewer preferences survive a blocked localStorage, and
// the 목차 panel starts from the stored choice or the width default.
import './dom-setup';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OUTLINE_STORAGE_KEY,
  outlineLayout,
  useOutlinePanel,
} from '../src/components/documents/editor/outline-panel';
import {
  resetPreferencesForTests,
  usePreference,
  writePreference,
} from '../src/lib/documents/viewer-preferences';

function mockWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: wide,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetPreferencesForTests();
});

describe('usePreference', () => {
  it('reads and writes localStorage and re-renders readers', () => {
    const { result } = renderHook(() => usePreference('k'));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('v'));
    expect(result.current[0]).toBe('v');
    expect(window.localStorage.getItem('k')).toBe('v');
  });

  it('keeps a value in memory for this page when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { result } = renderHook(() => usePreference('k'));
    act(() => writePreference('k', 'mem'));
    expect(result.current[0]).toBe('mem');
  });
});

describe('useOutlinePanel', () => {
  it('opens by default on desktop and stays closed below it', () => {
    mockWidth(true);
    expect(renderHook(() => useOutlinePanel()).result.current.open).toBe(true);
    mockWidth(false);
    expect(renderHook(() => useOutlinePanel()).result.current.open).toBe(false);
  });

  it('remembers a toggle, while a dismiss after a jump is not remembered', () => {
    mockWidth(true);
    const { result } = renderHook(() => useOutlinePanel());
    act(() => result.current.setOpen(false));
    expect(result.current.open).toBe(false);
    expect(window.localStorage.getItem(OUTLINE_STORAGE_KEY)).toBe('closed');
    act(() => result.current.setOpen(true));
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
    expect(window.localStorage.getItem(OUTLINE_STORAGE_KEY)).toBe('open');
  });

  it('moves focus into the panel only when a reader opened it', () => {
    mockWidth(true);
    const { result } = renderHook(() => useOutlinePanel());
    const restored = new Event('focus', { cancelable: true });
    result.current.onOpenAutoFocus(restored);
    expect(restored.defaultPrevented).toBe(true);
    act(() => result.current.setOpen(true));
    const opened = new Event('focus', { cancelable: true });
    result.current.onOpenAutoFocus(opened);
    expect(opened.defaultPrevented).toBe(false);
  });

  it('names the layout before hydration `auto`', () => {
    expect(outlineLayout(null)).toBe('auto');
    expect(outlineLayout(true)).toBe('open');
    expect(outlineLayout(false)).toBe('closed');
  });
});
