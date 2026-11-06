import { describe, expect, it } from 'vitest';
import {
  dragOffset,
  exitMotion,
  panelEdges,
  projectsDismiss,
  qualifiesSwipe,
} from '../src/internal/swipe-dismiss';

describe('UX10 overlay swipe', () => {
  it('UX10-UI-AC03 goes down on a phone and by side on a wide screen', () => {
    expect(panelEdges('end', 390)).toEqual(['bottom']);
    expect(panelEdges('start', 767)).toEqual(['bottom']);
    expect(panelEdges('end', 768)).toEqual(['right']);
    expect(panelEdges('start', 1280)).toEqual(['left']);
    expect(qualifiesSwipe('right', 70, 10, 500)).toBe(true);
    expect(qualifiesSwipe('bottom', 5, 25, 40)).toBe(true);
  });
  it('UX10-UI-AC04 rejects opposite, short and cross-axis movements', () => {
    expect(qualifiesSwipe('right', -80, 0, 100)).toBe(false);
    expect(qualifiesSwipe('right', 23, 0, 10)).toBe(false);
    expect(qualifiesSwipe('right', 80, 60, 100)).toBe(false);
  });
});

// UX12-CONTROLS revised UX10-UI-AC01: borderless is allowed only for icon ghost and `borderless`
// buttons (the guard is test/control-boundary.test.ts); every other control keeps a boundary.
it('UX10-UI-AC01 keeps an explicit boundary on the base button rule', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles/controls.css', 'utf8');
  expect(css).toMatch(/border:\s*1px solid var\(--color-border\)/);
  expect(css).toMatch(/box-sizing:\s*border-box/);
  expect(css).not.toMatch(/border-color:\s*transparent;\s*background:\s*transparent/);
});

it('UX10-UI-AC01 tabs have a visible default boundary', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles/controls.css', 'utf8');
  const tabRule = css.split('> .list > .trigger {')[1]?.split('}')[0];
  expect(tabRule).toMatch(/border:\s*1px solid var\(--color-border\)/);
});

it('UX10-UI-AC03 honors every directional threshold', () => {
  expect(qualifiesSwipe('left', -64, 0, 1000)).toBe(true);
  expect(qualifiesSwipe('top', 0, -64, 1000)).toBe(true);
  expect(qualifiesSwipe('bottom', 0, -100, 10)).toBe(false);
  expect(qualifiesSwipe('left', -24, 0, 49)).toBe(false);
});

it('UX12-GESTURE-AC04 a drag against the direction stretches like a rubber band', () => {
  expect(dragOffset(120)).toBe(120);
  expect(dragOffset(0)).toBe(0);
  expect(dragOffset(-10)).toBeLessThan(0);
  expect(dragOffset(-10)).toBeGreaterThan(-10);
  expect(dragOffset(-2000)).toBeGreaterThanOrEqual(-24);
  expect(dragOffset(-200)).toBeLessThan(dragOffset(-100));
});

it('UX12-GESTURE-AC01 a fast release dismisses before the distance threshold', () => {
  expect(projectsDismiss(30, 0, 2, 600)).toBe(true);
  expect(projectsDismiss(30, 0, 0.1, 600)).toBe(false);
  expect(projectsDismiss(300, 0, -1, 600)).toBe(false);
  expect(projectsDismiss(30, 40, 2, 600)).toBe(false);
  // A small surface (the return bar) still needs the distance threshold.
  expect(projectsDismiss(30, 0, 0.125, 52)).toBe(false);
});

it('UX12-GESTURE-AC01 the exit continues the release velocity within bounds', () => {
  expect(exitMotion(500, 3).duration).toBeLessThanOrEqual(280);
  expect(exitMotion(40, 5).duration).toBeGreaterThanOrEqual(120);
  expect(exitMotion(500, 0).easing).toContain('cubic-bezier(0.3, 0.000');
  const slope = (velocity: number) =>
    Number(/cubic-bezier\([\d.]+, ([\d.]+)/.exec(exitMotion(500, velocity).easing)?.[1]);
  expect(slope(2)).toBeGreaterThan(slope(1));
});

it('UX12-CONTROLS BackLink has no boundary, as a button or as a link', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles/layout.css', 'utf8');
  expect(css).not.toMatch(/button\.qz-back-link\s*\{/);
  expect(css.split('.qz-back-link {')[1]?.split('}')[0]).toMatch(/border:\s*0/);
});
