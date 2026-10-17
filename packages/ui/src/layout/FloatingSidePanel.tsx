'use client';

import { Dialog } from 'radix-ui';
import { useRef, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cx } from '../internal/cx';
import { LayerProvider } from '../internal/layer';
import { handOffFocus } from '../internal/tabbable';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '../primitives/icons';

type ContentProps = ComponentProps<typeof Dialog.Content>;

export interface FloatingSidePanelProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * `true` (default, e.g. QuestionPracticePanel): backdrop, focus trap, background hidden from
   * assistive technology, Escape closes, focus returns to the trigger.
   * `false` (e.g. DocumentExcerptPanel): no backdrop or trap; the background stays interactive
   * and clicking/focusing it keeps the panel open. Escape closes only while focus is inside.
   */
  modal?: boolean;
  /** Optional element that toggles the panel (Radix `Dialog.Trigger`, rendered `asChild`). */
  trigger?: ReactElement;
  /** Panel title (required: names the dialog). */
  title: ReactNode;
  /** Optional description; linked via `aria-describedby`. */
  description?: ReactNode;
  /** Header slot between the title and the close button (e.g. favorite / retry toggles). */
  headerActions?: ReactNode;
  /** Footer slot (submit, self-grade, next/previous, loading/error status). */
  footer?: ReactNode;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Modal only: whether clicking the backdrop closes the panel. */
  closeOnBackdropClick?: boolean;
  /** `default` = min(500px, 100vw - 32px); `wide` for comparison drawers (≥ 600px). */
  size?: 'default' | 'wide';
  /** Below the mobile breakpoint: bottom sheet (max 90dvh) or full-height panel. */
  mobileLayout?: 'sheet' | 'full';
  /** Defaults to focusing the panel itself so its title is announced first. */
  onOpenAutoFocus?: ContentProps['onOpenAutoFocus'];
  onCloseAutoFocus?: ContentProps['onCloseAutoFocus'];
  className?: string;
  children?: ReactNode;
}

/**
 * Shared right-side floating panel (docs/design-system.md §5.1): glass surface with 16px
 * viewport margins, radius 20px, independent body scroll, header/footer slots. Built on Radix
 * Dialog so focus management, Escape and focus return follow the WAI-ARIA dialog pattern.
 */
export function FloatingSidePanel({
  open,
  defaultOpen,
  onOpenChange,
  modal = true,
  trigger,
  title,
  description,
  headerActions,
  footer,
  closeLabel = '닫기',
  closeOnBackdropClick = true,
  size = 'default',
  mobileLayout = 'sheet',
  onOpenAutoFocus,
  onCloseAutoFocus,
  className,
  children,
}: FloatingSidePanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Element focused when the panel opened. Panels are often opened from controls that are not
  // a Radix trigger (heatmap dots, search results); focus must still return there on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} modal={modal}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        {modal ? <Dialog.Overlay className="qz-backdrop" data-layer="panel" /> : null}
        <Dialog.Content
          ref={contentRef}
          data-modal={modal}
          data-size={size}
          data-mobile-layout={mobileLayout}
          className={cx('qz-panel', 'glass-surface', className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(event) => {
            returnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            onOpenAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            const active = document.activeElement;
            const focusLost =
              !active || active === document.body || contentRef.current?.contains(active);
            if (target?.isConnected && focusLost) {
              event.preventDefault();
              target.focus();
            }
          }}
          onPointerDownOutside={(event) => {
            if (modal && !closeOnBackdropClick) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            // Non-modal panels sit next to the content they annotate (PDF, search results):
            // working in the background must not dismiss them.
            if (!modal) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (!modal && contentRef.current) {
              handOffFocus(event, contentRef.current, returnFocusRef.current);
            }
          }}
          onEscapeKeyDown={(event) => {
            if (!modal && !contentRef.current?.contains(document.activeElement)) {
              event.preventDefault();
            }
          }}
        >
          <LayerProvider value="var(--z-side-panel)">
            <header className="qz-panel__header">
              <div className="qz-panel__heading">
                <Dialog.Title className="qz-panel__title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="qz-panel__description">
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
              {headerActions ? <div className="qz-panel__actions">{headerActions}</div> : null}
              <Dialog.Close asChild>
                <IconButton label={closeLabel} icon={<CloseIcon />} />
              </Dialog.Close>
            </header>
            <div className="qz-panel__body">{children}</div>
            {footer ? <footer className="qz-panel__footer">{footer}</footer> : null}
          </LayerProvider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
