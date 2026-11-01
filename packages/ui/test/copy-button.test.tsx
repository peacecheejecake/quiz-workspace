import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COPY_FEEDBACK_MS, CopyButton } from '../src';
import { axeViolations } from './axe';

// UX7-SHARE-EXPIRY (docs/design-system.md CopyButton, WS-SHARE-01-AC08).
describe('CopyButton', () => {
  it('reverts after about two seconds by default', () => {
    expect(COPY_FEEDBACK_MS).toBe(2000);
  });

  it('swaps to a check and "복사 완료" after a successful copy, announces once, then reverts', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn(async () => true);
    render(
      <CopyButton
        label="링크 복사"
        announcement="링크를 복사했습니다."
        feedbackMs={50}
        onCopy={onCopy}
      />,
    );
    const button = screen.getByRole('button', { name: '링크 복사' });
    expect(button.querySelector('[data-icon="copy"]')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.click(button);
    expect(onCopy).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: '복사 완료' })).toBe(button);
    expect(button.querySelector('[data-icon="check"]')).toBeVisible();
    expect(button.querySelector('[data-icon="copy"]')).not.toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('링크를 복사했습니다.');
    // The live region is outside the button, so the name stays the visible label only.
    expect(button).not.toContainElement(screen.getByRole('status'));

    expect(await screen.findByRole('button', { name: '링크 복사' })).toBe(button);
    expect(button.querySelector('[data-icon="copy"]')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('keeps both labels in the layout so the size never changes', () => {
    render(<CopyButton label="링크 복사" announcement="복사했습니다" onCopy={async () => true} />);
    const button = screen.getByRole('button', { name: '링크 복사' });
    // Both label slots are rendered; the inactive one is hidden with visibility, not display.
    const slots = button.querySelectorAll('[data-slot="label"]');
    expect(slots).toHaveLength(2);
    expect([...slots].map((s) => s.textContent)).toEqual(['링크 복사', '복사 완료']);
  });

  it.each([
    ['rejects', async () => Promise.reject(new Error('denied'))],
    ['resolves false', async () => false],
  ])('shows no check when the copy %s', async (_how, onCopy) => {
    const user = userEvent.setup();
    render(<CopyButton label="링크 복사" announcement="복사했습니다" onCopy={onCopy} />);
    const button = screen.getByRole('button', { name: '링크 복사' });
    await act(async () => {
      await user.click(button);
    });
    expect(button).toHaveAccessibleName('링크 복사');
    expect(button.querySelector('[data-icon="check"]')).not.toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('has no axe violations', async () => {
    render(<CopyButton label="링크 복사" announcement="복사했습니다" onCopy={async () => true} />);
    expect(await axeViolations()).toEqual([]);
  });
});
