'use client';

import { Toast as RadixToast } from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '../primitives/icons';

export type ToastTone = 'neutral' | 'success' | 'error';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; Radix pauses the timer on hover/focus. */
  duration?: number;
  /** Optional action; `altText` describes how to reach it without the toast (Radix requirement). */
  action?: { label: string; altText: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
  open: boolean;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const EXIT_MS = 400;

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children?: ReactNode;
  /** Accessible name of the notification region (the F8 hotkey hint is appended). */
  label?: string;
  /** Accessible name of each toast's close button. */
  closeLabel?: string;
  duration?: number;
}

/**
 * Provides `useToast()` and renders the toast viewport (z-index `--z-toast`). Toasts are
 * announced politely by Radix, can be swiped/Escape-dismissed and are reachable with F8.
 * Never put share tokens or other secrets in toast text other than the explicit copy success.
 */
export function ToastProvider({
  children,
  label = '알림',
  closeLabel = '닫기',
  duration = 5000,
}: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    setItems((current) => [...current, { ...options, id, open: true }]);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.map((t) => (t.id === id ? { ...t, open: false } : t)));
    // Keep the closed item mounted long enough for the exit animation, then drop it.
    setTimeout(() => setItems((current) => current.filter((t) => t.id !== id)), EXIT_MS);
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider label={label} duration={duration}>
        {children}
        {items.map((item) => (
          <RadixToast.Root
            key={item.id}
            open={item.open}
            duration={item.duration}
            type={item.tone === 'error' ? 'foreground' : 'background'}
            data-tone={item.tone ?? 'neutral'}
            className="qz-toast glass-surface"
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
          >
            <div className="body">
              <RadixToast.Title className="title">{item.title}</RadixToast.Title>
              {item.description ? (
                <RadixToast.Description className="description">
                  {item.description}
                </RadixToast.Description>
              ) : null}
            </div>
            {item.action ? (
              <RadixToast.Action
                altText={item.action.altText}
                className="qz-button qz-focus-ring"
                data-variant="secondary"
                data-size="sm"
                onClick={item.action.onClick}
              >
                {item.action.label}
              </RadixToast.Action>
            ) : null}
            <RadixToast.Close asChild>
              <IconButton label={closeLabel} icon={<CloseIcon />} size="sm" />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport label={`${label} ({hotkey})`} className="qz-toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>.');
  return value;
}
