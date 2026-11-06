// UX12-CONTROLS: only icon ghost and `borderless` ghost buttons may drop the visible boundary, and
// forced colors bring it back. Every other control keeps its border.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const controls = readFileSync('src/styles/controls.css', 'utf8');
const overlays = readFileSync('src/styles/overlays.css', 'utf8');
const layout = readFileSync('src/styles/layout.css', 'utf8');
const questions = readFileSync('src/styles/questions.css', 'utf8');

/** Selector of every rule in `css` that declares `declaration`, comments removed. */
function selectorsDeclaring(css: string, declaration: RegExp): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .filter(([, , body = '']) => declaration.test(body))
    .map(([, selector = '']) =>
      selector
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\( /g, '(')
        .replace(/,? \)/g, ')'),
    );
}

const NOT_TOGGLE = ":not([aria-pressed], [data-state='on'], [data-state='off'])";
const BORDERLESS = `.qz-icon-button[data-variant='ghost']${NOT_TOGGLE}, .qz-button[data-variant='ghost'][data-borderless]${NOT_TOGGLE}`;

describe('UX12-CONTROLS button boundary guard', () => {
  it('lets only icon ghost and borderless ghost buttons hide the border', () => {
    expect(selectorsDeclaring(controls, /border-color:\s*transparent/)).toEqual([BORDERLESS]);
    for (const css of [overlays, layout, questions]) {
      expect(selectorsDeclaring(css, /border(-color)?:[^;]*transparent/)).toEqual([]);
    }
  });

  it('keeps the base boundary of buttons, tabs and fields', () => {
    expect(controls.split('.qz-icon-button {')[1]?.split('}')[0]).toMatch(
      /border:\s*1px solid var\(--color-border\)/,
    );
    expect(controls.split('> .list > .trigger {')[1]?.split('}')[0]).toMatch(
      /border:\s*1px solid var\(--color-border\)/,
    );
    expect(controls.split('.qz-control {')[1]?.split('}')[0]).toMatch(
      /border:\s*1px solid var\(--color-border-strong\)/,
    );
  });

  it('restores the same buttons in forced colors, overriding the transparent border', () => {
    const forced = controls.slice(controls.indexOf('@media (forced-colors: active)'));
    expect(selectorsDeclaring(forced, /border-color:\s*ButtonText/)).toContain(BORDERLESS);
  });
});

describe('UX12-CONTROLS compact button rows', () => {
  it('uses --control-gap in the kit rows that hold only buttons', () => {
    const gaps = (css: string, block: string) =>
      css.split(block)[1]?.split('}')[0]?.match(/gap:\s*([^;]+);/)?.[1];
    expect(gaps(overlays, '> .footer {')).toBe('var(--control-gap)');
    expect(gaps(layout, '> .actions {')).toBe('var(--control-gap)');
    expect(gaps(questions, '> .chapter > .header > .actions {')).toBe('var(--control-gap)');
  });
});
