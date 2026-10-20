import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FavoriteToggle,
  HeatmapLegend,
  QuestionDot,
  QuestionHeatmap,
  QuestionMarker,
  RetryToggle,
  StatusSummary,
  ThemeProvider,
  summarizeStatuses,
  type HeatmapChapter,
  type QuestionDotProps,
} from '../src';
import { axeViolations } from './axe';

const STAR_PATH =
  'M12 2.5 15.1 8.5 21.6 9.45 16.8 14.1 17.95 20.65 12 17.5 6.05 20.65 7.2 14.1 2.4 9.45 8.9 8.5Z';

const dotProps = (overrides: Partial<QuestionDotProps> = {}): QuestionDotProps => ({
  questionId: 'q-3-12',
  status: 'correct',
  isFavorite: false,
  questionNumber: '12',
  questionType: 'MCQ',
  chapterTitle: '어텐션',
  chapterNumber: 3,
  preview: 'Scaled dot-product attention에서 √d로 나누는 이유는?',
  onOpen: vi.fn(),
  ...overrides,
});

const STATUSES = ['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const;

function chapters(sizes: number[]): HeatmapChapter[] {
  return sizes.map((size, c) => ({
    id: `ch${c + 1}`,
    number: c + 1,
    title: `${c + 1}장 Chapter ${c + 1}`,
    questions: Array.from({ length: size }, (_, i) => ({
      id: `q-${c + 1}-${i + 1}`,
      number: String(i + 1),
      type: 'MCQ' as const,
      status: STATUSES[i % STATUSES.length] ?? 'unseen',
      isFavorite: i % 3 === 0,
      preview: `${c + 1}장 ${i + 1}번 문제의 본문`,
    })),
  }));
}

/**
 * Loads the real tokens and the kit's marker rules into jsdom (for computed-style assertions).
 * jsdom's CSS parser does not support nesting, so only the flat top-level `.qz-question-marker`
 * rules of questions.css are taken.
 */
function loadStyles() {
  const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');
  const markerRules = read('../src/styles/questions.css').match(
    /^\.qz-question-marker[^{]*\{[^}]*\}/gm,
  );
  // Base box, outline and the five status colors.
  expect(markerRules?.length).toBeGreaterThanOrEqual(7);
  const style = document.createElement('style');
  style.textContent = [
    read('../../design-tokens/generated/tokens.css'),
    ...(markerRules ?? []),
  ].join('\n');
  document.head.append(style);
  return () => style.remove();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('QuestionMarker', () => {
  it('renders the §6.1 rounded square, hidden from assistive technology', () => {
    render(<QuestionMarker status="viewed" />);
    const marker = screen.getByTestId('question-marker');
    expect(marker).toHaveAttribute('data-shape', 'square');
    expect(marker).toHaveAttribute('data-status', 'viewed');
    expect(marker).toHaveAttribute('aria-hidden', 'true');
    expect(marker).toHaveAttribute('viewBox', '0 0 24 24');
    const rect = marker.querySelector('rect');
    expect(rect).toHaveAttribute('rx', '4.5');
    expect(rect).toHaveAttribute('width', '18');
    expect(marker.querySelector('path')).toBeNull();
  });

  it('favorite swaps to the rounded star with the same viewBox and status', () => {
    render(<QuestionMarker status="viewed" favorite />);
    const marker = screen.getByTestId('question-marker');
    expect(marker).toHaveAttribute('data-shape', 'star');
    expect(marker).toHaveAttribute('data-status', 'viewed');
    expect(marker).toHaveAttribute('viewBox', '0 0 24 24');
    const path = marker.querySelector('path');
    expect(path).toHaveAttribute('d', STAR_PATH);
    expect(path).toHaveAttribute('stroke-linejoin', 'round');
    expect(marker.querySelector('rect')).toBeNull();
  });

  it('favorite keeps the computed color and box size (QOV-01-AC03)', () => {
    const unload = loadStyles();
    try {
      for (const status of STATUSES) {
        const { unmount } = render(
          <>
            <QuestionMarker status={status} testId="square" />
            <QuestionMarker status={status} favorite testId="star" />
          </>,
        );
        const square = getComputedStyle(screen.getByTestId('square'));
        const star = getComputedStyle(screen.getByTestId('star'));
        // jsdom cascades but does not resolve var(); real pixels are checked in the
        // Playwright visual suite (visual/question-marker.visual.ts).
        expect(square.color).toBe(`var(--question-status-${status})`);
        expect(star.color).toBe(square.color);
        expect(star.width).toBe(square.width);
        expect(star.height).toBe(square.height);
        unmount();
      }
    } finally {
      unload();
    }
  });

  it('decorative copies can drop the test id', () => {
    render(<QuestionMarker status="unseen" testId={null} />);
    expect(screen.queryByTestId('question-marker')).toBeNull();
  });
});

describe('QuestionDot', () => {
  it('is a button named per docs/questions.md §3.2 with data-status', () => {
    render(
      <QuestionDot
        {...dotProps({ status: 'retry', lastGradedResult: 'incorrect', isFavorite: true })}
      />,
    );
    const dot = screen.getByRole('button', { name: /3장 12번 문제/ });
    expect(dot).toHaveAccessibleName(
      '3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기',
    );
    expect(dot).toHaveAttribute('data-status', 'retry');
    expect(dot).toHaveAttribute('type', 'button');
    expect(within(dot).getByTestId('question-marker')).toHaveAttribute('data-shape', 'star');
  });

  it('includes pending grading in the label', () => {
    render(
      <QuestionDot
        {...dotProps({ status: 'viewed', questionType: 'ESSAY', isPendingGrading: true })}
      />,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName(/서술형.*채점 대기/);
  });

  it('marks the selected dot without changing its status', () => {
    const { rerender } = render(<QuestionDot {...dotProps()} />);
    const dot = screen.getByRole('button');
    expect(dot).not.toHaveAttribute('aria-current');
    rerender(<QuestionDot {...dotProps({ isSelected: true })} />);
    expect(dot).toHaveAttribute('aria-current', 'true');
    expect(dot).toHaveAttribute('data-status', 'correct');
    expect(within(dot).getByTestId('question-marker')).toHaveAttribute('data-status', 'correct');
  });

  it('favorite changes only the shape: same status, button class and marker class', () => {
    const { rerender } = render(<QuestionDot {...dotProps()} />);
    const dot = screen.getByRole('button');
    const before = {
      cls: dot.className,
      marker: screen.getByTestId('question-marker').getAttribute('class'),
    };
    rerender(<QuestionDot {...dotProps({ isFavorite: true })} />);
    expect(dot.className).toBe(before.cls);
    expect(screen.getByTestId('question-marker')).toHaveAttribute('class', before.marker ?? '');
    expect(screen.getByTestId('question-marker')).toHaveAttribute('data-shape', 'star');
    expect(dot).toHaveAttribute('data-status', 'correct');
    expect(dot).toHaveAccessibleName(/즐겨찾기/);
  });

  it('click, Enter and Space call onOpen with the question id', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<QuestionDot {...dotProps({ onOpen })} />);
    const dot = screen.getByRole('button');
    await user.click(dot);
    expect(onOpen).toHaveBeenLastCalledWith('q-3-12');
    expect(dot).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('hover shows the preview tooltip without opening the question (QOV-01-AC02)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    render(
      <QuestionDot
        {...dotProps({ onOpen, onPreview, status: 'unseen', isFavorite: true, needsRetry: false })}
      />,
    );
    const dot = screen.getByRole('button');
    await user.hover(dot);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/√d로 나누는 이유/);
    // The role="tooltip" copy carries the whole preview, status included (not just the stem).
    expect(tooltip).toHaveTextContent('아직 보지 않음');
    // The visible preview card: type, number, chapter, status, favorite.
    const card = document.querySelector('.qz-question-preview');
    expect(card).toHaveTextContent('객관식');
    expect(card).toHaveTextContent('3장 12번 문제');
    expect(card).toHaveTextContent('어텐션');
    expect(card).toHaveTextContent('아직 보지 않음');
    expect(card).toHaveTextContent('즐겨찾기');
    expect(card?.querySelector('[data-testid="question-marker"]')).toBeNull();
    expect(onPreview).toHaveBeenCalledWith('q-3-12');
    expect(onOpen).not.toHaveBeenCalled();
    expect(dot).toHaveAttribute('data-status', 'unseen');
  });

  it('waits about 200ms before showing the hover preview', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuestionDot {...dotProps()} />);
    await user.hover(screen.getByRole('button'));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('keyboard focus shows the preview and Escape closes it, keeping focus', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<QuestionDot {...dotProps({ onOpen })} />);
    await user.tab();
    const dot = screen.getByRole('button');
    expect(dot).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(dot).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

/** Fake layout: `columns` dots per row, chapters stacked vertically with a heading gap. */
function mockGridLayout(columns: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.matches('[data-question-id]')) return new DOMRect();
    const lists = Array.from(document.querySelectorAll('.qz-heatmap > .chapter > .grid'));
    let top = 0;
    for (const list of lists) {
      const dots = Array.from(list.querySelectorAll('[data-question-id]'));
      const index = dots.indexOf(this);
      const rows = Math.ceil(dots.length / columns);
      if (index !== -1) {
        return new DOMRect(
          (index % columns) * 32,
          top + 40 + Math.floor(index / columns) * 32,
          28,
          28,
        );
      }
      top += 40 + rows * 32;
    }
    return new DOMRect();
  });
}

describe('QuestionHeatmap', () => {
  it('renders one marker per question, grouped by chapter with title and count', () => {
    render(<QuestionHeatmap chapters={chapters([7, 5])} onOpen={vi.fn()} />);
    expect(screen.getAllByTestId('question-marker')).toHaveLength(12);
    const first = screen.getByRole('region', { name: '1장 Chapter 1' });
    expect(within(first).getByRole('heading', { level: 3 })).toHaveTextContent('1장 Chapter 1');
    expect(within(first).getByText('7문제')).toBeInTheDocument();
    expect(within(first).getAllByRole('button')).toHaveLength(7);
    expect(screen.getByRole('group', { name: '문제 heatmap' })).toBeInTheDocument();
  });

  it('exposes a single tab stop (roving tabindex), defaulting to the selected dot', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <button type="button">before</button>
        <QuestionHeatmap chapters={chapters([4, 3])} onOpen={vi.fn()} />
        <button type="button">after</button>
      </>,
    );
    const buttons = screen.getAllByRole('button', { name: /번 문제/ });
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('tabindex', '0');

    rerender(
      <>
        <button type="button">before</button>
        <QuestionHeatmap chapters={chapters([4, 3])} selectedQuestionId="q-2-2" onOpen={vi.fn()} />
        <button type="button">after</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(screen.getByRole('button', { name: /^2장 2번 문제/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('Arrow Left/Right move through dots across chapters; Home/End stay in the chapter', async () => {
    const user = userEvent.setup();
    render(<QuestionHeatmap chapters={chapters([3, 3])} onOpen={vi.fn()} />);
    const dot = (c: number, n: number) =>
      screen.getByRole('button', { name: new RegExp(`^${c}장 ${n}번 문제`) });
    await user.tab();
    expect(dot(1, 1)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(dot(1, 1)).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(dot(2, 1)).toHaveFocus();
    expect(dot(2, 1)).toHaveAttribute('tabindex', '0');
    expect(dot(1, 1)).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{End}');
    expect(dot(2, 3)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(dot(2, 1)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(dot(1, 3)).toHaveFocus();
    await user.keyboard('{Control>}{End}{/Control}');
    expect(dot(2, 3)).toHaveFocus();
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(dot(1, 1)).toHaveFocus();
  });

  it('Arrow Up/Down move by visual row, across chapter boundaries', async () => {
    const user = userEvent.setup();
    mockGridLayout(4);
    // Chapter 1: 6 dots → rows [1-4], [5-6]; chapter 2: 4 dots → row [1-4].
    render(<QuestionHeatmap chapters={chapters([6, 4])} onOpen={vi.fn()} />);
    const dot = (c: number, n: number) =>
      screen.getByRole('button', { name: new RegExp(`^${c}장 ${n}번 문제`) });
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(dot(1, 3)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    // Row 2 has columns 1–2 only: nearest to column 3 is dot 6 (column 2).
    expect(dot(1, 6)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(dot(2, 2)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(dot(2, 2)).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(dot(1, 2)).toHaveFocus();
  });

  it('Enter/Space/click open the focused question; hover does not', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    render(<QuestionHeatmap chapters={chapters([3])} onOpen={onOpen} onPreview={onPreview} />);
    await user.tab();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith('q-1-2');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
    const third = screen.getByRole('button', { name: /^1장 3번 문제/ });
    await user.hover(third);
    await vi.waitFor(() => expect(onPreview).toHaveBeenCalledWith('q-1-3'));
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.click(third);
    expect(onOpen).toHaveBeenLastCalledWith('q-1-3');
    expect(third).toHaveAttribute('tabindex', '0');
  });

  it('keeps a tab stop when the active question is filtered out', async () => {
    const user = userEvent.setup();
    function Filtered() {
      const [all, setAll] = useState(true);
      const data = chapters([4]);
      const visible = all
        ? data
        : data.map((c) => ({ ...c, questions: c.questions.filter((q) => q.id !== 'q-1-3') }));
      return (
        <>
          <button type="button" onClick={() => setAll(false)}>
            filter
          </button>
          <QuestionHeatmap chapters={visible} onOpen={vi.fn()} />
        </>
      );
    }
    render(<Filtered />);
    await user.click(screen.getByRole('button', { name: /^1장 3번 문제/ }));
    await user.click(screen.getByRole('button', { name: 'filter' }));
    const dots = screen.getAllByRole('button', { name: /번 문제/ });
    expect(dots).toHaveLength(3);
    expect(dots.filter((d) => d.tabIndex === 0)).toHaveLength(1);
  });
});

describe('legend, summary and toggles', () => {
  it('legend names every status and the favorite star, without counted markers', () => {
    render(<HeatmapLegend />);
    const legend = screen.getByRole('list', { name: '상태 범례' });
    for (const name of ['미열람', '열람', '오답', '정답', '다시 풀기', '즐겨찾기']) {
      expect(within(legend).getByText(name)).toBeInTheDocument();
    }
    expect(legend.querySelector('[data-shape="star"]')).not.toBeNull();
    expect(screen.queryByTestId('question-marker')).toBeNull();
  });

  it('summary shows mutually exclusive counts and the favorite overlap', () => {
    const counts = summarizeStatuses([
      { status: 'retry', isFavorite: true },
      { status: 'correct', isFavorite: true },
      { status: 'unseen', isFavorite: false },
    ]);
    render(<StatusSummary counts={counts} />);
    const region = screen.getByRole('region', { name: '문제 상태 요약' });
    const chip = (name: string) =>
      within(region)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith(name));
    expect(chip('전체')).toHaveTextContent('전체3');
    expect(chip('다시 풀기')).toHaveTextContent('1');
    expect(chip('정답')).toHaveTextContent('1');
    expect(chip('열람')).toHaveTextContent('0');
    expect(chip('즐겨찾기')).toHaveTextContent('2');
    expect(screen.queryByTestId('question-marker')).toBeNull();
  });

  it('FavoriteToggle flips its label and reports the next state', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <FavoriteToggle pressed={on} onPressedChange={setOn} />;
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '즐겨찾기 추가' }));
    const toggle = screen.getByRole('button', { name: '즐겨찾기 해제' });
    expect(toggle).toHaveAttribute('data-state', 'on');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: '즐겨찾기 추가' })).toHaveAttribute(
      'data-state',
      'off',
    );
  });

  it('RetryToggle uses 다시 풀기 표시 / 해제', async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    const { rerender } = render(<RetryToggle pressed={false} onPressedChange={onPressedChange} />);
    await user.click(screen.getByRole('button', { name: '다시 풀기 표시' }));
    expect(onPressedChange).toHaveBeenLastCalledWith(true);
    rerender(<RetryToggle pressed onPressedChange={onPressedChange} />);
    await user.click(screen.getByRole('button', { name: '다시 풀기 해제' }));
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });
});

describe.each(['light', 'dark'] as const)('axe (%s theme)', (theme) => {
  it('heatmap with an open preview, legend, summary and toggles', async () => {
    const user = userEvent.setup();
    const data = chapters([12, 6]);
    render(
      <ThemeProvider theme={theme}>
        <main>
          <StatusSummary counts={summarizeStatuses(data.flatMap((c) => c.questions))} />
          <QuestionHeatmap chapters={data} selectedQuestionId="q-1-2" onOpen={vi.fn()} />
          <HeatmapLegend />
          <FavoriteToggle pressed onPressedChange={vi.fn()} />
          <RetryToggle pressed={false} onPressedChange={vi.fn()} />
        </main>
      </ThemeProvider>,
    );
    await user.hover(screen.getByRole('button', { name: /^1장 3번 문제/ }));
    await screen.findByRole('tooltip');
    expect(document.documentElement).toHaveAttribute('data-theme', theme);
    expect(await axeViolations()).toEqual([]);
  });
});
