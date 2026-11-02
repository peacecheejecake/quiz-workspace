// UX9-MODAL (design-system §5.5, HOMEDLG-01): backdrop click = close unless the dialog holds
// unsaved input, the click never reaches the content underneath, the modal scroll lock adds no
// scrollbar compensation, and the panel's 이전/다음 steps.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FloatingSidePanel, Input, ModalDialog, useUnsavedChanges } from '../src';

function backdrop(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('.qz-backdrop');
  const top = all[all.length - 1];
  if (!top) throw new Error('no backdrop');
  return top;
}

/** A real click sequence on the backdrop (pointerdown → click on the same element). */
function clickBackdrop() {
  const target = backdrop();
  fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' });
  fireEvent.mouseDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0, pointerType: 'mouse' });
  fireEvent.mouseUp(target, { button: 0 });
  fireEvent.click(target, { button: 0 });
}

function UnsavedField() {
  const [value, setValue] = useState('');
  useUnsavedChanges(value !== '');
  return <Input label="이름" value={value} onChange={(e) => setValue(e.target.value)} />;
}

function Panel({
  kind,
  dirty,
  onBehind,
}: {
  kind: 'panel' | 'dialog';
  dirty?: boolean;
  onBehind?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Shell = kind === 'panel' ? FloatingSidePanel : ModalDialog;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      <button type="button" onClick={onBehind}>
        뒤 버튼
      </button>
      <Shell open={open} onOpenChange={setOpen} title="대화 상자" dirty={dirty ?? false}>
        <UnsavedField />
      </Shell>
    </>
  );
}

describe.each(['panel', 'dialog'] as const)('modal %s backdrop', (kind) => {
  it('closes on a backdrop click (a panel returns focus to its opener)', async () => {
    const user = userEvent.setup();
    render(<Panel kind={kind} />);
    const opener = screen.getByRole('button', { name: '열기' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: '대화 상자' });
    clickBackdrop();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // A ModalDialog opened without a trigger returns focus through its caller's onCloseAutoFocus.
    if (kind === 'panel') await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not close on pointerdown alone (the click must finish on the backdrop)', async () => {
    const user = userEvent.setup();
    render(<Panel kind={kind} />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await screen.findByRole('dialog', { name: '대화 상자' });
    fireEvent.pointerDown(backdrop(), { button: 0, pointerType: 'mouse' });
    expect(screen.getByRole('dialog', { name: '대화 상자' })).toBeInTheDocument();
  });

  it('stays open with unsaved input reported from inside (useUnsavedChanges)', async () => {
    const user = userEvent.setup();
    render(<Panel kind={kind} />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await user.type(await screen.findByRole('textbox', { name: '이름' }), '모의고사');
    clickBackdrop();
    expect(screen.getByRole('dialog', { name: '대화 상자' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '이름' })).toHaveValue('모의고사');
    // Escape still closes it (only the backdrop is held back).
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stays open while `dirty`, and the click never reaches the content behind', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    render(<Panel kind={kind} dirty onBehind={behind} />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await screen.findByRole('dialog', { name: '대화 상자' });
    clickBackdrop();
    expect(screen.getByRole('dialog', { name: '대화 상자' })).toBeInTheDocument();
    expect(behind).not.toHaveBeenCalled();
  });
});

describe('modal scroll lock', () => {
  it('turns off the scrollbar compensation on body (the html gutter keeps the room)', async () => {
    const user = userEvent.setup();
    render(<Panel kind="panel" />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await screen.findByRole('dialog', { name: '대화 상자' });
    // RemoveScroll locks the page through this attribute; overlays.css (jsdom does not load it,
    // so the rule is read from the source) overrides its margin/padding compensation.
    expect(document.body).toHaveAttribute('data-scroll-locked');
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/overlays.css'), 'utf8');
    const rule = /html body\[data-scroll-locked\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/margin-right:\s*0 !important/);
    expect(rule).toMatch(/padding-right:\s*0 !important/);
  });
});

function Steps() {
  const items = ['가', '나', '다'];
  const [at, setAt] = useState(0);
  return (
    <FloatingSidePanel
      defaultOpen
      title="발췌"
      steps={{
        previousLabel: '이전 결과',
        nextLabel: '다음 결과',
        onPrevious: at > 0 ? () => setAt(at - 1) : undefined,
        onNext: at < items.length - 1 ? () => setAt(at + 1) : undefined,
      }}
    >
      <p>{items[at]}</p>
    </FloatingSidePanel>
  );
}

describe('FloatingSidePanel steps', () => {
  it('moves with the header buttons and Alt+↑/Alt+↓, disabling the end; focus stays in the pair', async () => {
    const user = userEvent.setup();
    render(<Steps />);
    const dialog = await screen.findByRole('dialog', { name: '발췌' });
    const previous = screen.getByRole('button', { name: '이전 결과' });
    const next = screen.getByRole('button', { name: '다음 결과' });
    expect(previous).toBeDisabled();
    expect(dialog).toHaveTextContent('가');

    await user.click(next);
    expect(dialog).toHaveTextContent('나');
    await user.click(next);
    expect(dialog).toHaveTextContent('다');
    expect(next).toBeDisabled();
    // The pressed button reached the end: focus moved to its partner instead of being lost.
    await waitFor(() => expect(previous).toHaveFocus());

    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(dialog).toHaveTextContent('나');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(dialog).toHaveTextContent('다');
    // At the end Alt+↓ does nothing.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(dialog).toHaveTextContent('다');
  });
});
