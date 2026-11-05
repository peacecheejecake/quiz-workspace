'use client';

import { Dialog } from 'radix-ui';
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useAnimatedHeight } from '../internal/animated-height';
import { useBackdropClose } from '../internal/backdrop';
import { cx } from '../internal/cx';
import { DirtyProvider, useDirtyRegistry } from '../internal/dirty';
import { LayerProvider, useFloatingLayer } from '../internal/layer';
import { useModalStackEntry } from '../internal/modal-stack';
import { useMergedRefs } from '../internal/merge-refs';
import { useOverscrollGuard } from '../internal/overscroll-guard';
import { handlesOwnEscape } from '../internal/own-escape';
import { currentOpener, watchOpeners } from '../internal/opener';
import { ScrollRegion } from '../internal/scroll-region';
import { useSwipeDismiss } from '../internal/swipe-dismiss';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '../primitives/icons';

type ContentProps = ComponentProps<typeof Dialog.Content>;

export interface ModalDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  /** Action row (e.g. cancel + confirm buttons). */
  footer?: ReactNode;
  /** Accessible name of the close button; pass `null` to omit it (e.g. forced choices). */
  closeLabel?: string | null;
  /**
   * Whether clicking the backdrop closes the dialog (like Escape). The click never reaches the
   * content underneath either way (design-system §5.5).
   */
  closeOnBackdropClick?: boolean;
  /**
   * The dialog holds unsaved input (e.g. a changed question form): a backdrop click leaves it
   * open. Parts inside can report the same through `useUnsavedChanges`.
   */
  dirty?: boolean;
  size?: 'sm' | 'md';
  onOpenAutoFocus?: ContentProps['onOpenAutoFocus'];
  onCloseAutoFocus?: ContentProps['onCloseAutoFocus'];
  /**
   * Element the dialog is portalled into (default: `document.body`). A dialog stacked with other
   * modal panels of a page passes their container (the workspace home's dialogs live in <main>),
   * so the one opened later never hides the earlier ones' container from assistive technology.
   */
  container?: HTMLElement | null;
  className?: string;
  children?: ReactNode;
}

/**
 * Centered modal dialog on Radix Dialog: focus trap, Escape, focus return. It stacks with the
 * floating panels in opening order (internal/layer.tsx; UX9, HOMEDLG-01).
 */
export function ModalDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  footer,
  closeLabel = '닫기',
  closeOnBackdropClick = true,
  dirty = false,
  size = 'md',
  onOpenAutoFocus,
  onCloseAutoFocus,
  container,
  className,
  children,
}: ModalDialogProps) {
  const animateHeight = useAnimatedHeight<HTMLDivElement>();
  // Radix's modal scroll lock covers this too; the guard keeps every overlay alike (UX9-SCROLL).
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(watchOpeners, []);
  const guardedRef = useMergedRefs(animateHeight, guardOverscroll);
  const surfaceRef = useMergedRefs(guardedRef, contentRef);
  // Uncontrolled dialogs too must close from the backdrop, so the open state is mirrored here.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const changeOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const registry = useDirtyRegistry();
  useModalStackEntry(isOpen, () => changeOpen(false));
  // One stacking order with the panels (UX9, HOMEDLG-01): the layer opened later is on top,
  // whether a centered dialog or a side panel.
  const layer = useFloatingLayer(isOpen, undefined, false, true);
  const swipe = useSwipeDismiss(contentRef, layer.rank, true, 'bottom', () => changeOpen(false));
  const backdrop = useBackdropClose(closeOnBackdropClick && !dirty && !registry.dirty, () =>
    changeOpen(false),
  );
  return (
    <Dialog.Root open={isOpen} onOpenChange={changeOpen}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal container={container}>
        <Dialog.Overlay
          className="qz-backdrop"
          data-layer="modal"
          style={{ zIndex: layer.zIndex }}
          {...backdrop}
        />
        <Dialog.Content
          ref={surfaceRef}
          // Radix hides the background from assistive technology but does not set aria-modal.
          aria-modal="true"
          data-size={size}
          data-layer-rank={layer.rank}
          style={{ zIndex: layer.zIndex }}
          className={cx('qz-modal', className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(event) => {
            returnFocusRef.current = currentOpener();
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          onPointerDownOutside={(event) => {
            // The backdrop's click closes it instead (useBackdropClose).
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // An inline edit (ownEscapeProps) cancels itself; the next Escape closes the dialog.
            if (handlesOwnEscape(event)) event.preventDefault();
          }}
        >
          <LayerProvider value={layer.zIndex}>
            <DirtyProvider value={registry.report}>
              <div className="header" onPointerDown={swipe}>
                <div className="heading">
                  <Dialog.Title className="title">{title}</Dialog.Title>
                  {description ? (
                    <Dialog.Description className="description">{description}</Dialog.Description>
                  ) : null}
                </div>
                {closeLabel ? (
                  <Dialog.Close asChild>
                    <IconButton label={closeLabel} icon={<CloseIcon />} />
                  </Dialog.Close>
                ) : null}
              </div>
              <ScrollRegion className="body">{children}</ScrollRegion>
              {footer ? <div className="footer">{footer}</div> : null}
            </DirtyProvider>
          </LayerProvider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the enclosing `ModalDialog`/`FloatingSidePanel` (wrap a footer button with it). */
export const DialogClose = Dialog.Close;
