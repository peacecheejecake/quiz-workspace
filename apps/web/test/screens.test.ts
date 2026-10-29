import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SCREEN_ID, PHASES } from '../../../scripts/e2e-trace.ts';
import { SCREENS, getScreen, isQueryStateActive } from '../src/screens';

const SCREENS_INDEX = resolve(import.meta.dirname, '../../../docs/screens/index.md');
const CI_WORKFLOW = resolve(import.meta.dirname, '../../../.github/workflows/ci.yml');
const APP_DIR = resolve(import.meta.dirname, '../src/app');

interface DocScreen {
  id: string;
  name: string;
  /** App Router path; undefined for a screen without its own route (DOC-03: a row menu action). */
  path?: string;
  /** Primary query parameter (`panel=value` of `?panel=value&document=:id`); extras are ignored. */
  query?: string;
}

/** Rows of the screen table in docs/screens/index.md: `| ID | Screen | \`route\` | link |`. */
function parseScreensIndex(markdown: string): DocScreen[] {
  const rows: DocScreen[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\|\s*([A-Z]+(?:-[A-Z]+)*-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    const [, id, name, routeCell] = m as unknown as [string, string, string, string];
    const route = /^`(\/[^`]*)`$/.exec(routeCell)?.[1];
    if (route === undefined) {
      rows.push({ id, name });
      continue;
    }
    const [rawPath, search] = route.split('?') as [string, string | undefined];
    const path = rawPath.replace(/:(\w+)/g, '[$1]');
    const query = search?.split('&')[0];
    rows.push(query === undefined ? { id, name, path } : { id, name, path, query });
  }
  return rows;
}

const docScreens = parseScreensIndex(readFileSync(SCREENS_INDEX, 'utf8'));

/**
 * Screens of the phases CI runs as GREEN (`E2E_PHASES`). A spec-only screen (its RED phase not yet
 * in `E2E_PHASES`) may be missing from SCREENS; once its implementing Task adds the phase, it must
 * be listed. Entries present in SCREENS are always checked against the doc.
 */
const shippedScreenIds = new Set(
  (/^\s*E2E_PHASES:\s*(\S+)\s*$/m.exec(readFileSync(CI_WORKFLOW, 'utf8'))?.[1] ?? '')
    .split(',')
    .flatMap((phase) => PHASES[phase] ?? []),
);
const listedIds = new Set<string>(SCREENS.map((s) => s.id));
const routeScreens = docScreens.filter(
  (s): s is DocScreen & { path: string } => s.path !== undefined,
);
const expectedScreens = routeScreens.filter(
  (s) => shippedScreenIds.has(s.id) || listedIds.has(s.id),
);

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
  it('lists every screen of the e2e-trace phases in docs/screens/index.md', () => {
    const phaseIds = Object.values(PHASES)
      .flat()
      .filter((id) => id !== API_SCREEN_ID);
    expect(docScreens.map((s) => s.id).sort()).toEqual([...new Set(phaseIds)].sort());
    expect(shippedScreenIds.size).toBeGreaterThan(0);
  });

  it('covers exactly the screen IDs, names and routes of the doc (shipped or listed)', () => {
    const table = SCREENS.map((s) => ({ id: s.id, name: s.name, path: s.path }));
    const doc = expectedScreens.map(({ id, name, path }) => ({ id, name, path }));
    expect(table).toEqual(doc);
  });

  it('matches the query parameters that turn a route into a panel screen', () => {
    for (const doc of expectedScreens) {
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
