// Contract for the global reduced-motion rule in base.css (design-system.md §3.3, UX7-CSS).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASE_CSS = readFileSync(resolve(import.meta.dirname, '../src/base.css'), 'utf8');

/** Declarations (`property: value`) of the universal rule inside the reduced-motion query. */
function reducedMotionDecls(css: string): Record<string, string> {
  const rule =
    /@media \(prefers-reduced-motion: reduce\)\s*\{[^{]*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/.exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ''),
    );
  if (!rule?.[1])
    throw new Error('no universal rule in a prefers-reduced-motion block of base.css');
  const decls: Record<string, string> = {};
  for (const line of rule[1].split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) decls[m[1]] = m[2];
  }
  return decls;
}

describe('base.css reduced-motion rule', () => {
  const decls = reducedMotionDecls(BASE_CSS);

  it('turns transitions off instead of shortening them (no transition on undeclared elements)', () => {
    // A short duration with the default `transition-property: all` would make every style change
    // a one-frame transition, so computed styles would report the start value for a frame.
    expect(decls['transition']).toBe('none !important');
    expect(decls).not.toHaveProperty('transition-duration');
    expect(decls).not.toHaveProperty('transition-property');
  });

  it('turns animations off (Radix presence then unmounts at once)', () => {
    expect(decls['animation']).toBe('none !important');
    expect(decls).not.toHaveProperty('animation-duration');
  });

  it('keeps instant scrolling', () => {
    expect(decls['scroll-behavior']).toBe('auto !important');
  });
});
