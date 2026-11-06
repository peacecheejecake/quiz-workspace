// UX12-GLASSBTN: every button and link styled as a button has a hover color, and hover applies only
// to hover-capable pointers, so a tap never leaves a sticky hover.
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const files = ['packages/ui/src', 'apps/web/src'].flatMap((root) =>
  readdirSync(resolve(repo, root), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.css'))
    .map((file) => resolve(repo, root, file)),
);
const sources = files.map((file) => ({
  file: relative(repo, file),
  css: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));

/** Pointer-cursor rules that are not buttons: a highlight mark, field labels, a Select option. */
const NOT_BUTTONS = new Set(['&[data-pressable]', '> .text > .label', '> .viewport > .item']);

/** Selectors ending in the rule's own subject, with pseudo-classes and attributes dropped. */
function subject(selector: string): string {
  const last = selector.trim().split(/\s+/).pop() ?? '';
  return /^[.&a-z][\w-]*/i.exec(last.replace(/^&/, ''))?.[0] ?? last;
}

describe('button hover guard', () => {
  it('reads the stylesheets (guards against a vacuous scan)', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('gives every pointer-cursor rule a :hover rule on the same subject', () => {
    const missing: string[] = [];
    for (const { file, css } of sources) {
      const hovers = [...css.matchAll(/([^{}]*:hover[^{}]*)\{/g)].map(([, s = '']) => s);
      for (const [, selectors = '', body = ''] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        if (!/cursor:\s*pointer/.test(body) || /:hover|:disabled/.test(selectors)) continue;
        for (const raw of selectors.split(',')) {
          const selector = raw.trim().replace(/\s+/g, ' ');
          if (NOT_BUTTONS.has(selector)) continue;
          const name = subject(selector);
          const hit = hovers.some((hover) =>
            new RegExp(`${name.replace('.', '\\.')}(?![\\w-])`).test(hover),
          );
          if (!hit) missing.push(`${file}: ${selector}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps top-level :hover rules behind @media (hover: hover)', () => {
    const unguarded: string[] = [];
    for (const { file, css } of sources) {
      const stack: string[] = [];
      for (const [, prelude = '', brace] of css.matchAll(/([^{}]*)([{}])/g)) {
        if (brace === '}') {
          stack.pop();
          continue;
        }
        const name = prelude.trim().replace(/\s+/g, ' ');
        stack.push(name);
        if (name.includes(':hover') && !stack.some((p) => p.includes('hover: hover'))) {
          unguarded.push(`${file}: ${name.split(';').pop()?.trim() ?? name}`);
        }
      }
    }
    expect(unguarded).toEqual(ALLOWED_UNGUARDED);
  });
});

/** Forced colors: an outline, which the system draws on every pointer. */
const ALLOWED_UNGUARDED = ['packages/ui/src/styles/overlays.css: &:is(:hover, :focus-visible)'];
