'use client';

import type { ThemeName } from '@quiz/design-tokens';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePreference = ThemeName | 'system';

export interface ThemeContextValue {
  /** What the user picked; `system` follows `prefers-color-scheme`. */
  theme: ThemePreference;
  /** The theme actually applied (`data-theme` value). */
  resolvedTheme: ThemeName;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export interface ThemeProviderProps {
  children?: ReactNode;
  /** Controlled theme. Omit to let the provider own the state (starting at `defaultTheme`). */
  theme?: ThemePreference;
  defaultTheme?: ThemePreference;
  onThemeChange?: (theme: ThemePreference) => void;
  /**
   * Where `data-theme` is written. `document` (default) sets it on `<html>` so portalled
   * layers (panels, toasts, tooltips) inherit the theme; `element` renders a wrapper `div`
   * carrying `data-theme`, for side-by-side previews.
   */
  scope?: 'document' | 'element';
}

/**
 * Applies the light/dark token set through `data-theme` (tokens.css switches on
 * `[data-theme='dark']`) and exposes the current theme via `useTheme()`.
 */
export function ThemeProvider({
  children,
  theme: controlledTheme,
  defaultTheme = 'light',
  onThemeChange,
  scope = 'document',
}: ThemeProviderProps) {
  const [uncontrolledTheme, setUncontrolledTheme] = useState<ThemePreference>(defaultTheme);
  const theme = controlledTheme ?? uncontrolledTheme;
  const [system, setSystem] = useState<ThemeName>(systemTheme);

  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    const update = () => setSystem(media.matches ? 'dark' : 'light');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  const resolvedTheme: ThemeName = theme === 'system' ? system : theme;

  useEffect(() => {
    if (scope !== 'document') return;
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', resolvedTheme);
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, [scope, resolvedTheme]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      if (controlledTheme === undefined) setUncontrolledTheme(next);
      onThemeChange?.(next);
    },
    [controlledTheme, onThemeChange],
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {scope === 'element' ? (
        <div data-theme={resolvedTheme} className="qz-theme-scope">
          {children}
        </div>
      ) : (
        children
      )}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}
