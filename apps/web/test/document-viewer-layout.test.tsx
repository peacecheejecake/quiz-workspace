// @vitest-environment jsdom
// DOCVIEW-01 DocumentViewerLayout: the "보기 설정" bar drives the stored settings; hidden panes stay
// mounted; swapping keeps each pane's DOM and its size, announces the new layout and saves it;
// the outline toggle folds the docked panel. (Layout geometry, drags and widths: E2E.)
import './dom-setup';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DocumentViewerLayout,
  useDocumentViewer,
} from '../src/components/documents/editor/document-viewer-layout';
import { VIEWER_SETTINGS_KEY, viewerSettingsStore } from '../src/lib/documents/viewer-settings';

function Harness({
  preventAutoHide = false,
  alert = false,
}: {
  preventAutoHide?: boolean;
  alert?: boolean;
}) {
  const viewer = useDocumentViewer();
  return (
    <DocumentViewerLayout
      viewer={viewer}
      preventAutoHide={preventAutoHide}
      chrome={alert ? <p role="alert">오류</p> : null}
      outline={
        <nav aria-label="문서 목차">
          <ul role="tree" aria-label="목차">
            <li role="treeitem" aria-selected={false} tabIndex={0}>
              1장
            </li>
          </ul>
        </nav>
      }
      pdf={<p>PDF 본문</p>}
      text={<textarea aria-label="블록 텍스트" defaultValue="" />}
    />
  );
}

function stored(): unknown {
  const raw = window.localStorage.getItem(VIEWER_SETTINGS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function seed(value: object) {
  window.localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(value));
  act(() => viewerSettingsStore.reload());
}

const bar = () => screen.getByRole('group', { name: '보기 설정' });
const region = (name: string) => screen.getByRole('region', { name, hidden: true });

beforeEach(() => {
  window.localStorage.clear();
  seed({ mode: 'both' });
});

describe('DocumentViewerLayout', () => {
  it('UX10-DOC-AC01 opens with the original selected by default', () => {
    window.localStorage.clear();
    act(() => viewerSettingsStore.reload());
    render(<Harness />);
    const settings = bar();
    expect(within(settings).getByRole('button', { name: '목차 접기' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(settings).getByRole('checkbox', { name: '원본' })).toBeChecked();
    expect(within(settings).getByRole('checkbox', { name: '변환본' })).not.toBeChecked();
    expect(stored()).toBeNull();
  });

  it('hides a pane without unmounting it, so an unsaved input survives', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: '블록 텍스트' });
    await user.type(field, '교정 중');

    await user.click(screen.getByRole('checkbox', { name: '변환본' }));
    expect(region('변환본 텍스트').closest('[hidden]')).not.toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '분할 방향' })).toBeNull();
    expect(screen.queryByRole('button', { name: '원본과 변환본 위치 바꾸기' })).toBeNull();
    expect(stored()).toMatchObject({ mode: 'pdf' });

    await user.click(screen.getByRole('checkbox', { name: '변환본' }));
    expect(screen.getByRole('textbox', { name: '블록 텍스트' })).toBe(field);
    expect(field).toHaveValue('교정 중');
  });

  it('UX10-DOC-AC01 prevents deselecting the last pane', async () => {
    seed({ mode: 'pdf' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: '원본' }));
    expect(screen.getByRole('checkbox', { name: '원본' })).toBeChecked();
    expect(screen.getByText('하나 이상 선택하세요')).toBeInTheDocument();
  });

  it('swaps the panes keeping their DOM and sizes, announces and saves the new order', async () => {
    seed({ mode: 'both', pdfRatio: 60 });
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: '블록 텍스트' });
    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-valuenow', '60');

    await user.click(screen.getByRole('button', { name: '원본과 변환본 위치 바꾸기' }));
    const [first] = screen.getAllByRole('region');
    expect(first).toHaveAccessibleName('변환본 텍스트');
    expect(screen.getByRole('textbox', { name: '블록 텍스트' })).toBe(field);
    expect(separator).toHaveAttribute('aria-valuenow', '40');
    expect(separator).toHaveAttribute('aria-valuetext', '원본 60%, 변환본 40%');
    expect(screen.getByText('변환본이 왼쪽, 원본이 오른쪽에 있습니다')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(stored()).toMatchObject({ order: 'text-first', pdfRatio: 60 });
  });

  it('saves the PDF share from separator keys in either order', async () => {
    seed({ mode: 'both', order: 'text-first' });
    const user = userEvent.setup();
    render(<Harness />);
    const separator = screen.getByRole('separator');
    separator.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '60');
    expect(stored()).toMatchObject({ order: 'text-first', pdfRatio: 40 });
  });

  it('a pane handle swaps from the keyboard like 위치 바꾸기', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('button', { name: '원본 위치 옮기기' }).focus();
    await user.keyboard('{Enter}');
    expect(stored()).toMatchObject({ order: 'text-first' });
  });

  it('folds and unfolds the outline from the bar and remembers it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(within(bar()).getByRole('button', { name: '목차 접기' }));
    expect(screen.queryByRole('dialog', { name: '목차' })).toBeNull();
    const expand = within(bar()).getByRole('button', { name: '목차 펼치기' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(stored()).toMatchObject({ outlineOpen: false });

    await user.click(expand);
    expect(screen.getByRole('dialog', { name: '목차' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: '1장' })).toHaveFocus();
  });

  it('applies a stored layout and falls back per field', () => {
    window.localStorage.setItem(
      VIEWER_SETTINGS_KEY,
      JSON.stringify({ mode: 'grid', orientation: 'vertical', pdfRatio: 5, outlineOpen: false }),
    );
    act(() => viewerSettingsStore.reload());
    render(<Harness />);
    expect(screen.getByRole('checkbox', { name: '원본' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '변환본' })).not.toBeChecked();
    expect(screen.queryByRole('dialog', { name: '목차' })).toBeNull();
  });

  it('UX10-DOC-AC04 hides the chrome after inactivity and restores it from the hotspot', () => {
    vi.useFakeTimers();
    const { container } = render(<Harness />);
    const chrome = container.querySelector('[class*="chrome"]');
    expect(chrome).not.toHaveAttribute('data-hidden');
    act(() => vi.advanceTimersByTime(3000));
    expect(chrome).toHaveAttribute('data-hidden');
    fireEvent.pointerMove(window, { clientY: 10 });
    expect(chrome).not.toHaveAttribute('data-hidden');
    vi.useRealTimers();
  });

  it('UX10-DOC-AC04 keeps chrome visible while focused or a menu is open', () => {
    vi.useFakeTimers();
    const { container, unmount } = render(<Harness />);
    const chrome = container.querySelector('[class*="chrome"]');
    const checkbox = screen.getByRole('checkbox', { name: '원본' });
    fireEvent.focus(checkbox);
    act(() => vi.advanceTimersByTime(4000));
    expect(chrome).not.toHaveAttribute('data-hidden');
    fireEvent.blur(checkbox);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    act(() => vi.advanceTimersByTime(4000));
    expect(chrome).not.toHaveAttribute('data-hidden');
    menu.remove();
    act(() => vi.advanceTimersByTime(300));
    expect(chrome).toHaveAttribute('data-hidden');
    fireEvent.pointerMove(window, { clientY: 10 });
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    unmount();
    expect(clearTimeout).toHaveBeenCalled();
    clearTimeout.mockRestore();
    vi.useRealTimers();
  });

  it('UX10-DOC-AC04 keeps chrome visible during editing or a warning', () => {
    vi.useFakeTimers();
    const { container } = render(<Harness preventAutoHide />);
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('[class*="chrome"]')).not.toHaveAttribute('data-hidden');
    vi.useRealTimers();
  });

  it('UX10-DOC-AC04 pins chrome and reading space while an important error is present', () => {
    vi.useFakeTimers();
    const { container } = render(<Harness alert />);
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('[data-chrome-pinned]')).not.toBeNull();
    expect(container.querySelector('[class*="chrome"]')).not.toHaveAttribute('data-hidden');
    vi.useRealTimers();
  });

  it('UX10-DOC-AC03 makes covered shell controls inert and restores them on unmount', () => {
    const shell = document.createElement('button');
    shell.textContent = 'Shell control';
    document.body.append(shell);
    const { unmount } = render(<Harness />);
    expect(shell.inert).toBe(true);
    unmount();
    expect(shell.inert).toBeFalsy();
    shell.remove();
  });

  describe('pane-header drag', () => {
    // jsdom has no PointerEvent or layout: a minimal PointerEvent and fixed pane boxes
    // (원본 0–500, 변환본 512–1000, both 100–700 tall).
    beforeEach(() => {
      if (!('PointerEvent' in window)) {
        class PointerEventStub extends MouseEvent {
          readonly pointerId: number;
          readonly pointerType: string;
          constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? 'mouse';
          }
        }
        vi.stubGlobal('PointerEvent', PointerEventStub);
      }
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const name = this.getAttribute('aria-label');
        const [left, right] =
          name === 'PDF 원본' ? [0, 500] : name === '변환본 텍스트' ? [512, 1000] : [0, 0];
        return DOMRect.fromRect({ x: left, y: 100, width: right - left, height: 600 });
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function drag(to: { clientX: number; clientY: number }) {
      const handle = screen.getByRole('button', { name: '원본 위치 옮기기' });
      const at = (x: number, y: number) => ({
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
      });
      fireEvent.pointerDown(handle, { ...at(250, 120), button: 0 });
      fireEvent.pointerMove(handle, at(to.clientX, to.clientY));
      return { handle, release: () => fireEvent.pointerUp(handle, at(to.clientX, to.clientY)) };
    }

    it('drops on the other pane: swaps and saves', () => {
      render(<Harness />);
      const { release } = drag({ clientX: 750, clientY: 400 });
      expect(screen.getByText('여기에 놓아 위치 바꾸기')).toBeInTheDocument();
      release();
      expect(screen.queryByText('여기에 놓아 위치 바꾸기')).toBeNull();
      expect(stored()).toMatchObject({ order: 'text-first' });
    });

    it('a release outside the viewer (past the other pane) cancels: no hint, no swap, no write', () => {
      render(<Harness />);
      const { release } = drag({ clientX: 1040, clientY: 400 });
      expect(screen.queryByText('여기에 놓아 위치 바꾸기')).toBeNull();
      release();
      expect(stored()).toMatchObject({ mode: 'both' });
      const [first] = screen.getAllByRole('region');
      expect(first).toHaveAccessibleName('PDF 원본');
    });
  });
});
