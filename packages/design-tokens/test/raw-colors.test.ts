import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOTS, REPO_ROOT, findRawColors, scan } from '../scripts/check-raw-colors.ts';

const SCRIPT = resolve(import.meta.dirname, '../scripts/check-raw-colors.ts');
const FIXTURES = 'packages/design-tokens/test/fixtures';

function runGuard(...roots: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...roots], { encoding: 'utf8' });
}

describe('raw-color guard', () => {
  it('rejects fixture files with raw hex / rgba() / hsl()', () => {
    const { violations } = scan([`${FIXTURES}/raw-color`]);
    expect(violations.map((v) => `${v.file.split('/').pop()}:${v.line}:${v.match}`).sort()).toEqual(
      ['panel.css:3:rgba(', 'panel.css:4:hsl(', 'status-dot.ts:2:#E0525E'],
    );
  });

  it('accepts fixture files that only use tokens', () => {
    const { scanned, violations } = scan([`${FIXTURES}/clean`]);
    expect(scanned).toEqual([`${FIXTURES}/clean`]);
    expect(violations).toEqual([]);
  });

  it('CLI exits 1 on raw colors and 0 on token usage', () => {
    const bad = runGuard(`${FIXTURES}/raw-color`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('status-dot.ts:2:');
    expect(runGuard(`${FIXTURES}/clean`).status).toBe(0);
  });

  it('targets feature code (apps/web, packages/ui) and skips roots that do not exist yet', () => {
    expect(DEFAULT_ROOTS).toEqual(['apps/web', 'packages/ui']);
    expect(scan(['does/not/exist'], REPO_ROOT)).toEqual({ scanned: [], violations: [] });
    const result = runGuard();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['#fff', '#fff'],
    ['#ffff', '#ffff'],
    ['#ABCDEF', '#ABCDEF'],
    ['#11223344', '#11223344'],
    ['rgb(0 0 0)', 'rgb('],
    ['RGBA(0,0,0,.5)', 'RGBA('],
    ['hsla(0, 0%, 0%, 1)', 'hsla('],
    ['oklch(70% 0.1 250)', 'oklch('],
  ])('flags %s', (literal, match) => {
    expect(findRawColors(`const c = '${literal}';`).map((h) => h.match)).toEqual([match]);
  });

  it.each([
    "href: '#question-list'",
    "id: '#12'",
    "html: '&#123;'",
    'this.#face.get(key)',
    "color: 'var(--color-accent)'",
    'const background = surface;',
    "color: 'currentColor'",
    "example: '#E0525E', // allow-raw-color: Storybook wrong-usage demo",
  ])('ignores %s', (line) => {
    expect(findRawColors(line)).toEqual([]);
  });

  it('reports 1-based line and column', () => {
    expect(findRawColors('a\n  color: #123456;')).toEqual([
      { line: 2, column: 10, match: '#123456' },
    ]);
  });
});
