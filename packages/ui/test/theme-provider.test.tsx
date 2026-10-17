import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../src';

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      {resolvedTheme}
    </button>
  );
}

describe('ThemeProvider', () => {
  it('sets data-theme on <html> and switches it via setTheme', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const html = document.documentElement;
    expect(html).toHaveAttribute('data-theme', 'light');
    await userEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(html).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByRole('button')).toHaveTextContent('dark');
  });

  it('follows a controlled theme and restores the previous attribute on unmount', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { rerender, unmount } = render(<ThemeProvider theme="dark" />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    rerender(<ThemeProvider theme="light" />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    unmount();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('reports changes to the owner in controlled mode', async () => {
    const onThemeChange = vi.fn();
    render(
      <ThemeProvider theme="light" onThemeChange={onThemeChange}>
        <ThemeToggle />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onThemeChange).toHaveBeenCalledWith('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('scopes the theme to a wrapper element when scope="element"', () => {
    render(
      <ThemeProvider theme="dark" scope="element">
        <span>미리보기</span>
      </ThemeProvider>,
    );
    expect(screen.getByText('미리보기').parentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('resolves "system" from prefers-color-scheme and tracks changes', () => {
    let listener: (() => void) | undefined;
    const media = {
      matches: true,
      addEventListener: (_: string, cb: () => void) => (listener = cb),
      removeEventListener: () => undefined,
    };
    vi.spyOn(window, 'matchMedia').mockImplementation(() => media as unknown as MediaQueryList);
    render(<ThemeProvider theme="system" />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    media.matches = false;
    act(() => listener?.());
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('useTheme throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<ThemeToggle />)).toThrow(/ThemeProvider/);
  });
});
