// Raw-color guard (docs/design-system.md §1.3, Governance): feature code must use semantic
// tokens (`var(--color-*)`, `var(--question-status-*)`) instead of color literals.
//   node scripts/check-raw-colors.ts [dir ...]   dirs are relative to the repo root
// Without arguments it scans DEFAULT_ROOTS; roots that do not exist yet are skipped.
// A line that genuinely needs a literal (e.g. a Storybook "wrong usage" example) can opt out
// with an `allow-raw-color` comment on the same line; reviewers should challenge each one.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
export const DEFAULT_ROOTS = ['apps/web', 'packages/ui'];

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.mdx',
  '.html',
]);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
]);
const ALLOW_MARKER = 'allow-raw-color';

// Hex: #rgb, #rgba, #rrggbb, #rrggbbaa. Not part of an identifier, an HTML entity (&#123;) or a
// private class member (this.#abc), and not followed by more identifier characters.
const HEX = /(?<![\w&.#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

export interface RawColor {
  line: number;
  column: number;
  match: string;
}

export interface Violation extends RawColor {
  file: string;
}

export function findRawColors(text: string): RawColor[] {
  const found: RawColor[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const pattern of [HEX, COLOR_FN]) {
      for (const m of line.matchAll(pattern)) {
        found.push({ line: index + 1, column: (m.index ?? 0) + 1, match: m[0] });
      }
    }
  });
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

function* walk(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (SCANNED_EXTENSIONS.has(extname(path))) yield path;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    yield* walk(join(path, entry.name));
  }
}

export function scan(
  roots: string[],
  repoRoot = REPO_ROOT,
): { scanned: string[]; violations: Violation[] } {
  const scanned: string[] = [];
  const violations: Violation[] = [];
  for (const root of roots) {
    const abs = resolve(repoRoot, root);
    if (!existsSync(abs)) continue;
    scanned.push(root);
    for (const file of walk(abs)) {
      for (const hit of findRawColors(readFileSync(file, 'utf8'))) {
        violations.push({ file: relative(repoRoot, file), ...hit });
      }
    }
  }
  return { scanned, violations };
}

function main(argv: string[]): number {
  const roots = argv.length > 0 ? argv : DEFAULT_ROOTS;
  const { scanned, violations } = scan(roots);
  for (const v of violations) {
    console.error(`${v.file}:${v.line}:${v.column}  raw color literal "${v.match}"`);
  }
  if (violations.length > 0) {
    console.error(
      `\nraw-color guard: ${violations.length} color literal(s) found. Use semantic tokens ` +
        'from @quiz/design-tokens (e.g. var(--color-accent)) instead.',
    );
    return 1;
  }
  const what = scanned.length > 0 ? scanned.join(', ') : `nothing yet (${roots.join(', ')} absent)`;
  console.log(`raw-color guard: ok, scanned ${what}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
