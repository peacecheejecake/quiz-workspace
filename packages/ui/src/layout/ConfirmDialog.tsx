'use client';

import { AlertDialog } from 'radix-ui';
import type { ReactNode, RefObject } from 'react';
import { cx } from '../internal/cx';
import { LayerProvider } from '../internal/layer';
import { Button } from '../primitives/Button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** What happens and whether it can be undone. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Called on confirm. The dialog stays open (busy confirm button) until the caller closes it. */
  onConfirm: () => void;
  loading?: boolean;
  /**
   * Element to focus when the dialog closes. Needed when it was opened without a trigger (e.g.
   * from a menu item, whose menu is gone by then); defaults to Radix's own focus return.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * Confirmation for destructive actions on Radix AlertDialog (role="alertdialog"): focus starts on
 * the cancel button, Escape cancels, the backdrop does not dismiss and focus returns on close.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = '취소',
  onConfirm,
  loading = false,
  returnFocusRef,
  className,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!loading) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="qz-backdrop" data-layer="modal" />
        <AlertDialog.Content
          data-size="sm"
          className={cx('qz-modal', className)}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <LayerProvider value="var(--z-modal)">
            <div className="qz-modal__header">
              <div className="qz-panel__heading">
                <AlertDialog.Title className="qz-modal__title">{title}</AlertDialog.Title>
                <AlertDialog.Description className="qz-panel__description">
                  {description}
                </AlertDialog.Description>
              </div>
            </div>
            <div className="qz-modal__footer">
              <AlertDialog.Cancel asChild>
                <Button disabled={loading}>{cancelLabel}</Button>
              </AlertDialog.Cancel>
              <Button variant="primary" loading={loading} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </LayerProvider>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
