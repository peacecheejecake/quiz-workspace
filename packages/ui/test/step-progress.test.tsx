import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepProgress } from '../src';

const FOUNDATION = readFileSync(
  resolve(import.meta.dirname, '../src/styles/foundation.css'),
  'utf8',
);

const STEPS = [
  { id: 'upload', label: '업로드' },
  { id: 'parse', label: '분석' },
  { id: 'index', label: '색인' },
] as const;

function stepStates(): (string | null)[] {
  const list = screen.getByRole('list', { name: '진행 단계' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-state'));
}

describe('StepProgress (UX6-PROGRESS)', () => {
  it('lists the steps in order as done / current / pending, in text and not by colour alone', () => {
    render(<StepProgress label="처리 진행률" steps={STEPS} current={1} value={30} />);
    const items = within(screen.getByRole('list', { name: '진행 단계' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '업로드완료',
      '2분석진행 중',
      '3색인대기',
    ]);
    expect(stepStates()).toEqual(['done', 'current', 'pending']);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
    // The done step carries a check icon instead of its number.
    expect(items[0]?.querySelector('svg')).not.toBeNull();
  });

  it('reports overall progress that never goes backwards, and the step progress as text', () => {
    const { rerender } = render(
      <StepProgress label="처리 진행률" steps={STEPS} current={0} value={100} />,
    );
    const bar = screen.getByRole('progressbar', { name: '처리 진행률' });
    expect(bar).toHaveAttribute('aria-valuenow', '33');
    expect(bar).toHaveAttribute('aria-valuetext', '1/3단계: 업로드, 100%');

    // The next step starts at 0 %: the overall value stays where the last step ended.
    rerender(<StepProgress label="처리 진행률" steps={STEPS} current={1} value={0} />);
    expect(bar).toHaveAttribute('aria-valuenow', '33');
    rerender(
      <StepProgress
        label="처리 진행률"
        steps={STEPS}
        current={1}
        value={30}
        currentText="분석 중"
      />,
    );
    expect(bar).toHaveAttribute('aria-valuenow', '43');
    expect(bar).toHaveAttribute('aria-valuetext', '2/3단계: 분석 중, 30%');
  });

  it('fills done segments, the current one by its value and leaves pending ones empty', () => {
    render(<StepProgress label="처리 진행률" steps={STEPS} current={1} value={45} />);
    const fills = [
      ...screen.getByRole('progressbar').querySelectorAll<HTMLElement>('.segment > .fill'),
    ];
    expect(fills.map((fill) => fill.style.transform)).toEqual([
      'scaleX(1)',
      'scaleX(0.45)',
      'scaleX(0)',
    ]);
  });

  it('keeps the same fill elements across steps so they can transition', () => {
    const { rerender } = render(
      <StepProgress label="진행률" steps={STEPS} current={0} value={20} />,
    );
    const before = [...screen.getByRole('progressbar').querySelectorAll('.fill')];
    rerender(<StepProgress label="진행률" steps={STEPS} current={2} value={60} />);
    const after = [...screen.getByRole('progressbar').querySelectorAll('.fill')];
    expect(after).toEqual(before);
  });

  it('marks an unknown current step indeterminate without aria-valuenow', () => {
    render(
      <StepProgress label="가져오기 진행률" steps={STEPS} current={1} currentText="처리 대기 중" />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', '2/3단계: 처리 대기 중');
    const segments = bar.querySelectorAll('.segment');
    expect(segments[1]).toHaveAttribute('data-indeterminate');
    expect(segments[0]).not.toHaveAttribute('data-indeterminate');
  });

  it('shows every step done past the last one and clamps values', () => {
    const { rerender } = render(
      <StepProgress label="진행률" steps={STEPS} current={3} value={50} />,
    );
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '3/3단계 완료');
    rerender(<StepProgress label="진행률" steps={STEPS} current={2} value={140} />);
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('animates the segment fill with the motion tokens and never under reduced motion', () => {
    expect(FOUNDATION).toMatch(
      /\.qz-step-progress[\s\S]*transition:\s*transform var\(--duration-progress\) var\(--easing-standard\)/,
    );
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.qz-step-progress \.segment > \.fill[^{]*\{\s*transition: none !important;/;
    expect(FOUNDATION).toMatch(reduced);
  });
});
