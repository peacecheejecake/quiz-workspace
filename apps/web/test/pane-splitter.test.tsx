// @vitest-environment jsdom
// DOCVIEW (DOC-02-AC10): the PDF/text separator's keyboard contract and remembered share.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampSplit,
  PaneSplitter,
  SPLIT_DEFAULT,
  SPLIT_STORAGE_KEY,
  useSplitRatio,
} from '../src/components/documents/editor/pane-splitter';
import { resetPreferencesForTests } from '../src/lib/documents/viewer-preferences';

function Harness() {
  const [share, set, commit] = useSplitRatio();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <div id="pdf">pdf</div>
      <PaneSplitter
        value={share}
        onChange={set}
        onCommit={commit}
        containerRef={ref}
        controls="pdf"
      />
    </div>
  );
}

afterEach(() => {
  window.localStorage.clear();
  resetPreferencesForTests();
});

describe('PaneSplitter', () => {
  it('is a named vertical separator with its value, limits and controlled pane', () => {
    render(<Harness />);
    const separator = screen.getByRole('separator', { name: 'PDF와 원문 폭 조정' });
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuenow', String(SPLIT_DEFAULT));
    expect(separator).toHaveAttribute('aria-valuemin', '25');
    expect(separator).toHaveAttribute('aria-valuemax', '75');
    expect(separator).toHaveAttribute('aria-controls', 'pdf');
    expect(separator).toHaveAttribute('tabindex', '0');
  });

  it('moves by 5% (Shift 10%), jumps to the limits, resets on Enter and remembers the share', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const separator = screen.getByRole('separator');
    separator.focus();
    await user.keyboard('{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(separator).toHaveAttribute('aria-valuenow', '60');
    await user.keyboard('{End}');
    expect(separator).toHaveAttribute('aria-valuenow', '75');
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '75');
    await user.keyboard('{Home}');
    expect(separator).toHaveAttribute('aria-valuenow', '25');
    expect(window.localStorage.getItem(SPLIT_STORAGE_KEY)).toBe('25');
    await user.keyboard('{Enter}');
    expect(separator).toHaveAttribute('aria-valuenow', String(SPLIT_DEFAULT));
  });

  it('starts from a remembered share, clamped', () => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, '90');
    render(<Harness />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '75');
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
    expect(clampSplit(10)).toBe(25);
  });
});
