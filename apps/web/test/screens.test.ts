import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENS, getScreen, isQueryStateActive } from '../src/screens';

const SCREENS_INDEX = resolve(import.meta.dirname, '../../../docs/screens/index.md');
const APP_DIR = resolve(import.meta.dirname, '../src/app');

interface DocScreen {
  id: string;
  name: string;
  path: string;
  query?: string;
}

/** Rows of the screen table in docs/screens/index.md: `| ID | Screen | \`route\` | link |`. */
function parseScreensIndex(markdown: string): DocScreen[] {
  const rows: DocScreen[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\|\s*([A-Z]+(?:-[A-Z]+)*-\d+)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!m) continue;
    const [, id, name, route] = m as unknown as [string, string, string, string];
    const [rawPath, query] = route.split('?') as [string, string | undefined];
    const path = rawPath.replace(/:(\w+)/g, '[$1]');
    rows.push(query === undefined ? { id, name, path } : { id, name, path, query });
  }
  return rows;
}

const docScreens = parseScreensIndex(readFileSync(SCREENS_INDEX, 'utf8'));

/**
 * `page.tsx`, or `route.ts` for screens that are a Route Handler (AUTH-04 /auth/callback). A page
 * may sit in a route group (`(home)/page.tsx` for `/workspaces/[workspaceId]`).
 */
function pageFile(path: string): string {
  const dir = join(APP_DIR, ...path.split('/').filter(Boolean));
  const route = join(dir, 'route.ts');
  if (existsSync(route)) return route;
  const page = join(dir, 'page.tsx');
  if (existsSync(page) || !existsSync(dir)) return page;
  const group = readdirSync(dir).find(
    (name) => /^\(.+\)$/.test(name) && existsSync(join(dir, name, 'page.tsx')),
  );
  return group ? join(dir, group, 'page.tsx') : page;
}

describe('screen route table', () => {
  it('parses all 21 screens from docs/screens/index.md', () => {
    expect(docScreens).toHaveLength(21);
  });

  it('covers exactly the screen IDs, names and routes of the doc', () => {
    const table = SCREENS.map((s) => ({ id: s.id, name: s.name, path: s.path }));
    const doc = docScreens.map(({ id, name, path }) => ({ id, name, path }));
    expect(table).toEqual(doc);
  });

  it('matches the query parameters that turn a route into a panel screen', () => {
    for (const doc of docScreens) {
      const screen = SCREENS.find((s) => s.id === doc.id);
      if (doc.query === undefined) {
        expect(screen && 'query' in screen, doc.id).toBe(false);
        continue;
      }
      const [param, value] = doc.query.split('=') as [string, string | undefined];
      const expected =
        value === undefined || value.startsWith(':') ? { param } : { param, value: value };
      expect(screen && 'query' in screen ? screen.query : undefined, doc.id).toEqual(expected);
    }
  });

  it.each(SCREENS.map((s) => [s.id, s] as const))(
    '%s resolves to a page or route file',
    (id, screen) => {
      const file = pageFile(screen.path);
      expect(existsSync(file), `${file} missing`).toBe(true);
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`['"]${id}['"]`));
    },
  );
});

describe('isQueryStateActive', () => {
  const qplay = getScreen('QPLAY-01');
  const fork = getScreen('WS-FORK-01');

  it('activates QPLAY-01 for any non-empty ?question=', () => {
    expect(isQueryStateActive(qplay, { question: 'q-1' })).toBe(true);
    expect(isQueryStateActive(qplay, { question: ['q-1', 'q-2'] })).toBe(true);
    expect(isQueryStateActive(qplay, { question: '' })).toBe(false);
    expect(isQueryStateActive(qplay, {})).toBe(false);
  });

  it('activates WS-FORK-01 only for ?panel=fork', () => {
    expect(isQueryStateActive(fork, { panel: 'fork' })).toBe(true);
    expect(isQueryStateActive(fork, { panel: 'other' })).toBe(false);
    expect(isQueryStateActive(fork, {})).toBe(false);
  });
});
