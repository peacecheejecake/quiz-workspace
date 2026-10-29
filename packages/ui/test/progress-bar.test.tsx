import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from '../src';

const FOUNDATION = readFileSync(
  resolve(import.meta.dirname, '../src/styles/foundation.css'),
  'utf8',
);

describe('ProgressBar (UX5-UI)', () => {
  it('is a named progressbar with the value as width', () => {
    render(<ProgressBar label="업로드 진행률" value={42} />);
    const bar = screen.getByRole('progressbar', { name: '업로드 진행률' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '42%');
    expect(bar).not.toHaveAttribute('data-indeterminate');
    expect(bar.firstElementChild).toHaveStyle({ width: '42%' });
  });

  it('keeps the same fill element across value changes so the width can transition', () => {
    const { rerender } = render(<ProgressBar label="진행률" value={2} />);
    const fill = screen.getByRole('progressbar').firstElementChild;
    rerender(<ProgressBar label="진행률" value={60} />);
    expect(screen.getByRole('progressbar').firstElementChild).toBe(fill);
    expect(fill).toHaveStyle({ width: '60%' });
  });

  it('is indeterminate without a value and clamps out-of-range values', () => {
    const { rerender } = render(<ProgressBar label="진행률" valueText="분석 중" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', '분석 중');
    expect(bar).toHaveAttribute('data-indeterminate');
    rerender(<ProgressBar label="진행률" value={140} />);
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('UX6-PROGRESS keeps an indeterminate fill at 0 so the first value only moves forwards', () => {
    const { rerender } = render(<ProgressBar label="진행률" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('0%');
    // The indeterminate cue is a sweep in the track, not a fake 30 % fill.
    expect(FOUNDATION).not.toMatch(/\[data-indeterminate\] > \.fill\s*\{[^}]*width:\s*30%/);
    rerender(<ProgressBar label="진행률" value={10} />);
    expect(screen.getByRole('progressbar').firstElementChild).toBe(fill);
    expect(fill.style.width).toBe('10%');
  });

  it('animates the fill with the motion tokens and never under reduced motion', () => {
    expect(FOUNDATION).toMatch(
      /transition:\s*width var\(--duration-progress\) var\(--easing-standard\)/,
    );
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.qz-progress > \.fill\s*\{\s*transition: none !important;/;
    expect(FOUNDATION).toMatch(reduced);
  });
});
