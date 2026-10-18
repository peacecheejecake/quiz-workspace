import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ui from '../src';

const SRC = resolve(import.meta.dirname, '../src');
const FIXTURE_PAGE = resolve(import.meta.dirname, 'rsc-fixture/app/page.jsx');

function sourceModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceModules(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.stories.') ? [path] : [];
  });
}

// Anything that needs the client runtime: Radix primitives, React hooks or context.
const CLIENT_API = /from 'radix-ui'|\buse[A-Z]\w*\(|\bcreateContext\(/;

describe('Next.js client boundaries', () => {
  it.each(sourceModules(SRC).map((file) => [relative(SRC, file), file]))(
    '%s starts with "use client" when it uses client-only APIs',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      if (!CLIENT_API.test(source)) return;
      expect(source.trimStart().startsWith("'use client';")).toBe(true);
    },
  );

  it('the RSC build fixture imports every runtime export', () => {
    const page = readFileSync(FIXTURE_PAGE, 'utf8');
    const imported = /import \{([^}]*)\} from '@quiz\/ui'/.exec(page)?.[1] ?? '';
    const names = new Set(imported.split(',').map((name) => name.trim()));
    expect(Object.keys(ui).filter((name) => !names.has(name))).toEqual([]);
  });
});
