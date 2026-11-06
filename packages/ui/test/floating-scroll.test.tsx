import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ChapterPicker,
  FloatingSidePanel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from '../src';

// UX12-CHAPTERSCROLL: the real scroll locks stay mounted here, so a list portalled out of a modal
// panel meets the same document listeners as in the browser. jsdom has no layout: scroll sizes are
// stubbed, and the assertion is whether anything cancelled the gesture.

function scrollable(el: HTMLElement, top = 0) {
  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 500 });
  el.scrollTop = top;
}

function touch(target: Element, type: string, y: number): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, target, clientX: 10, clientY: y };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  // Through React as well: the locks read their capture handlers' verdict at the document.
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Touches at y = 300, moves through `path`, and returns which touchmoves were cancelled. */
function swipe(target: Element, path: readonly number[]): boolean[] {
  touch(target, 'touchstart', 300);
  const cancelled = path.map((y) => touch(target, 'touchmove', y).defaultPrevented);
  touch(target, 'touchend', path.at(-1) ?? 300);
  return cancelled;
}

function wheel(target: Element, deltaY: number): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const NODES = [
  { value: 'c1', label: '1장', level: 1 },
  { value: 'c2', label: '2장', level: 1 },
];

describe('a list portalled out of a modal panel', () => {
  async function nonModalList() {
    render(
      <FloatingSidePanel open title="문제">
        <Popover open>
          <PopoverTrigger>열기</PopoverTrigger>
          <PopoverContent aria-label="미리보기">
            <ul data-testid="list">
              <li>항목</li>
            </ul>
          </PopoverContent>
        </Popover>
      </FloatingSidePanel>,
    );
    const list = await screen.findByTestId('list');
    scrollable(list);
    return list;
  }

  it('non-modal popover: the wheel and a swipe scroll it past the panel lock', async () => {
    const list = await nonModalList();
    const row = list.querySelector('li') as HTMLElement;
    expect(wheel(row, 120)).toBe(false);
    expect(swipe(row, [260, 220])).toEqual([false, false]);
  });

  it('non-modal popover: past its end the gesture is still cancelled', async () => {
    const list = await nonModalList();
    const row = list.querySelector('li') as HTMLElement;
    expect(wheel(row, -120)).toBe(true);
    expect(swipe(row, [340])).toEqual([true]);
  });

  async function pickerTree() {
    const user = userEvent.setup();
    render(
      <FloatingSidePanel open title="문제">
        <ChapterPicker label="챕터" nodes={NODES} value="c1" />
      </FloatingSidePanel>,
    );
    await user.click(await screen.findByRole('combobox', { name: '챕터', hidden: true }));
    const tree = await screen.findByRole('tree');
    scrollable(tree);
    return tree;
  }

  it('ChapterPicker: wheel and swipes scroll the tree', async () => {
    const tree = await pickerTree();
    const row = tree.querySelector('[role="treeitem"]') as HTMLElement;
    expect(wheel(row, 120)).toBe(false);
    expect(swipe(row, [260, 220])).toEqual([false, false]);
  });

  it('ChapterPicker: the jitter before a swipe at the top of the list does not end it', async () => {
    const tree = await pickerTree();
    const row = tree.querySelector('[role="treeitem"]') as HTMLElement;
    // A first touchmove that is cancelled ends the native scroll of the whole gesture on iOS.
    expect(swipe(row, [300, 300.4, 270, 230])).toEqual([false, false, false, false]);
  });

  it('Select: the list scrolls and contains the gesture like the others', async () => {
    render(
      <FloatingSidePanel open title="문제">
        <Select
          label="유형"
          options={[
            { value: 'a', label: '가' },
            { value: 'b', label: '나' },
          ]}
        />
      </FloatingSidePanel>,
    );
    const trigger = await screen.findByRole('combobox', { name: '유형', hidden: true });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    const scroller = list.querySelector('[data-radix-select-viewport]') as HTMLElement;
    scrollable(scroller);
    const option = list.querySelector('[role="option"]') as HTMLElement;
    expect(wheel(option, -120)).toBe(true);
    scroller.scrollTop = 200;
    expect(wheel(option, 120)).toBe(false);
    expect(swipe(option, [340])).toEqual([false]);
  });
});
