'use client';

import { Toast as RadixToast } from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { closeTopModal } from '../internal/modal-stack';
import { handlesOwnEscape } from '../internal/own-escape';
import { IconButton } from '../primitives/IconButton';
import { AlertIcon, CheckIcon, CloseIcon } from '../primitives/icons';

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
  /** Hidden word read before a success / error toast's title (the icon is decorative). */
  toneLabels?: Readonly<Record<'success' | 'error', string>>;
}

const TONE_LABELS = { success: '성공', error: '오류' } as const;

/**
 * Provides `useToast()` and renders the toast viewport (z-index `--z-toast`). Toasts are
 * announced politely by Radix, can be swiped/Escape-dismissed and are reachable with F8.
 * Never put share tokens or other secrets in toast text other than the explicit copy success.
 * The tone is shown by a leading icon plus a hidden word (UX7: no coloured left bar), never by
 * colour alone.
 */
export function ToastProvider({
  children,
  label = '알림',
  closeLabel = '닫기',
  duration = 5000,
  toneLabels = TONE_LABELS,
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
  const viewportRef = useRef<HTMLOListElement>(null);
  useToastsReachableFromModals(viewportRef);

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
            onEscapeKeyDown={(event) => {
              // While a modal is open Escape closes its top dialog, never the toast (user decision
              // 2026-11-02): the toast closes by its own button or timeout then. An inline edit
              // (ownEscapeProps) keeps its own Escape.
              if (handlesOwnEscape(event)) {
                event.preventDefault();
                return;
              }
              if (closeTopModal()) event.preventDefault();
            }}
          >
            {item.tone === 'success' || item.tone === 'error' ? (
              <span className="tone-icon" aria-hidden="true">
                {item.tone === 'success' ? <CheckIcon /> : <AlertIcon />}
              </span>
            ) : null}
            <div className="body">
              {item.tone === 'success' || item.tone === 'error' ? (
                <span className="qz-visually-hidden">{`${toneLabels[item.tone]}: `}</span>
              ) : null}
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
                data-toast-action=""
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
        {/* A modal panel hides the rest of the page from assistive technology but keeps live
            regions (aria-hidden `hideOthers`): `off` keeps the notifications (and their F8
            landmark) reachable while a modal is open without adding announcements — each toast
            announces itself. */}
        <RadixToast.Viewport
          ref={viewportRef}
          label={`${label} ({hotkey})`}
          className="qz-toast-viewport"
          aria-live="off"
        />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

/**
 * F8 (and Tab from the region) must reach the notifications while a modal dialog or panel is open
 * (HILITE-01 `되돌리기`): a modal's focus trap pulls any focus that leaves it back in. Focus moving
 * into the notification region is therefore not reported to the page above the region (the trap
 * listens on the document); everything inside the region keeps its own handling. From the region
 * itself (F8), Tab goes to the newest toast's action when it has one, else to the toast.
 */
function useToastsReachableFromModals(viewportRef: { readonly current: HTMLOListElement | null }) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const doc = viewport.ownerDocument;
    const inRegion = (node: EventTarget | null) => node instanceof Node && viewport.contains(node);
    const onFocusOut = (event: FocusEvent) => {
      if (inRegion(event.relatedTarget)) event.stopPropagation();
    };
    const onFocusIn = (event: FocusEvent) => {
      event.stopPropagation();
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.matches('.qz-toast') &&
        event.relatedTarget === viewport
      ) {
        target.querySelector<HTMLElement>('[data-toast-action]')?.focus();
      }
    };
    doc.addEventListener('focusout', onFocusOut, true);
    viewport.addEventListener('focusin', onFocusIn);
    return () => {
      doc.removeEventListener('focusout', onFocusOut, true);
      viewport.removeEventListener('focusin', onFocusIn);
    };
  }, [viewportRef]);
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>.');
  return value;
}
