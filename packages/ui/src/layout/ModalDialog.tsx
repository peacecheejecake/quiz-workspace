'use client';

import { Dialog } from 'radix-ui';
import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { useAnimatedHeight } from '../internal/animated-height';
import { useBackdropClose } from '../internal/backdrop';
import { cx } from '../internal/cx';
import { DirtyProvider, useDirtyRegistry } from '../internal/dirty';
import { LayerProvider } from '../internal/layer';
import { useMergedRefs } from '../internal/merge-refs';
import { useOverscrollGuard } from '../internal/overscroll-guard';
import { handlesOwnEscape } from '../internal/own-escape';
import { ScrollRegion } from '../internal/scroll-region';
import { useScrollFreeze } from '../internal/scroll-freeze';
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
  className?: string;
  children?: ReactNode;
}

/** Centered modal dialog (z-index `--z-modal`) on Radix Dialog: focus trap, Escape, focus return. */
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
  className,
  children,
}: ModalDialogProps) {
  const animateHeight = useAnimatedHeight<HTMLDivElement>();
  // Radix's modal scroll lock covers this too; the guard keeps every overlay alike (UX9-SCROLL).
  const guardOverscroll = useOverscrollGuard<HTMLDivElement>();
  const surfaceRef = useMergedRefs(animateHeight, guardOverscroll);
  // Uncontrolled dialogs too must close from the backdrop, so the open state is mirrored here.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const changeOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const registry = useDirtyRegistry();
  useScrollFreeze(isOpen);
  const backdrop = useBackdropClose(closeOnBackdropClick && !dirty && !registry.dirty, () =>
    changeOpen(false),
  );
  return (
    <Dialog.Root open={isOpen} onOpenChange={changeOpen}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="qz-backdrop" data-layer="modal" {...backdrop} />
        <Dialog.Content
          ref={surfaceRef}
          // Radix hides the background from assistive technology but does not set aria-modal.
          aria-modal="true"
          data-size={size}
          className={cx('qz-modal', className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onPointerDownOutside={(event) => {
            // The backdrop's click closes it instead (useBackdropClose).
            event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // An inline edit (ownEscapeProps) cancels itself; the next Escape closes the dialog.
            if (handlesOwnEscape(event)) event.preventDefault();
          }}
        >
          <LayerProvider value="var(--z-modal)">
            <DirtyProvider value={registry.report}>
              <div className="header">
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
