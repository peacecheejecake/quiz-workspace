'use client';

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { isTopFloatingLayer } from './layer';

export type DragEdge = 'left' | 'right' | 'top' | 'bottom';

const GESTURE = {
  slop: 8,
  distance: 64,
  flickDistance: 24,
  flickSpeed: 0.5,
  axisRatio: 1.5,
  /** Release velocity is measured over this last stretch of the drag (ms). */
  velocityWindow: 100,
  /** A release is projected this far ahead (ms); past half the surface it dismisses. */
  projection: 200,
  /** Moving back faster than this (px/ms) at release keeps the surface open. */
  reversal: -0.25,
} as const;

const MOTION = {
  /** The farthest a surface moves against its dismiss direction (px). */
  rubberBand: 24,
  exitMin: 120,
  exitMax: 280,
  /** Speed of an exit released with little velocity (px/ms). */
  exitSpeed: 1,
  /** Beyond the viewport edge, so the shadow leaves too (px). */
  exitMargin: 32,
  spring: 240,
  /** How long a close that writes the URL may take before it counts as refused (ms). */
  closeWait: 1000,
  /** A release `click` arrives within this (ms). */
  clickWindow: 400,
} as const;

const SHEET_BREAKPOINT = 768;
const INTERACTIVE = 'button,a,input,select,textarea,[contenteditable]';
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Distance along the dismiss direction: positive toward `edge`. */
function along(edge: DragEdge, dx: number, dy: number): number {
  return edge === 'right' ? dx : edge === 'left' ? -dx : edge === 'bottom' ? dy : -dy;
}

function across(edge: DragEdge, dx: number, dy: number): number {
  return Math.abs(edge === 'right' || edge === 'left' ? dy : dx);
}

export function qualifiesSwipe(edge: DragEdge, dx: number, dy: number, elapsed: number): boolean {
  const primary = along(edge, dx, dy);
  return (
    primary >= across(edge, dx, dy) * GESTURE.axisRatio &&
    (primary >= GESTURE.distance ||
      (primary >= GESTURE.flickDistance && primary / Math.max(elapsed, 1) >= GESTURE.flickSpeed))
  );
}

/** Whether a release at `velocity` (px/ms) carries past half of `size`, or the distance threshold. */
export function projectsDismiss(
  primary: number,
  cross: number,
  velocity: number,
  size: number,
): boolean {
  return (
    velocity > 0 &&
    primary >= cross * GESTURE.axisRatio &&
    primary + velocity * GESTURE.projection >= Math.max(size / 2, GESTURE.distance)
  );
}

/** The surface's offset for a finger at `primary`: 1:1 forward, a rubber band backward. */
export function dragOffset(primary: number): number {
  if (primary >= 0) return primary;
  const band = MOTION.rubberBand;
  return -band * (1 - 1 / (1 - primary / (2 * band)));
}

/** Duration and easing that continue a release at `velocity` over `distance` px. */
export function exitMotion(
  distance: number,
  velocity: number,
): { duration: number; easing: string } {
  const speed = Math.max(velocity, MOTION.exitSpeed);
  const duration = Math.min(Math.max((2 * distance) / speed, MOTION.exitMin), MOTION.exitMax);
  // The curve's starting slope is its P1: y1 / x1 = velocity in units of distance per duration.
  const x1 = 0.3;
  const y1 = Math.min(1, (x1 * Math.max(velocity, 0) * duration) / Math.max(distance, 1));
  return { duration, easing: `cubic-bezier(${x1}, ${y1.toFixed(3)}, 0.6, 1)` };
}

/** Dismiss direction of a side panel: the bottom-sheet layout goes down. */
export function panelEdges(side: 'start' | 'end', width: number): readonly DragEdge[] {
  if (width < SHEET_BREAKPOINT) return ['bottom'];
  return [side === 'end' ? 'right' : 'left'];
}

function translateFor(edge: DragEdge, offset: number): string {
  const signed = edge === 'right' || edge === 'bottom' ? offset : -offset;
  return edge === 'right' || edge === 'left' ? `${signed}px 0px` : `0px ${signed}px`;
}

function isClosed(element: HTMLElement): boolean {
  return !element.isConnected || element.getAttribute('data-state') === 'closed';
}

function offscreenDistance(element: HTMLElement, edge: DragEdge): number {
  const rect = element.getBoundingClientRect();
  const distance = {
    left: rect.right,
    right: window.innerWidth - rect.left,
    top: rect.bottom,
    bottom: window.innerHeight - rect.top,
  }[edge];
  return Math.max(distance, 0) + MOTION.exitMargin;
}

/** Swallows the click the browser sends after a drag that began on a control in `surface`. */
function swallowReleaseClick(surface: HTMLElement) {
  const stop = (event: MouseEvent) => {
    if (!(event.target instanceof Node) || !surface.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    remove();
  };
  const remove = () => {
    window.removeEventListener('click', stop, true);
    clearTimeout(timer);
  };
  window.addEventListener('click', stop, true);
  const timer = setTimeout(remove, MOTION.clickWindow);
}

interface Gesture {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly surface: HTMLElement;
  readonly edges: readonly DragEdge[];
  readonly reduced: boolean;
  /** Past the slop. */
  moved: boolean;
  /** Locked direction; null before the slop and for a drag across the dismiss axis. */
  edge: DragEdge | null;
  offset: number;
  samples: { time: number; primary: number }[];
}

function releaseVelocity(samples: Gesture['samples'], now: number): number {
  const recent = samples.filter((sample) => now - sample.time <= GESTURE.velocityWindow);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last.time - first.time < 1) return 0;
  return (last.primary - first.primary) / (last.time - first.time);
}

export interface DragDismissOptions {
  surface: RefObject<HTMLElement | null>;
  /** Dismiss directions, resolved when the gesture starts. With several, the drag picks one. */
  edges: readonly DragEdge[] | (() => readonly DragEdge[]);
  /** Runs when the surface has left the screen. Returning `false` refuses: it springs back. */
  close: () => void | false;
  /** Floating layer rank: only the top layer responds. Omit for a surface outside the layers. */
  rank?: number;
  enabled?: boolean;
  /**
   * `handle`: the element with the returned handler, minus the controls in it (D-2).
   * `any`: anywhere, controls included; the release click is then swallowed after a drag.
   */
  startFrom?: 'handle' | 'any';
}

/**
 * Drag-to-dismiss for floating surfaces (UX12-GESTURE): the surface follows a touch or pen through
 * the individual `translate` property, which composes with the `transform` of its layout and
 * keyframes. On release it leaves at the release velocity and `close` runs, or it springs back.
 * Window listeners, no `preventDefault`: the start element's `touch-action` keeps the browser from
 * taking the gesture. Returns the `onPointerDown` handler for the start element.
 */
export function useDragDismiss({
  surface,
  edges,
  close,
  rank,
  enabled = true,
  startFrom = 'handle',
}: DragDismissOptions) {
  const gesture = useRef<Gesture | null>(null);
  /** The surface is animating after a release: no new gesture until it ends. */
  const settling = useRef(false);
  const latest = useRef({ close, rank });
  latest.current = { close, rank };

  useEffect(() => {
    const isTop = () => {
      const current = latest.current.rank;
      return current === undefined || isTopFloatingLayer(current);
    };
    const reset = (element: HTMLElement) => {
      element.style.translate = '';
      element.removeAttribute('data-dragging');
      element.removeAttribute('data-swiped');
      settling.current = false;
    };
    const springBack = (element: HTMLElement, from: string) => {
      if (
        !from ||
        typeof element.animate !== 'function' ||
        !element.isConnected ||
        reducedMotion()
      ) {
        reset(element);
        return;
      }
      settling.current = true;
      element.removeAttribute('data-swiped');
      element.style.translate = '';
      const animation = element.animate(
        { translate: [from, '0px 0px'] },
        { duration: MOTION.spring, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.1)' },
      );
      animation.onfinish = () => reset(element);
      animation.oncancel = () => reset(element);
    };
    /** After `close`: the surface unmounts, possibly a URL write later, or the close was refused. */
    const awaitClose = (element: HTMLElement, from: string) => {
      const deadline = performance.now() + MOTION.closeWait;
      const check = () => {
        if (isClosed(element)) settling.current = false;
        else if (!isTop() || performance.now() > deadline) springBack(element, from);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    };
    const leave = (element: HTMLElement, edge: DragEdge, offset: number, velocity: number) => {
      const distance = offscreenDistance(element, edge);
      const from = translateFor(edge, offset);
      const to = translateFor(edge, offset + distance);
      settling.current = true;
      // Radix unmounts at once without exit keyframes: the surface is already gone by then.
      element.setAttribute('data-swiped', '');
      const animation = element.animate(
        { translate: [from, to] },
        { ...exitMotion(distance, velocity), fill: 'forwards' },
      );
      animation.onfinish = () => {
        element.style.translate = to;
        animation.cancel();
        if (isClosed(element)) {
          settling.current = false;
          return;
        }
        if (latest.current.close() === false) springBack(element, to);
        else awaitClose(element, to);
      };
    };
    const lock = (current: Gesture, dx: number, dy: number) => {
      if (Math.hypot(dx, dy) < GESTURE.slop) return;
      current.moved = true;
      const edge = current.edges.reduce((best, next) =>
        along(next, dx, dy) > along(best, dx, dy) ? next : best,
      );
      if (Math.abs(along(edge, dx, dy)) >= across(edge, dx, dy)) current.edge = edge;
      // Height glides and the drag would fight over the surface (animated-height.ts).
      if (current.edge && !current.reduced) current.surface.setAttribute('data-dragging', '');
    };
    const track = (current: Gesture, event: PointerEvent, dx: number, dy: number) => {
      if (!current.edge || current.reduced) return;
      const primary = along(current.edge, dx, dy);
      current.samples.push({ time: event.timeStamp, primary });
      current.offset = dragOffset(primary);
      current.surface.style.translate = translateFor(current.edge, current.offset);
    };
    const cancel = () => {
      const current = gesture.current;
      gesture.current = null;
      if (!current || !current.moved) return;
      springBack(
        current.surface,
        current.edge && !current.reduced ? translateFor(current.edge, current.offset) : '',
      );
    };
    const down = (event: PointerEvent) => {
      if (gesture.current && event.pointerId !== gesture.current.id) cancel();
    };
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.id) return;
      if (!isTop()) {
        cancel();
        return;
      }
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved) lock(current, dx, dy);
      if (current.moved) track(current, event, dx, dy);
    };
    const up = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.id) return;
      gesture.current = null;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved) lock(current, dx, dy);
      if (current.moved) swallowReleaseClick(current.surface);
      const { surface: element, edge, reduced, offset } = current;
      const velocity = releaseVelocity(
        [...current.samples, { time: event.timeStamp, primary: edge ? along(edge, dx, dy) : 0 }],
        event.timeStamp,
      );
      const rect = element.getBoundingClientRect();
      const size = edge === 'left' || edge === 'right' ? rect.width : rect.height;
      const dismiss =
        !!edge &&
        isTop() &&
        velocity >= GESTURE.reversal &&
        (qualifiesSwipe(edge, dx, dy, event.timeStamp - current.time) ||
          projectsDismiss(along(edge, dx, dy), across(edge, dx, dy), velocity, size));
      const from = edge && !reduced ? translateFor(edge, offset) : '';
      if (!dismiss) springBack(element, current.moved ? from : '');
      else if (reduced || typeof element.animate !== 'function') {
        reset(element);
        latest.current.close();
      } else leave(element, edge, offset, velocity);
    };
    window.addEventListener('resize', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('resize', cancel);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  return (event: ReactPointerEvent<HTMLElement>) => {
    const element = surface.current;
    const target = event.target;
    if (
      !enabled ||
      !element ||
      settling.current ||
      !event.isPrimary ||
      !['touch', 'pen'].includes(event.pointerType) ||
      (rank !== undefined && !isTopFloatingLayer(rank))
    )
      return;
    if (startFrom === 'handle') {
      const control = target instanceof Element ? target.closest(INTERACTIVE) : null;
      if (control && event.currentTarget.contains(control)) return;
    }
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      surface: element,
      edges: typeof edges === 'function' ? edges() : edges,
      reduced: reducedMotion(),
      moved: false,
      edge: null,
      offset: 0,
      samples: [],
    };
  };
}
