'use client';

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { isTopFloatingLayer } from './layer';

type Edge = 'left' | 'right' | 'top' | 'bottom';
const GESTURE = { distance: 64, flickDistance: 24, flickSpeed: 0.5, axisRatio: 1.5 } as const;

export function nearestEdge(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  width: number,
  height: number,
  preferred: Edge,
): Edge {
  const distances: Record<Edge, number> = {
    left: rect.left,
    right: width - rect.right,
    top: rect.top,
    bottom: height - rect.bottom,
  };
  const minimum = Math.min(...Object.values(distances));
  return distances[preferred] === minimum
    ? preferred
    : ((Object.keys(distances) as Edge[]).find((edge) => distances[edge] === minimum) ?? preferred);
}

export function qualifiesSwipe(edge: Edge, dx: number, dy: number, elapsed: number): boolean {
  const primary = edge === 'right' ? dx : edge === 'left' ? -dx : edge === 'bottom' ? dy : -dy;
  const cross = edge === 'right' || edge === 'left' ? Math.abs(dy) : Math.abs(dx);
  return (
    primary >= cross * GESTURE.axisRatio &&
    (primary >= GESTURE.distance ||
      (primary >= GESTURE.flickDistance && primary / Math.max(elapsed, 1) >= GESTURE.flickSpeed))
  );
}

export function useSwipeDismiss(
  surface: React.RefObject<HTMLElement | null>,
  rank: number,
  enabled: boolean,
  preferred: Edge,
  close: () => void,
) {
  const gesture = useRef<{ id: number; x: number; y: number; time: number; edge: Edge } | null>(
    null,
  );
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const cancel = () => {
      gesture.current = null;
    };
    const down = (event: PointerEvent) => {
      if (gesture.current && event.pointerId !== gesture.current.id) cancel();
    };
    const up = (event: PointerEvent) => {
      const start = gesture.current;
      cancel();
      if (
        start &&
        event.pointerId === start.id &&
        isTopFloatingLayer(rank) &&
        qualifiesSwipe(
          start.edge,
          event.clientX - start.x,
          event.clientY - start.y,
          event.timeStamp - start.time,
        )
      )
        closeRef.current();
    };
    window.addEventListener('resize', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('resize', cancel);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
    };
  }, [rank]);
  return (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !enabled ||
      !isTopFloatingLayer(rank) ||
      !event.isPrimary ||
      !['touch', 'pen'].includes(event.pointerType) ||
      event.target !== event.currentTarget ||
      !surface.current
    )
      return;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      edge: nearestEdge(
        surface.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        surface.current.classList.contains('qz-panel') && window.innerWidth < 768
          ? 'bottom'
          : preferred,
      ),
    };
  };
}
