// HILITE-01-C09 — the shared highlight tool (docs/screens/highlights.md, design-system §5.2):
// HighlightableText draws highlights and search results on one text (a), turns selections into
// block offsets without hidden labels or footnote numbers (b), refuses selections across blocks
// (c) and opens the menu from the keyboard with a roving paragraph focus (d); HighlightMenu shows
// `하이라이트 지우기` only on overlap, as an icon-only row with no `복사` (OS menu / Ctrl+C copy).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  HighlightableText,
  HighlightMenu,
  colorAction,
  type HighlightAction,
  type HighlightSelection,
  type TextBlock,
  type TextHighlight,
  type TextMatch,
} from '../src';
import { axeViolations } from './axe';

const BLOCKS: TextBlock[] = [
  {
    id: 's0.i0',
    text: '이 장의 핵심 용어를 묻는다.',
    suffix: (
      <a href="#fn-1" aria-label="각주 1">
        [1]
      </a>
    ),
  },
  { id: 's0.i1', text: '과정의 순서를 묻는다.', emphasis: [{ start: 0, end: 2, kind: 'strong' }] },
  { id: 's1.i0', text: '두 문제를 함께 본다.' },
];

const YELLOW: TextHighlight = { id: 'h1', block: 's0.i0', start: 5, end: 10, color: 'yellow' };

function region() {
  return screen.getByRole('group', { name: '정리 노트 본문' });
}

function blockEl(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-hl-block="${id}"]`);
  if (!el) throw new Error(`no block ${id}`);
  return el;
}

/** Text nodes of `root` in order, skipping nothing (the DOM as a browser would select it). */
function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Selects from the first occurrence of `from` to the end of `to` (both visible text). */
function select(from: string, to: string = from) {
  const nodes = textNodes(region());
  const find = (needle: string, after?: { node: Text; offset: number }) => {
    let started = after === undefined;
    for (const node of nodes) {
      if (!started) {
        if (node === after?.node) started = true;
        else continue;
      }
      const i = (node.nodeValue ?? '').indexOf(needle, node === after?.node ? after.offset : 0);
      if (i >= 0) return { node, offset: i };
    }
    throw new Error(`"${needle}" not rendered`);
  };
  const a = find(from);
  const b = to === from ? a : find(to, a);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset + to.length);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function mouseSelect(from: string, to?: string) {
  fireEvent.pointerDown(region(), { pointerType: 'mouse' });
  select(from, to);
  fireEvent.pointerUp(region(), { pointerType: 'mouse' });
}

interface HarnessProps {
  highlights?: TextHighlight[];
  matches?: TextMatch[];
  readOnly?: boolean;
  onAction?: (action: HighlightAction) => void;
  onSelection?: (selection: HighlightSelection | null) => void;
}

function Harness({ highlights = [], matches, readOnly, onAction, onSelection }: HarnessProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<HighlightSelection | null>(null);
  return (
    <>
      <HighlightableText
        ref={ref}
        label="정리 노트 본문"
        blocks={BLOCKS}
        highlights={highlights}
        matches={matches}
        readOnly={readOnly}
        activeHighlightId={selection?.highlightId}
        onSelectRange={(s) => {
          onSelection?.(s);
          setSelection(s);
        }}
        renderLayout={(block) => (
          <>
            <section>
              <h3>물의 순환</h3>
              <ul>
                {block('s0.i0', { as: 'li' })}
                {block('s0.i1', { as: 'li' })}
              </ul>
            </section>
            <section>
              <h3>정수</h3>
              <ul>{block('s1.i0', { as: 'li' })}</ul>
            </section>
          </>
        )}
      />
      <HighlightMenu
        selection={selection}
        highlights={highlights}
        readOnly={readOnly}
        onAction={onAction}
        onClose={() => setSelection(null)}
        returnFocusTo={ref}
      />
    </>
  );
}

const menu = () => screen.findByRole('menu', { name: '하이라이트' }, { timeout: 4000 });

/** Closes the menu: unmounting an open one clears the selection a moment into the next test. */
async function closeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

describe('HILITE-01-C09 HighlightableText', () => {
  it('HILITE-01-C09a draws non-overlapping highlights and search results over the same text', async () => {
    const { container } = render(
      <Harness
        highlights={[
          YELLOW,
          // Overlaps h1: never drawn.
          { id: 'hx', block: 's0.i0', start: 8, end: 12, color: 'pink' },
          { id: 'h2', block: 's0.i1', start: 0, end: 6, color: 'blue' },
        ]}
        matches={[
          // Crosses the end of h1 ("용어를").
          { block: 's0.i0', start: 8, end: 11, current: true },
          { block: 's1.i0', start: 0, end: 2 },
        ]}
      />,
    );
    const marks = container.querySelectorAll('mark[data-highlight-color]');
    expect([...marks].map((m) => m.getAttribute('data-highlight-color'))).toEqual([
      'yellow',
      'blue',
    ]);
    const yellow = marks[0] as HTMLElement;
    expect(yellow).toHaveClass('qz-highlight');
    expect(yellow).toHaveTextContent('하이라이트 시작(노랑)핵심 현재 결과용어하이라이트 끝');
    // Bold text inside a highlight keeps its emphasis.
    expect(marks[1]?.querySelector('strong')).toHaveTextContent('과정');

    // The match is split at the highlight boundary; the part inside is nested in the mark (drawn
    // above it) and only the current result's first part says "현재 결과".
    const results = [...container.querySelectorAll('mark[data-search-result]')];
    expect(results.map((r) => r.textContent)).toEqual(['현재 결과용어', '를', '두 ']);
    expect(results[0]?.closest('mark[data-highlight-color]')).toBe(yellow);
    expect(results[0]).toHaveAttribute('data-current', 'true');
    expect(results[1]).toHaveAttribute('data-current', 'true');
    expect(results[2]).not.toHaveAttribute('data-current');
    expect(results.filter((r) => r.textContent?.includes('현재 결과'))).toHaveLength(1);

    // The visible text is untouched: labels are hidden, footnote numbers sit outside the text.
    const first = blockEl('s0.i0');
    const clone = first.cloneNode(true) as HTMLElement;
    for (const skip of clone.querySelectorAll('[data-hl-skip]')) skip.remove();
    expect(clone.textContent).toBe(BLOCKS[0]?.text);
    expect(await axeViolations()).toEqual([]);
  });

  it('HILITE-01-C09b turns a selection into block offsets without hidden labels or footnote numbers', async () => {
    const onSelection = vi.fn();
    render(<Harness highlights={[YELLOW]} onSelection={onSelection} />);

    // "장의 핵심" crosses into the highlight (whose hidden start label sits in between).
    mouseSelect('장의 ', '핵심');
    await waitFor(() => expect(onSelection).toHaveBeenCalled());
    const picked = onSelection.mock.lastCall?.[0] as HighlightSelection;
    expect(picked).toMatchObject({
      block: 's0.i0',
      start: 2,
      end: 7,
      text: '장의 핵심',
      source: 'mouse',
    });

    // A selection running into the footnote number stops at the end of the text.
    mouseSelect('묻는다.', '[1]');
    await waitFor(() =>
      expect(onSelection.mock.lastCall?.[0]).toMatchObject({ block: 's0.i0', start: 12, end: 16 }),
    );
    expect((onSelection.mock.lastCall?.[0] as HighlightSelection).text).toBe('묻는다.');

    // Only a footnote number: nothing to highlight.
    onSelection.mockClear();
    mouseSelect('[1]');
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(onSelection.mock.calls.filter(([s]) => s !== null)).toHaveLength(0);
  });

  it('HILITE-01-C09b merges overlapping highlights on a color', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness highlights={[YELLOW]} onAction={onAction} />);

    mouseSelect('장의 ', '핵심');
    let open = await menu();
    // Icon-only: the names are accessible names, nothing is written in the row.
    expect(
      within(open)
        .getAllByRole('menuitemradio')
        .map((i) => i.getAttribute('aria-label')),
    ).toEqual(['노랑', '파랑', '분홍']);
    expect(open.textContent).toBe('');
    await user.click(within(open).getByRole('menuitemradio', { name: '파랑' }));
    expect(onAction).toHaveBeenCalledWith({
      type: 'create',
      block: 's0.i0',
      start: 2,
      end: 10,
      color: 'blue',
      replaceIds: ['h1'],
    });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // Pressing the highlight (no selection) opens the menu on it, its color checked.
    window.getSelection()?.removeAllRanges();
    const mark = document.querySelector<HTMLElement>('mark[data-highlight-id="h1"]');
    if (!mark) throw new Error('no mark');
    fireEvent.pointerDown(mark, { pointerType: 'mouse' });
    fireEvent.pointerUp(mark, { pointerType: 'mouse' });
    open = await menu();
    expect(within(open).getByRole('menuitemradio', { name: '노랑' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(open).getByRole('menuitemradio', { name: '파랑' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.click(within(open).getByRole('menuitemradio', { name: '분홍' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'recolor', id: 'h1', color: 'pink' });
  });

  it('HILITE-01-C09b the row has no 복사 item: the OS menu and Ctrl/Cmd+C copy', async () => {
    const user = userEvent.setup();
    render(<Harness highlights={[YELLOW]} />);

    mouseSelect('장의 ', '핵심');
    const open = await menu();
    expect(within(open).queryByRole('menuitem', { name: '복사' })).toBeNull();
    expect(within(open).getByRole('menuitem', { name: '하이라이트 지우기' })).toBeVisible();
    await closeMenu(user);
  });

  it('HILITE-01-C09b Left and Right move along the row of swatches and the remove icon', async () => {
    const user = userEvent.setup();
    render(<Harness highlights={[YELLOW]} />);

    mouseSelect('장의 ', '핵심');
    const open = await menu();
    const names = () => document.activeElement?.getAttribute('aria-label');
    await waitFor(() => expect(open.contains(document.activeElement)).toBe(true));
    await user.keyboard('{ArrowRight}');
    expect(names()).toBe('노랑');
    await user.keyboard('{ArrowRight}');
    expect(names()).toBe('파랑');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    // Wraps from the first swatch to the last item of the row.
    expect(names()).toBe('하이라이트 지우기');
    await closeMenu(user);
  });

  it('HILITE-01-C09b a mouse selection keeps the default placement (only touch moves below the end)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    mouseSelect('장의 ', '핵심');
    expect(await menu()).not.toHaveAttribute('data-touch');
    await closeMenu(user);
  });

  it('HILITE-01-C09c refuses a selection across blocks: colors disabled with the reason as text', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<Harness highlights={[YELLOW]} onAction={onAction} />);

    mouseSelect('핵심', '의 순서');
    const open = await menu();
    for (const item of within(open).getAllByRole('menuitemradio')) {
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAccessibleDescription('한 문단 안에서 고르세요');
    }
    // The reason is read out, not shown (the row has no text).
    expect(within(open).getByText('한 문단 안에서 고르세요')).toHaveClass('qz-visually-hidden');
    expect(within(open).queryByRole('menuitem', { name: '하이라이트 지우기' })).toBeNull();
    await user.click(within(open).getByRole('menuitemradio', { name: '노랑' }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('HILITE-01-C09d moves a roving paragraph focus with the arrows and opens the menu for the whole paragraph', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <>
        <button type="button">앞</button>
        <Harness highlights={[YELLOW]} onAction={onAction} />
      </>,
    );
    await user.tab();
    await user.tab();
    const area = region();
    expect(area).toHaveFocus();
    expect(area).toHaveAttribute('aria-activedescendant', blockEl('s0.i0').id);
    await user.keyboard('{ArrowDown}');
    expect(area).toHaveAttribute('aria-activedescendant', blockEl('s0.i1').id);
    expect(blockEl('s0.i1')).toHaveAttribute('data-active');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(area).toHaveAttribute('aria-activedescendant', blockEl('s0.i1').id);

    // Shift+F10: menu for the whole second paragraph, first color focused.
    await user.keyboard('{Shift>}{F10}{/Shift}');
    let open = await menu();
    await waitFor(() =>
      expect(within(open).getByRole('menuitemradio', { name: '노랑' })).toHaveFocus(),
    );
    // Escape closes the menu only and returns focus to the area.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(area).toHaveFocus();

    // The ContextMenu key and Enter open it too.
    fireEvent.keyDown(area, { key: 'ContextMenu' });
    open = await menu();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await user.keyboard('{Enter}');
    open = await menu();
    await waitFor(() =>
      expect(within(open).getByRole('menuitemradio', { name: '노랑' })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledWith({
      type: 'create',
      block: 's0.i1',
      start: 0,
      end: BLOCKS[1]?.text.length,
      color: 'yellow',
      replaceIds: [],
    });
    await waitFor(() => expect(area).toHaveFocus());
  });

  it('HILITE-01-C09d Escape keeps a mouse selection and returns focus to the area', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    mouseSelect('의 순서');
    const open = await menu();
    expect(open).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(region()).toHaveFocus();
    expect(window.getSelection()?.toString()).toBe('의 순서');
  });

  it('UX12-HILITE-AC01 puts back a selection the browser dropped when focus moved in the menu', async () => {
    render(<Harness />);
    mouseSelect('장의 ', '핵심');
    const open = await menu();

    await waitFor(() => expect(open.contains(document.activeElement)).toBe(true));

    // What WebKit does on every focus move (jsdom's focus() collapses after its focus events, so
    // the event is fired directly).
    window.getSelection()?.removeAllRanges();
    fireEvent.focusIn(within(open).getByRole('menuitemradio', { name: '파랑' }));
    expect(window.getSelection()?.toString()).toBe('장의 핵심');

    window.getSelection()?.removeAllRanges();
    fireEvent.focusIn(open);
    expect(window.getSelection()?.toString()).toBe('장의 핵심');
    // Still the reader's selection, not a change that closes the menu.
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole('menu', { name: '하이라이트' })).toBeVisible();

    // An outside press clears it for good.
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(window.getSelection()?.toString()).toBe('');
  });

  it('HILITE-01-C09 a tap on a highlight (no selection) opens its menu like a click', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness highlights={[YELLOW]} onAction={onAction} />);
    window.getSelection()?.removeAllRanges();
    const mark = document.querySelector<HTMLElement>('mark[data-highlight-id="h1"]');
    if (!mark) throw new Error('no mark');
    fireEvent.pointerDown(mark, { pointerType: 'touch' });
    fireEvent.pointerUp(mark, { pointerType: 'touch' });
    const open = await menu();
    expect(within(open).getByRole('menuitemradio', { name: '노랑' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(open).getByRole('menuitem', { name: '하이라이트 지우기' })).toBeVisible();
    await user.click(within(open).getByRole('menuitemradio', { name: '파랑' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'recolor', id: 'h1', color: 'blue' });
  });

  it.each(['mouse', 'touch'] as const)(
    'UX12-HILITE-AC02 pressing the open highlight again closes the menu (%s)',
    async (pointerType) => {
      const OTHER: TextHighlight = { id: 'h2', block: 's1.i0', start: 0, end: 2, color: 'blue' };
      render(<Harness highlights={[YELLOW, OTHER]} />);
      const press = (id: string) => {
        const mark = document.querySelector<HTMLElement>(`mark[data-highlight-id="${id}"]`);
        if (!mark) throw new Error(`no mark ${id}`);
        fireEvent.pointerDown(mark, { pointerType });
        fireEvent.pointerUp(mark, { pointerType });
      };

      press('h1');
      await menu();
      press('h1');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      await act(async () => new Promise((r) => setTimeout(r, 10)));
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();

      press('h1');
      expect(await menu()).toBeVisible();
      // Another highlight takes the menu over instead of closing it (a mouse closes it first).
      press('h2');
      await waitFor(async () =>
        expect(within(await menu()).getByRole('menuitemradio', { name: '파랑' })).toHaveAttribute(
          'aria-checked',
          'true',
        ),
      );
    },
  );

  it('HILITE-01-C09 a cancelled or moving touch on a highlight (scrolling) opens no menu', async () => {
    const onSelection = vi.fn();
    render(<Harness highlights={[YELLOW]} onSelection={onSelection} />);
    window.getSelection()?.removeAllRanges();
    const mark = document.querySelector<HTMLElement>('mark[data-highlight-id="h1"]');
    if (!mark) throw new Error('no mark');
    // The browser takes the gesture over to scroll.
    fireEvent.pointerDown(mark, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(mark, { pointerType: 'touch', clientX: 10, clientY: 40 });
    // A swipe that ends with pointerup far from where it started.
    fireEvent.pointerDown(mark, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerUp(mark, { pointerType: 'touch', clientX: 10, clientY: 60 });
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSelection.mock.calls.filter(([s]) => s !== null)).toHaveLength(0);
  });

  it('HILITE-01-C09 opens the menu for a touch selection only after it rests', async () => {
    vi.useFakeTimers();
    try {
      const onSelection = vi.fn();
      const { unmount } = render(<Harness onSelection={onSelection} />);
      fireEvent.pointerDown(region(), { pointerType: 'touch' });
      select('두 문제를');
      fireEvent.pointerUp(region(), { pointerType: 'touch' });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(screen.queryByRole('menu')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(onSelection).toHaveBeenLastCalledWith(
        expect.objectContaining({ block: 's1.i0', start: 0, end: 5, source: 'touch' }),
      );
      expect(screen.getByRole('menu', { name: '하이라이트' })).toHaveAttribute('data-touch');
      unmount();
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HILITE-01-C09 HighlightMenu', () => {
  it('HILITE-01-C09 shows 하이라이트 지우기 only when the selection overlaps a highlight', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <Harness
        highlights={[YELLOW, { id: 'h2', block: 's0.i1', start: 4, end: 6, color: 'pink' }]}
        onAction={onAction}
      />,
    );
    mouseSelect('묻는다');
    let open = await menu();
    expect(open.querySelectorAll('[role^="menuitem"]')).toHaveLength(3);
    expect(within(open).queryByRole('menuitem', { name: '하이라이트 지우기' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // A selection inside "핵심 용어" removes the whole highlight.
    mouseSelect('용어');
    open = await menu();
    await user.click(within(open).getByRole('menuitem', { name: '하이라이트 지우기' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'remove', ids: ['h1'] });
  });

  it('HILITE-01-C09 read-only offers no menu (copying is the OS menu or Ctrl+C)', async () => {
    render(<Harness readOnly highlights={[YELLOW]} />);
    mouseSelect('핵심');
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(screen.queryByRole('menu')).toBeNull();
    // Read-only marks are not pressable.
    expect(document.querySelector('mark[data-highlight-id="h1"]')).not.toHaveAttribute(
      'data-pressable',
    );
  });
});

describe('colorAction', () => {
  it('recolors an exact highlight, skips its own color and merges overlaps', () => {
    const list = [YELLOW, { ...YELLOW, id: 'h2', start: 12, end: 14 }];
    expect(colorAction(list, { block: 's0.i0', start: 5, end: 10 }, 'yellow')).toBeNull();
    expect(colorAction(list, { block: 's0.i0', start: 5, end: 10 }, 'pink')).toEqual({
      type: 'recolor',
      id: 'h1',
      color: 'pink',
    });
    expect(colorAction(list, { block: 's0.i0', start: 8, end: 13 }, 'blue')).toEqual({
      type: 'create',
      block: 's0.i0',
      start: 5,
      end: 14,
      color: 'blue',
      replaceIds: ['h1', 'h2'],
    });
    // Touching end to end is not an overlap; another block never is.
    expect(colorAction(list, { block: 's0.i0', start: 10, end: 12 }, 'blue')).toMatchObject({
      replaceIds: [],
    });
    expect(colorAction(list, { block: 's0.i1', start: 5, end: 10 }, 'blue')).toMatchObject({
      replaceIds: [],
    });
  });
});
