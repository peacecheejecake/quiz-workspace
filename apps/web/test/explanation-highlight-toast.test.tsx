// @vitest-environment jsdom
// HILITE-01 explanation toasts (docs/screens/highlights.md): every new highlight says where it
// went, a recolor does not, and `복사` confirms with a toast over the same tool.
import './dom-setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../src/lib/highlights/client';
import type { MyHighlight } from '../src/lib/notes/model';

const client = vi.hoisted(() => ({
  createHighlight: vi.fn(),
  getQuestionHighlights: vi.fn(),
  recolorHighlight: vi.fn(),
}));
vi.mock('@/lib/highlights/client', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  ...client,
}));

const { ExplanationText } = await import('../src/components/questions/viewer/explanation-text');

const QUESTION = '22222222-2222-4222-8222-000000000001';
const TEXT = '첫 번째 보기가 정답이다.';
const NOTICE = '정리 노트의 내 하이라이트에 모았습니다 · 1장 물의 순환';

function highlight(id: string, start: number, end: number): MyHighlight {
  return {
    id,
    color: 'yellow',
    version: 1,
    target: { kind: 'explanation', question_id: QUESTION },
    anchor: { block: 'p0', start, end },
    anchor_current: { block: 'p0', start, end },
    quote: TEXT.slice(start, end),
    anchor_status: 'exact',
  } as unknown as MyHighlight;
}

function area() {
  return screen.getByRole('group', { name: '해설' });
}

function selectFirstWord() {
  const text = area().querySelector('[data-hl-block]')?.firstChild;
  if (!text) throw new Error('no explanation text');
  fireEvent.pointerDown(area(), { pointerType: 'mouse' });
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(area(), { pointerType: 'mouse' });
}

const menu = () => screen.findByRole('menu', { name: '하이라이트' });

function renderExplanation() {
  render(
    <ExplanationText
      text={TEXT}
      highlighting={{ questionId: QUESTION, chapterTitle: '1장 물의 순환' }}
    />,
    { wrapper: ToastProvider },
  );
}

beforeEach(() => {
  client.getQuestionHighlights.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe('HILITE-01 explanation toasts', () => {
  it('says where a new highlight went on each one, not on a recolor, and has no text under the area', async () => {
    const user = userEvent.setup();
    client.createHighlight.mockResolvedValue(highlight('h1', 0, 1));
    client.recolorHighlight.mockResolvedValue({ ...highlight('h1', 0, 1), color: 'blue' });
    renderExplanation();

    selectFirstWord();
    await user.click(within(await menu()).getByRole('menuitemradio', { name: '노랑' }));
    await waitFor(() => expect(screen.getAllByText(NOTICE).length).toBeGreaterThan(0));
    const shown = () => document.querySelectorAll('.qz-toast').length;
    expect(shown()).toBe(1);
    expect(area().parentElement?.textContent).not.toContain('모았습니다');

    // Its menu recolors it.
    const mark = await waitFor(() => {
      const found = area().querySelector('mark');
      if (!found) throw new Error('no mark yet');
      return found;
    });
    fireEvent.pointerDown(mark, { pointerType: 'mouse' });
    fireEvent.pointerUp(mark, { pointerType: 'mouse' });
    await user.click(within(await menu()).getByRole('menuitemradio', { name: '파랑' }));
    await waitFor(() => expect(client.recolorHighlight).toHaveBeenCalled());
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(shown()).toBe(1);

    // Another range is a new highlight: a second toast.
    client.createHighlight.mockResolvedValue(highlight('h2', 2, 3));
    const second = mark.nextSibling;
    if (!second) throw new Error('no text after the mark');
    fireEvent.pointerDown(area(), { pointerType: 'mouse' });
    const range = document.createRange();
    range.setStart(second, 1);
    range.setEnd(second, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerUp(area(), { pointerType: 'mouse' });
    await user.click(within(await menu()).getByRole('menuitemradio', { name: '분홍' }));
    await waitFor(() => expect(shown()).toBe(2));
  });

  it('confirms 복사 with a toast', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderExplanation();

    selectFirstWord();
    await user.click(within(await menu()).getByRole('menuitem', { name: '복사' }));
    expect(writeText).toHaveBeenCalledWith(TEXT.slice(0, 1));
    await waitFor(() =>
      expect(document.querySelector('.qz-toast')).toHaveTextContent('복사했습니다.'),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
