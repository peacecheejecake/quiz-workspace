import { describe, expect, it } from 'vitest';
import { trailingExtent } from '../src/components/documents/editor/viewer-fit';

describe('trailingExtent (DOCVIEW-01 viewer fit)', () => {
  it('counts siblings that start at or below the element', () => {
    expect(trailingExtent(500, [{ top: 512, bottom: 540 }])).toBe(40);
    expect(
      trailingExtent(500, [
        { top: 500, bottom: 520 },
        { top: 530, bottom: 560 },
      ]),
    ).toBe(60);
  });

  it('ignores earlier rows and parallel columns, however tall', () => {
    expect(trailingExtent(500, [{ top: 0, bottom: 120 }])).toBe(0);
    // A sidebar beside the element that reaches far below it.
    expect(trailingExtent(500, [{ top: 200, bottom: 2400 }])).toBe(0);
  });

  it('is independent of the element height (fixed point)', () => {
    // The element shrinks by 300px: following content moves up with it, a parallel column stays.
    const sidebar = { top: 200, bottom: 2400 };
    const tall = trailingExtent(900, [sidebar, { top: 916, bottom: 950 }]);
    const short = trailingExtent(600, [sidebar, { top: 616, bottom: 650 }]);
    expect(short).toBe(tall);
  });

  it('tolerates sub-pixel layout noise and never goes negative', () => {
    expect(trailingExtent(500, [{ top: 499.7, bottom: 530 }])).toBe(30);
    expect(trailingExtent(500, [{ top: 499, bottom: 530 }])).toBe(0);
    expect(trailingExtent(500, [])).toBe(0);
  });
});
