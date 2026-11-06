// A touch drag as pointer events, step by step: Playwright has no swipe API and CDP is
// Chromium-only. Reads the surface's inline `translate` after every step, before the release.
import type { Locator } from '@playwright/test';

export interface DragOptions {
  /** `closest()` selector of the surface that moves; defaults to any overlay surface. */
  readonly surface?: string;
  readonly pointerType?: string;
  /** Wait after every step, so the elapsed time reads as a slow drag. */
  readonly pauseMs?: number;
  /** How the gesture ends. */
  readonly end?: 'up' | 'cancel';
  /** Dispatch the release `click` a real browser sends after `pointerup` on the same target. */
  readonly click?: boolean;
}

/** Drags from the center of `target` through `steps` (offsets from the start) in order. */
export async function drag(
  target: Locator,
  steps: readonly (readonly [number, number])[],
  options: DragOptions = {},
): Promise<string[]> {
  return target.evaluate(
    async (element, { steps, surface, pointerType, pauseMs, end, click }) => {
      const moving = element.closest<HTMLElement>(surface);
      if (!moving) throw new Error(`no surface ${surface}`);
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const fire = (type: string, dx = 0, dy = 0) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType,
            isPrimary: true,
            clientX: x + dx,
            clientY: y + dy,
          }),
        );
      const pause = () => new Promise((resolve) => setTimeout(resolve, pauseMs));
      fire('pointerdown');
      const seen: string[] = [];
      for (const [dx, dy] of steps) {
        fire('pointermove', dx, dy);
        seen.push(moving.style.translate);
        await pause();
      }
      const [lastX, lastY] = steps[steps.length - 1] ?? [0, 0];
      fire(end === 'up' ? 'pointerup' : 'pointercancel', lastX, lastY);
      if (click)
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return seen;
    },
    {
      steps,
      surface: options.surface ?? '.qz-panel, .qz-modal, .qz-drawer',
      pointerType: options.pointerType ?? 'touch',
      pauseMs: options.pauseMs ?? 30,
      end: options.end ?? 'up',
      click: options.click ?? false,
    },
  );
}

/** `count` even steps along an offset. */
export function line(dx: number, dy: number, count = 4): (readonly [number, number])[] {
  return Array.from({ length: count }, (_, i) => [(dx * (i + 1)) / count, (dy * (i + 1)) / count]);
}

/** The inline `translate` of a surface: empty once it is back in place. */
export function inlineTranslate(surface: Locator): Promise<string> {
  return surface.evaluate((element) => (element as HTMLElement).style.translate);
}
