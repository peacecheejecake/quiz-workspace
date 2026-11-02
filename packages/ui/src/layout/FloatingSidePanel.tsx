'use client';

import { Dialog } from 'radix-ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { useAnimatedHeight } from '../internal/animated-height';
import { cx } from '../internal/cx';
import { LayerProvider, useFloatingLayer } from '../internal/layer';
import { handlesOwnEscape } from '../internal/own-escape';
import { ScrollRegion } from '../internal/scroll-region';
import { handOffFocus } from '../internal/tabbable';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '../primitives/icons';

type ContentProps = ComponentProps<typeof Dialog.Content>;

/** Escape presses a non-modal panel declined because focus was outside it (see onKeyDown). */
const declinedEscapes = new WeakSet<Event>();

/** The element outside the panel that controls it (`aria-controls` lists the panel id). */
function controllerOf(id: string | undefined): HTMLElement | null {
  if (!id || typeof document === 'undefined') return null;
  for (const el of document.querySelectorAll<HTMLElement>('[aria-controls]')) {
    if (el.getAttribute('aria-controls')?.split(/\s+/).includes(id)) return el;
  }
  return null;
}

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
  /**
   * The title heading. Passing it makes the heading programmatically focusable (`tabIndex=-1`),
   * for panels that move focus to their title when their content changes (QuestionViewer
   * `sequence`: each new question).
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /** Header slot between the title and the close button (e.g. favorite / retry toggles). */
  headerActions?: ReactNode;
  /** Footer slot (submit, self-grade, next/previous, loading/error status). */
  footer?: ReactNode;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Modal only: whether clicking the backdrop closes the panel. */
  closeOnBackdropClick?: boolean;
  /**
   * `default` = min(500px, 100vw - 32px); `wide` for comparison drawers (≥ 600px); `narrow`
   * (`--outline-panel-width`) for navigation columns. Viewport placement only: a docked panel is
   * always the narrow width.
   */
  size?: 'default' | 'wide' | 'narrow';
  /** Edge the panel sits at: `end` (default, right in LTR) or `start` (left). */
  side?: 'end' | 'start';
  /**
   * `viewport` (default): fixed to the viewport with 16px margins.
   * `docked` (DOCVIEW-01 목차 panel): a non-modal panel (`modal` is ignored) absolutely positioned
   * at the top `side` corner of `container`, full container height, `--outline-panel-width` wide.
   * `container` must be a positioned element (e.g. `position: relative`) wrapping the content
   * next to the panel; without a container the docked panel is not rendered. When it mounts
   * already open (a restored state) it does not move focus; only a later open does.
   */
  placement?: 'viewport' | 'docked';
  /**
   * Docked only. `inset` (default, wide containers): while open, the container gets
   * `data-qz-dock-inset="<side>"`, which pads its `side` edge by the panel width so the content
   * steps aside instead of being covered. `overlay` (narrow containers): the panel floats over
   * the content.
   */
  dockMode?: 'inset' | 'overlay';
  /**
   * Id of the panel element. An outside toggle that is not a `trigger` points at it with
   * `aria-controls`; that toggle then receives focus when the panel closes with no opener to
   * return to (e.g. a docked panel restored open), and anchors Tab leaving a non-modal panel.
   * With a `trigger`, the trigger's `aria-controls` points at this id too.
   */
  id?: string;
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
 * Shared floating side panel (docs/design-system.md §5.1): glass surface with 16px viewport
 * margins, radius 20px, independent body scroll, header/footer slots; at the end (default) or
 * start edge, or docked to a container (v1.2.7). Built on Radix Dialog so focus management,
 * Escape and focus return follow the WAI-ARIA dialog pattern.
 */
export function FloatingSidePanel({
  open,
  defaultOpen,
  onOpenChange,
  modal: modalProp = true,
  trigger,
  title,
  description,
  titleRef,
  headerActions,
  footer,
  closeLabel = '닫기',
  closeOnBackdropClick = true,
  size = 'default',
  side = 'end',
  placement = 'viewport',
  dockMode = 'inset',
  id,
  mobileLayout = 'sheet',
  container,
  onOpenAutoFocus,
  onCloseAutoFocus,
  raiseKey,
  staysExposedUnderModal = false,
  className,
  children,
}: FloatingSidePanelProps) {
  const docked = placement === 'docked';
  const modal = docked ? false : modalProp;
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
  // A docked panel mounted open restores a saved state: its first auto-focus is skipped.
  const skipFirstAutoFocusRef = useRef(docked && isOpen);
  const handleOpenChange = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const layer = useFloatingLayer(isOpen, raiseKey);

  // Inset docking: the container pads the panel's edge so its content steps aside.
  const insetHost = docked && dockMode === 'inset' && isOpen ? container : null;
  useEffect(() => {
    if (!insetHost) return undefined;
    insetHost.setAttribute('data-qz-dock-inset', side);
    return () => insetHost.removeAttribute('data-qz-dock-inset');
  }, [insetHost, side]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange} modal={modal}>
      {trigger ? (
        // An explicit id replaces Radix's content id, so the trigger must point at it too.
        <Dialog.Trigger asChild {...(id ? { 'aria-controls': isOpen ? id : undefined } : {})}>
          {trigger}
        </Dialog.Trigger>
      ) : null}
      {docked && !container ? null : (
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
            data-size={docked ? 'narrow' : size}
            data-side={side}
            data-placement={placement}
            data-dock-mode={docked ? dockMode : undefined}
            data-mobile-layout={mobileLayout}
            // Only when given: an explicit undefined would replace Radix's own content id.
            {...(id ? { id } : {})}
            className={cx('qz-panel', 'glass-surface', className)}
            data-layer-rank={layer.rank}
            style={{ zIndex: layer.zIndex }}
            {...(description ? {} : { 'aria-describedby': undefined })}
            onOpenAutoFocus={(event) => {
              if (skipFirstAutoFocusRef.current) {
                skipFirstAutoFocusRef.current = false;
                returnFocusRef.current = null;
                event.preventDefault();
                return;
              }
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
              const target = returnFocusRef.current?.isConnected
                ? returnFocusRef.current
                : controllerOf(id);
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
                handOffFocus(event, contentRef.current, returnFocusRef.current ?? controllerOf(id));
              }
              // Radix lets only the layer it ranks highest handle Escape. When that is a non-modal
              // panel without focus, its guard below declined, so the panel holding focus closes
              // itself: another non-modal panel raised over it, or a modal panel opened on top
              // whose layer Radix had not ranked highest yet (CHNOTE-01-AC02: the practice panel
              // opened from a 정리 노트 footnote ignored Escape while the note panel held the rank).
              if (
                event.key === 'Escape' &&
                declinedEscapes.has(event.nativeEvent) &&
                !handlesOwnEscape(event.nativeEvent)
              ) {
                handleOpenChange(false);
              }
            }}
            onEscapeKeyDown={(event) => {
              // An inline edit (ownEscapeProps) cancels itself; the next Escape closes the panel.
              if (handlesOwnEscape(event)) {
                event.preventDefault();
                return;
              }
              if (!modal && !contentRef.current?.contains(document.activeElement)) {
                event.preventDefault();
                declinedEscapes.add(event);
              }
            }}
          >
            <LayerProvider value={layer.zIndex}>
              <div className="header">
                <div className="heading">
                  <Dialog.Title
                    ref={titleRef}
                    tabIndex={titleRef ? -1 : undefined}
                    className="title"
                  >
                    {title}
                  </Dialog.Title>
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
      )}
    </Dialog.Root>
  );
}
