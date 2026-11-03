// @vitest-environment jsdom
// CHREDIST-01 (UX9-REDIST-W): the 챕터 재분배 preview step's recommendation rows. A long list is
// virtualized with fixed-height rows; 현재 and 추천 are separate lines there, each clamped on its
// own, so a long current chapter never hides the recommended one.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RedistributionPreview } from '../src/lib/questions/redistribution';

const { PreviewStep } =
  await import('../src/components/questions/redistribution/chapter-redistribution-dialog');

const LONG = '아주 긴 현재 챕터 제목이 한 줄을 넘어 추천 챕터를 가릴 수 있는 경우';

function preview(n: number): RedistributionPreview {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      question_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      number_label: `1장 ${i + 1}번`,
      stem_preview: `문제 ${i + 1}`,
      current_chapter: { id: 'c1', title: LONG, document_id: 'd1' },
      recommended_chapter: { id: 'c2', title: '2장 정수 처리', document_id: 'd1' },
      reason: 'matched',
    })),
    unchanged: 0,
    no_recommendation: {},
    skipped_manual: 0,
  };
}

function renderStep(n: number) {
  const data = preview(n);
  render(
    <PreviewStep
      preview={{ status: 'ready', data }}
      checked={new Set(data.items.map((i) => i.question_id))}
      onCheckedChange={vi.fn()}
      backRef={createRef()}
      applyRef={createRef()}
      applyReasonId="reason"
      busy={false}
      onBack={vi.fn()}
      onApply={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  return screen.getByRole('list', { name: '추천' });
}

describe('CHREDIST-01 preview rows', () => {
  it('CHREDIST-01-AC03 virtualizes a long list and keeps 현재 and 추천 on separate lines', () => {
    const list = renderStep(200);
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeLessThan(200); // windowed
    const heights = new Set(rows.map((r) => r.style.blockSize));
    expect(heights.size).toBe(1); // one fixed height for every row

    const row = rows[0] as HTMLElement;
    const current = row.querySelector('[data-part="current"]');
    const recommended = row.querySelector('[data-part="recommended"]');
    expect(current?.textContent).toBe(`현재: ${LONG}`);
    expect(recommended?.textContent).toMatch(/^→\s*추천: 2장 정수 처리$/);
    expect(current).not.toBe(recommended);
    expect(current?.contains(recommended ?? null)).toBe(false);
    expect(recommended?.contains(current ?? null)).toBe(false);
    expect(within(row).getByRole('checkbox')).toHaveAccessibleName(
      `적용: 1장 1번 · 문제 1 (${LONG}에서 2장 정수 처리으로)`,
    );
  });

  it('CHREDIST-01-AC03 renders a short list in full with the same two lines', () => {
    const list = renderStep(3);
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-part="recommended"]')?.textContent).toContain(
      '추천: 2장 정수 처리',
    );
  });
});
