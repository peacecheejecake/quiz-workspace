// @vitest-environment jsdom
// QIMPORT-01 (UX6-PROGRESS): the import shows its steps 업로드 → PDF 분석 → 문제 추출 instead of
// one bar that fills to 100 % per stage and drops back.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImportJobProgress } from '../src/components/questions/import/import-job-progress';

function states(): string[] {
  const list = screen.getByRole('list', { name: '진행 단계' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => `${item.getAttribute('data-state')}:${item.textContent}`);
}

describe('QIMPORT-01 import step progress (UX6-PROGRESS)', () => {
  it('QIMPORT-01-AC01 uploading: 업로드 is current, the others wait', () => {
    render(<ImportJobProgress step="uploading" value={40} filename="paper.pdf" />);
    expect(states()).toEqual([
      'current:1업로드진행 중',
      'pending:2PDF 분석대기',
      'pending:3문제 추출대기',
    ]);
    const bar = screen.getByRole('progressbar', { name: '가져오기 진행률' });
    expect(bar).toHaveAttribute('aria-valuetext', '1/3단계: PDF 업로드 중, 40%');
    expect(bar).toHaveAttribute('aria-valuenow', '13');
  });

  it('QIMPORT-01-AC01 processing and extracting never move the overall bar backwards', () => {
    const { rerender } = render(<ImportJobProgress step="processing" value={90} />);
    expect(states()).toEqual([
      'done:업로드완료',
      'current:2PDF 분석진행 중',
      'pending:3문제 추출대기',
    ]);
    const bar = screen.getByRole('progressbar', { name: '가져오기 진행률' });
    expect(bar).toHaveAttribute('aria-valuenow', '63');

    rerender(<ImportJobProgress step="starting" />);
    expect(states()[2]).toBe('current:3문제 추출진행 중');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', '3/3단계: 문제 추출 준비 중');

    rerender(<ImportJobProgress step="extracting" value={10} />);
    expect(states()).toEqual(['done:업로드완료', 'done:PDF 분석완료', 'current:3문제 추출진행 중']);
    expect(bar).toHaveAttribute('aria-valuenow', '70');
    expect(bar).toHaveAttribute('aria-valuetext', '3/3단계: 문제 추출 중, 10%');
  });
});
