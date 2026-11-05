import { describe, expect, it } from 'vitest';
import { nearestEdge, qualifiesSwipe } from '../src/internal/swipe-dismiss';

describe('UX10 overlay swipe', () => {
  it('UX10-UI-AC03 chooses the nearest edge and the placement on ties', () => {
    expect(nearestEdge({ left: 500, right: 984, top: 16, bottom: 784 }, 1000, 800, 'right')).toBe(
      'right',
    );
    expect(nearestEdge({ left: 100, right: 900, top: 100, bottom: 700 }, 1000, 800, 'bottom')).toBe(
      'bottom',
    );
    expect(qualifiesSwipe('right', 70, 10, 500)).toBe(true);
    expect(qualifiesSwipe('bottom', 5, 25, 40)).toBe(true);
  });
  it('UX10-UI-AC04 rejects opposite, short and cross-axis movements', () => {
    expect(qualifiesSwipe('right', -80, 0, 100)).toBe(false);
    expect(qualifiesSwipe('right', 23, 0, 10)).toBe(false);
    expect(qualifiesSwipe('right', 80, 60, 100)).toBe(false);
  });
});

it('UX10-UI-AC01 keeps an explicit boundary on transparent button variants', async () => {
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

it('UX10-UI-AC03 fixes the closest edge and honors every directional threshold', () => {
  expect(nearestEdge({ left: 8, right: 800, top: 40, bottom: 760 }, 1000, 800, 'right')).toBe(
    'left',
  );
  expect(nearestEdge({ left: 100, right: 900, top: 5, bottom: 700 }, 1000, 800, 'bottom')).toBe(
    'top',
  );
  expect(qualifiesSwipe('left', -64, 0, 1000)).toBe(true);
  expect(qualifiesSwipe('top', 0, -64, 1000)).toBe(true);
  expect(qualifiesSwipe('bottom', 0, -100, 10)).toBe(false);
  expect(qualifiesSwipe('left', -24, 0, 49)).toBe(false);
});

it('UX10-UI-AC01 BackLink buttons have a boundary while links retain link styling', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles/layout.css', 'utf8');
  expect(css).toMatch(/button\.qz-back-link\s*\{\s*border:\s*1px solid var\(--color-border\)/);
});
