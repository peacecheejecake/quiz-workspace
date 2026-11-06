import { render, type RenderOptions } from '@testing-library/react';
import { ToastProvider } from '@quiz/ui';
import type { ReactElement } from 'react';

/** `render` under the app shell's toast provider: the highlight tool of an explanation toasts. */
export function renderWithToasts(ui: ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: ToastProvider, ...options });
}
