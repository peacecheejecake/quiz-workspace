'use client';

import { Dialog } from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cx } from '../internal/cx';
import { LayerProvider } from '../internal/layer';
import { ScrollRegion } from '../internal/scroll-region';
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
  /** Whether clicking the backdrop closes the dialog. */
  closeOnBackdropClick?: boolean;
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
  size = 'md',
  onOpenAutoFocus,
  onCloseAutoFocus,
  className,
  children,
}: ModalDialogProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="qz-backdrop" data-layer="modal" />
        <Dialog.Content
          data-size={size}
          className={cx('qz-modal', className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onPointerDownOutside={(event) => {
            if (!closeOnBackdropClick) event.preventDefault();
          }}
        >
          <LayerProvider value="var(--z-modal)">
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
          </LayerProvider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the enclosing `ModalDialog`/`FloatingSidePanel` (wrap a footer button with it). */
export const DialogClose = Dialog.Close;
