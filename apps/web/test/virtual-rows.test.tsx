// @vitest-environment jsdom
// QVIEW-01 / CHREDIST-01 (UX9-REDIST-W): `VirtualRows`, the windowed list behind a long range
// picker chapter and a long 챕터 재분배 recommendation list.
import './dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const { VirtualRows } = await import('../src/components/questions/viewer/question-range-picker');

const items = Array.from({ length: 500 }, (_, i) => ({ id: `q${i}`, text: `추천 ${i}` }));

describe('VirtualRows', () => {
  it('CHREDIST-01-AC03 keeps a long recommendation list named and renders only a window of it', () => {
    render(
      <VirtualRows
        items={items}
        row={(item) => <input type="checkbox" aria-label={`적용: ${item.text}`} />}
        rowPx={104}
        label="추천"
      />,
    );
    const list = screen.getByRole('list', { name: '추천' });
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(30);
    expect(list.style.blockSize).toBe(`${500 * 104}px`);
    expect(screen.getByRole('checkbox', { name: '적용: 추천 0' })).toBeInTheDocument();

    // Scrolling the box brings the rows in view (and drops the first ones).
    const box = list.parentElement as HTMLElement;
    fireEvent.scroll(box, { target: { scrollTop: 300 * 104 } });
    expect(screen.queryByRole('checkbox', { name: '적용: 추천 0' })).toBeNull();
    const row = screen.getByRole('checkbox', { name: '적용: 추천 300' }).closest('li');
    expect(row?.style.insetBlockStart).toBe(`${300 * 104}px`);
  });
});
