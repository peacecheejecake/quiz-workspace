'use client';

import { Dialog } from 'radix-ui';
import {
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useAnimatedHeight } from '../internal/animated-height';
import { cx } from '../internal/cx';
import { LayerProvider, useFloatingLayer } from '../internal/layer';
import { ScrollRegion } from '../internal/scroll-region';
import { handOffFocus } from '../internal/tabbable';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '../primitives/icons';

type ContentProps = ComponentProps<typeof Dialog.Content>;

/** Escape presses a non-modal panel declined because focus was outside it (see onKeyDown). */
const declinedEscapes = new WeakSet<Event>();

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
  /**
   * Element the panel is portalled into (default: `document.body`). A page whose whole content
   * is the panel (e.g. a settings route) passes its `<main>` so the panel stays in that landmark.
   */
  container?: HTMLElement | null;
  /** Defaults to focusing the panel itself so its title is announced first. */
  onOpenAutoFocus?: ContentProps['onOpenAutoFocus'];
  onCloseAutoFocus?: ContentProps['onCloseAutoFocus'];
  /**
   * Changing this while the panel is open brings it to the top of the open floating layers again
   * (e.g. the button that opened it was pressed while another panel covered it).
   */
  raiseKey?: string | number;
  /**
   * Non-modal only: stays in the accessibility tree while a modal panel is open on top (a modal
   * hides everything else from assistive technology, but keeps `aria-live` regions; `off` adds no
   * announcements). For a panel whose state the modal changes, e.g. the 정리 노트 panel that
   * folds when the practice panel opens (CHNOTE-01).
   */
  staysExposedUnderModal?: boolean;
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
  container,
  onOpenAutoFocus,
  onCloseAutoFocus,
  raiseKey,
  staysExposedUnderModal = false,
  className,
  children,
}: FloatingSidePanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const animateHeight = useAnimatedHeight<HTMLDivElement>();
  // Stable, so the height observer is set up once per mounted panel (not on every render).
  const setContent = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      const cleanup = animateHeight(node);
      // A returned cleanup replaces React's call with null, so clear the ref here too.
      return () => {
        cleanup?.();
        contentRef.current = null;
      };
    },
    [animateHeight],
  );
  // Element focused when the panel opened. Panels are often opened from controls that are not
  // a Radix trigger (heatmap dots, search results); focus must still return there on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Track the open state even when uncontrolled so the panel can take its stacking rank: the
  // most recently opened floating layer is on top (internal/layer.tsx).
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const layer = useFloatingLayer(isOpen, raiseKey);

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange} modal={modal}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal container={container}>
        {modal ? (
          <Dialog.Overlay
            className="qz-backdrop"
            data-layer="panel"
            style={{ zIndex: layer.zIndex }}
          />
        ) : null}
        <Dialog.Content
          ref={setContent}
          // Radix hides the background from assistive technology but does not set aria-modal.
          aria-modal={modal || undefined}
          aria-live={!modal && staysExposedUnderModal ? 'off' : undefined}
          data-modal={modal}
          data-size={size}
          data-mobile-layout={mobileLayout}
          className={cx('qz-panel', 'glass-surface', className)}
          data-layer-rank={layer.rank}
          style={{ zIndex: layer.zIndex }}
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
            // Radix lets only the most recently mounted non-modal panel handle Escape; when focus
            // is in another one (e.g. raised over it), that panel's guard below declined, so the
            // panel holding focus closes itself.
            if (event.key === 'Escape' && !modal && declinedEscapes.has(event.nativeEvent)) {
              handleOpenChange(false);
            }
          }}
          onEscapeKeyDown={(event) => {
            if (!modal && !contentRef.current?.contains(document.activeElement)) {
              event.preventDefault();
              declinedEscapes.add(event);
            }
          }}
        >
          <LayerProvider value={layer.zIndex}>
            <div className="header">
              <div className="heading">
                <Dialog.Title className="title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="description">{description}</Dialog.Description>
                ) : null}
              </div>
              {headerActions ? <div className="actions">{headerActions}</div> : null}
              <Dialog.Close asChild>
                <IconButton label={closeLabel} icon={<CloseIcon />} />
              </Dialog.Close>
            </div>
            <ScrollRegion className="body">{children}</ScrollRegion>
            {footer ? <div className="footer">{footer}</div> : null}
          </LayerProvider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
