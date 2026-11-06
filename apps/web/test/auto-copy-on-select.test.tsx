// @vitest-environment jsdom
import './dom-setup';
import { act, render, screen } from '@testing-library/react';
import { ToastProvider } from '@quiz/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoCopyOnSelect } from '../src/components/app-shell/use-auto-copy-on-select';
import { readAutoCopy, writeAutoCopy } from '../src/lib/auto-copy-preference';

function Harness() {
  useAutoCopyOnSelect();
  return (
    <>
      <p data-testid="plain">plain text here</p>
      <input aria-label="field" defaultValue="typed" />
      <div data-testid="editable" contentEditable suppressContentEditableWarning>
        editable text
      </div>
      <div className="qz-highlightable">
        <p data-testid="reading">
          <span data-hl-skip="">hidden label</span>reading text
        </p>
      </div>
    </>
  );
}

function press(target: Element, type: string, init: { button?: number; pointer?: string } = {}) {
  const event = new MouseEvent(type, { bubbles: true, button: init.button ?? 0 });
  Object.defineProperty(event, 'pointerType', { value: init.pointer ?? 'mouse' });
  target.dispatchEvent(event);
}

function select(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** A press on `target` during which `element` becomes the selection. */
async function pressSelecting(
  target: Element,
  element: Element | null,
  init?: { button?: number; pointer?: string },
) {
  press(target, 'pointerdown', init);
  if (element) select(element);
  press(target, 'pointerup', init);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const mount = () =>
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );

describe('useAutoCopyOnSelect', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    localStorage.clear();
    window.getSelection()?.removeAllRanges();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies nothing while the setting is off', async () => {
    mount();
    const plain = screen.getByTestId('plain');
    await pressSelecting(plain, plain);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies a pointer selection and shows the toast, applied without a remount', async () => {
    mount();
    act(() => writeAutoCopy(true));
    const plain = screen.getByTestId('plain');
    await pressSelecting(plain, plain);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('plain text here');
    expect(await screen.findByText('복사했습니다.')).toBeInTheDocument();
  });

  it('copies a double click once, even when the first release runs late, and again next time', async () => {
    writeAutoCopy(true);
    mount();
    const plain = screen.getByTestId('plain');
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const doubleClick = async () => {
      press(plain, 'pointerdown');
      press(plain, 'pointerup');
      // The second press selects the word before the first release's task gets to run.
      press(plain, 'pointerdown');
      select(plain);
      await flush();
      press(plain, 'pointerup');
      await flush();
    };

    await doubleClick();
    expect(writeText).toHaveBeenCalledTimes(1);

    window.getSelection()?.removeAllRanges();
    await doubleClick();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('leaves a selection the press did not change alone', async () => {
    writeAutoCopy(true);
    mount();
    const plain = screen.getByTestId('plain');
    select(plain);
    await pressSelecting(plain, null);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('ignores touch pointers and other buttons', async () => {
    writeAutoCopy(true);
    mount();
    const plain = screen.getByTestId('plain');
    await pressSelecting(plain, plain, { pointer: 'touch' });
    await pressSelecting(plain, plain, { button: 2 });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('ignores presses in fields and selections inside contenteditable', async () => {
    writeAutoCopy(true);
    mount();
    const plain = screen.getByTestId('plain');
    await pressSelecting(screen.getByLabelText('field'), plain);
    window.getSelection()?.removeAllRanges();
    const editable = screen.getByTestId('editable');
    await pressSelecting(plain, editable);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies reading regions without their hidden labels', async () => {
    writeAutoCopy(true);
    mount();
    const reading = screen.getByTestId('reading');
    await pressSelecting(reading, reading);
    expect(writeText).toHaveBeenCalledWith('reading text');
  });

  it('stays quiet when the clipboard refuses, and never logs the text', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const log = vi.spyOn(console, 'error');
    writeAutoCopy(true);
    mount();
    const plain = screen.getByTestId('plain');
    await pressSelecting(plain, plain);
    expect(screen.queryByText('복사했습니다.')).not.toBeInTheDocument();
    expect(JSON.stringify(log.mock.calls)).not.toContain('plain text here');
  });
});

describe('auto copy preference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is off by default and remembers the choice', () => {
    localStorage.clear();
    expect(readAutoCopy()).toBe(false);
    writeAutoCopy(true);
    expect(readAutoCopy()).toBe(true);
    writeAutoCopy(false);
    expect(readAutoCopy()).toBe(false);
  });

  it('reads as off when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeAutoCopy(true)).not.toThrow();
    expect(readAutoCopy()).toBe(false);
  });
});
