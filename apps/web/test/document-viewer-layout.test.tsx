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

function Harness() {
  const viewer = useDocumentViewer();
  return (
    <DocumentViewerLayout
      viewer={viewer}
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
  act(() => viewerSettingsStore.reload());
});

describe('DocumentViewerLayout', () => {
  it('opens with the defaults: outline open, 함께 보기 · 좌우 · 원본 first at 50%', () => {
    render(<Harness />);
    const settings = bar();
    expect(within(settings).getByRole('button', { name: '목차 접기' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(settings).getByRole('radio', { name: '원본과 변환본 함께 보기' })).toBeChecked();
    expect(within(settings).getByRole('radio', { name: '좌우로 나누기' })).toBeChecked();
    expect(screen.getByRole('dialog', { name: '목차' })).toBeInTheDocument();
    const separator = screen.getByRole('separator', { name: '원본과 변환본 크기 조절' });
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect(separator).toHaveAttribute('aria-valuetext', '원본 50%, 변환본 50%');
    // 원본 comes first in the DOM order of the split.
    const [first, second] = screen.getAllByRole('region');
    expect(first).toHaveAccessibleName('PDF 원본');
    expect(second).toHaveAccessibleName('변환본 텍스트');
    expect(stored()).toBeNull(); // nothing is written until the user changes something
  });

  it('hides a pane without unmounting it, so an unsaved input survives', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: '블록 텍스트' });
    await user.type(field, '교정 중');

    await user.click(screen.getByRole('radio', { name: 'PDF 원본만 보기' }));
    expect(region('변환본 텍스트').closest('[hidden]')).not.toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '분할 방향' })).toBeNull();
    expect(screen.queryByRole('button', { name: '원본과 변환본 위치 바꾸기' })).toBeNull();
    expect(stored()).toMatchObject({ mode: 'pdf' });

    await user.click(screen.getByRole('radio', { name: '원본과 변환본 함께 보기' }));
    expect(screen.getByRole('textbox', { name: '블록 텍스트' })).toBe(field);
    expect(field).toHaveValue('교정 중');
  });

  it('moves between view modes with the arrow keys (one tab stop)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const both = screen.getByRole('radio', { name: '원본과 변환본 함께 보기' });
    expect(both).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'PDF 원본만 보기' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    both.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'PDF 원본만 보기' })).toHaveFocus();
    expect(stored()).toMatchObject({ mode: 'pdf' });
  });

  it('swaps the panes keeping their DOM and sizes, announces and saves the new order', async () => {
    seed({ pdfRatio: 60 });
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
    seed({ order: 'text-first' });
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
    expect(screen.getByRole('radio', { name: '원본과 변환본 함께 보기' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '상하로 나누기' })).toBeChecked();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '20');
    expect(screen.queryByRole('dialog', { name: '목차' })).toBeNull();
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
      expect(stored()).toBeNull();
      const [first] = screen.getAllByRole('region');
      expect(first).toHaveAccessibleName('PDF 원본');
    });
  });
});
