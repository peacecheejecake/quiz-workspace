// @vitest-environment jsdom
// DOCVIEW-01 (DOC-02-AC08 in every view mode): a pane hidden by a view mode catches up only when
// it is shown again, with the latest catch-up callback, and not on its first render or on hiding.
import './dom-setup';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWhenShown } from '../src/components/documents/editor/text-sync';

function Probe({ visible, onShown }: { visible: boolean; onShown: () => void }) {
  useWhenShown(visible, onShown);
  return null;
}

describe('useWhenShown', () => {
  it('fires once per hidden → shown transition with the latest callback', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<Probe visible onShown={first} />);
    expect(first).not.toHaveBeenCalled(); // already visible on mount: nothing to catch up

    rerender(<Probe visible={false} onShown={first} />);
    expect(first).not.toHaveBeenCalled(); // hiding does not scroll anything
    rerender(<Probe visible={false} onShown={latest} />); // e.g. the page changed while hidden
    rerender(<Probe visible onShown={latest} />);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);

    rerender(<Probe visible onShown={latest} />);
    expect(latest).toHaveBeenCalledTimes(1); // staying visible does not repeat it
  });

  it('a pane that mounts hidden catches up the first time it shows', () => {
    const onShown = vi.fn();
    const { rerender } = render(<Probe visible={false} onShown={onShown} />);
    rerender(<Probe visible onShown={onShown} />);
    expect(onShown).toHaveBeenCalledTimes(1);
  });
});
