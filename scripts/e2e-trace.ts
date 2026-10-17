// `pnpm e2e:trace`: acceptance-criteria ↔ test traceability (docs/e2e-strategy.md §5).
//
// Sources of ACs:  docs/screens/*.md (`### <SCREEN>-ACnn` headings + the declared spec path) and
//                  docs/auth.md §7 (`AUTH-API-ACnn`, API contract tests under tests/integration/).
// Sources of tests: Playwright titles in tests/e2e/**/*.spec.ts (not _pending/) and pytest
//                  functions in tests/integration/**/*.py whose name carries an AC ID
//                  (`def test_auth_api_ac01_missing_jwt_is_401`).
//
// Default: print the report and exit 0. `--strict` exits 1 on problems for the selected screens
// (`--phase A0,M3.0` / `--screens WS-01,DOC-01`; neither = all screens; `--phase P0.10` = none)
// plus repo-wide title problems (unknown IDs, titles without an ID, test.only/skip/fixme).
// `--list-specs` prints the existing spec files of the selected screens, one per line.
// HARNESS-nn titles are reserved for harness self-tests in tests/e2e/harness/.
//
// Runs on plain Node (type stripping): only erasable TypeScript syntax, `node:` imports only.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface Screen {
  readonly id: string;
  readonly doc: string;
  /** Repo-relative spec file, or a directory prefix ending in `/` (API contracts). */
  readonly testPath: string | undefined;
  readonly acs: readonly string[];
}

export interface TestCase {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  /** Leading AC or HARNESS ID, if any. */
  readonly id: string | undefined;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export const API_SCREEN_ID = 'AUTH-API';
export const HARNESS_DIR = 'tests/e2e/harness/';
export const CONTRACT_DIR = 'tests/integration/';

/** RED Task → screens it introduces (docs/implementation-plan.md §3). */
export const PHASES: Readonly<Record<string, readonly string[]>> = {
  // Harness only: no AC screens, global title checks still apply.
  'P0.10': [],
  A0: [
    'AUTH-01',
    'AUTH-02',
    'AUTH-03',
    'AUTH-04',
    'AUTH-05',
    'AUTH-06',
    'AUTH-07',
    'ACCOUNT-01',
    API_SCREEN_ID,
  ],
  'M3.0': ['WS-01', 'DOC-01', 'DOC-02', 'SEARCH-01'],
  'M4.0': ['QBANK-01', 'QIMPORT-01'],
  'M5.0': ['QOV-01', 'QPLAY-01'],
  'M6.0': ['QGEN-01'],
  'M7.0': ['HISTORY-01'],
  S0: ['WS-SHARE-01', 'WS-VIEW-01', 'WS-FORK-01'],
};

const LEADING_ID = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?-AC\d+|HARNESS-\d+)\b/;

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function parseScreenSpec(doc: string, text: string): Screen | undefined {
  const heading = /^#\s+([A-Z][A-Z0-9-]*?)\s+[—-]/m.exec(text);
  if (!heading?.[1]) return undefined;
  const acs = [...text.matchAll(/^###\s+([A-Z][A-Z0-9-]*-AC\d+)\s*$/gm)].map((m) => m[1] as string);
  const testPath = /`(tests\/e2e\/[^`\s]+\.spec\.ts)`/.exec(text)?.[1];
  return { id: heading[1], doc, testPath, acs };
}

/** `AUTH-API-ACnn` IDs listed in docs/auth.md §7. */
export function parseApiContracts(doc: string, text: string): Screen {
  const start = text.search(/^## 7\./m);
  const rest = start < 0 ? '' : text.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const acs = [...new Set([...section.matchAll(/`(AUTH-API-AC\d+)`/g)].map((m) => m[1] as string))];
  return { id: API_SCREEN_ID, doc, testPath: CONTRACT_DIR, acs };
}

const PW_TEST =
  /(?<![\w.])(?:test|setup)(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const PW_FOCUS_OR_SKIP = /(?<![\w.])(?:test|setup)(?:\.describe)?\.(?:only|skip|fixme)\b/g;

export function parsePlaywrightTests(
  file: string,
  text: string,
): { tests: TestCase[]; violations: Violation[] } {
  const tests = [...text.matchAll(PW_TEST)].map((m) => {
    const title = (m[2] ?? '').replace(/\\(.)/g, '$1');
    return { file, line: lineAt(text, m.index), title, id: LEADING_ID.exec(title)?.[1] };
  });
  const violations = [...text.matchAll(PW_FOCUS_OR_SKIP)].map((m) => ({
    file,
    line: lineAt(text, m.index),
    text: m[0],
  }));
  return { tests, violations };
}

/** pytest functions whose name carries an AC ID, e.g. `test_ws_share_01_ac02_...` → WS-SHARE-01-AC02. */
export function parsePytestTests(file: string, text: string): TestCase[] {
  const out: TestCase[] = [];
  for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm)) {
    const name = m[1] as string;
    const ac = /^test_([a-z0-9]+(?:_[a-z0-9]+)*?_ac\d+)(?:_|$)/.exec(name);
    if (!ac?.[1]) continue;
    out.push({
      file,
      line: lineAt(text, m.index),
      title: name,
      id: ac[1].toUpperCase().replaceAll('_', '-'),
    });
  }
  return out;
}

export interface Report {
  readonly screens: readonly Screen[];
  readonly tests: readonly TestCase[];
  readonly violations: readonly Violation[];
  /** AC → tests that reference it. */
  readonly coverage: ReadonlyMap<string, readonly TestCase[]>;
  readonly orphanAcs: readonly string[];
  /** Tests whose leading ID is not an AC in the docs (or a misplaced HARNESS test). */
  readonly orphanTests: readonly TestCase[];
  /** Playwright tests without a leading AC/HARNESS ID. */
  readonly untitledTests: readonly TestCase[];
  /** Tests outside the screen's declared spec file (or API contract directory). */
  readonly misplacedTests: readonly (TestCase & { readonly expected: string })[];
}

export function screenOfAc(ac: string): string {
  return ac.replace(/-AC\d+$/, '');
}

/** Browser specs must sit in the declared file; API contract tests may back any screen's AC. */
function inDeclaredPath(file: string, declared: string): boolean {
  if (file.startsWith(CONTRACT_DIR)) return true;
  return declared.endsWith('/') ? file.startsWith(declared) : file === declared;
}

export function analyze(
  screens: readonly Screen[],
  tests: readonly TestCase[],
  violations: readonly Violation[],
): Report {
  const acToScreen = new Map<string, Screen>();
  for (const s of screens) for (const ac of s.acs) acToScreen.set(ac, s);
  const coverage = new Map<string, TestCase[]>([...acToScreen.keys()].map((ac) => [ac, []]));
  const orphanTests: TestCase[] = [];
  const untitledTests: TestCase[] = [];
  const misplacedTests: (TestCase & { expected: string })[] = [];

  for (const t of tests) {
    if (!t.id) {
      untitledTests.push(t);
    } else if (t.id.startsWith('HARNESS-')) {
      if (!t.file.startsWith(HARNESS_DIR)) misplacedTests.push({ ...t, expected: HARNESS_DIR });
    } else {
      const screen = acToScreen.get(t.id);
      if (!screen) {
        orphanTests.push(t);
        continue;
      }
      coverage.get(t.id)?.push(t);
      if (!screen.testPath || !inDeclaredPath(t.file, screen.testPath)) {
        misplacedTests.push({ ...t, expected: screen.testPath ?? '(no test path declared)' });
      }
    }
  }
  const orphanAcs = [...coverage].filter(([, ts]) => ts.length === 0).map(([ac]) => ac);
  return {
    screens,
    tests,
    violations,
    coverage,
    orphanAcs,
    orphanTests,
    untitledTests,
    misplacedTests,
  };
}

/** Screen IDs selected by `--phase` / `--screens`; all screens when neither is given. */
export function selectScreens(
  report: Report,
  phases: readonly string[] | undefined,
  screens: readonly string[] | undefined,
): Set<string> {
  const known = new Set(report.screens.map((s) => s.id));
  if (phases === undefined && screens === undefined) return known;
  const selected = new Set<string>();
  for (const phase of phases ?? []) {
    const ids = PHASES[phase];
    if (!ids) throw new Error(`unknown phase ${phase} (known: ${Object.keys(PHASES).join(', ')})`);
    ids.forEach((id) => selected.add(id));
  }
  for (const id of screens ?? []) {
    if (!known.has(id)) throw new Error(`unknown screen ${id}`);
    selected.add(id);
  }
  return selected;
}

/** Problems that fail `--strict` for the selected screens. */
export function strictProblems(report: Report, selected: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const ac of report.orphanAcs) {
    if (selected.has(screenOfAc(ac)))
      problems.push(`orphan AC ${ac}: no test title starts with it`);
  }
  for (const t of report.misplacedTests) {
    if (t.id?.startsWith('HARNESS-') || (t.id && selected.has(screenOfAc(t.id)))) {
      problems.push(`misplaced test ${t.file}:${t.line} "${t.title}" (expected in ${t.expected})`);
    }
  }
  for (const t of report.orphanTests)
    problems.push(`orphan test ${t.file}:${t.line} "${t.title}": ${t.id} is not in the docs`);
  for (const t of report.untitledTests)
    problems.push(`untitled test ${t.file}:${t.line} "${t.title}": title must start with an AC ID`);
  for (const v of report.violations)
    problems.push(`${v.text} at ${v.file}:${v.line}: no focused/skipped tests`);
  return problems;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const acCount = report.screens
    .filter((s) => s.id !== API_SCREEN_ID)
    .reduce((n, s) => n + s.acs.length, 0);
  const api = report.screens.find((s) => s.id === API_SCREEN_ID);
  const harness = report.tests.filter((t) => t.id?.startsWith('HARNESS-')).length;
  lines.push(
    `e2e:trace: ${acCount} screen ACs in ${report.screens.length - (api ? 1 : 0)} screens` +
      (api ? ` + ${api.acs.length} API contract ACs` : '') +
      `; ${report.tests.length} tests (${harness} HARNESS)`,
    '',
    `${'screen'.padEnd(12)} ${'covered'.padStart(7)}  declared test path`,
  );
  for (const s of report.screens) {
    const covered = s.acs.filter((ac) => (report.coverage.get(ac)?.length ?? 0) > 0).length;
    lines.push(
      `${s.id.padEnd(12)} ${`${covered}/${s.acs.length}`.padStart(7)}  ${s.testPath ?? '(none)'}`,
    );
  }
  const section = (title: string, items: readonly string[]) => {
    lines.push('', `${title} (${items.length})`);
    for (const item of items) lines.push(`  ${item}`);
  };
  const where = (t: TestCase) => `${t.file}:${t.line} "${t.title}"`;
  const orphansByScreen = new Map<string, string[]>();
  for (const ac of report.orphanAcs) {
    const screen = screenOfAc(ac);
    orphansByScreen.set(screen, [
      ...(orphansByScreen.get(screen) ?? []),
      ac.slice(screen.length + 1),
    ]);
  }
  lines.push('', `Orphan ACs (no test) (${report.orphanAcs.length})`);
  for (const [screen, acs] of orphansByScreen) lines.push(`  ${screen}: ${acs.join(' ')}`);
  section('Orphan tests (ID not in docs)', report.orphanTests.map(where));
  section(
    'Misplaced tests (not in the declared file)',
    report.misplacedTests.map((t) => `${where(t)} → ${t.expected}`),
  );
  section('Tests without a leading AC/HARNESS ID', report.untitledTests.map(where));
  section(
    'Focused/skipped tests',
    report.violations.map((v) => `${v.file}:${v.line} ${v.text}`),
  );
  return lines.join('\n');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function loadReport(root: string): Report {
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const screens: Screen[] = [];
  for (const doc of globSync('docs/screens/*.md', { cwd: root }).map(toPosix).sort()) {
    if (doc.endsWith('/index.md')) continue;
    const screen = parseScreenSpec(doc, read(doc));
    if (screen) screens.push(screen);
  }
  screens.push(parseApiContracts('docs/auth.md', read('docs/auth.md')));

  const tests: TestCase[] = [];
  const violations: Violation[] = [];
  const specs = globSync('tests/e2e/**/*.{spec,setup,teardown}.ts', {
    cwd: root,
    exclude: ['tests/e2e/_pending/**'],
  });
  for (const file of specs.map(toPosix).sort()) {
    const parsed = parsePlaywrightTests(file, read(file));
    // setup/teardown steps are infrastructure, not AC tests; only check them for .only/.skip.
    if (file.endsWith('.spec.ts')) tests.push(...parsed.tests);
    violations.push(...parsed.violations);
  }
  for (const file of globSync('tests/integration/**/*.py', { cwd: root }).map(toPosix).sort()) {
    tests.push(...parsePytestTests(file, read(file)));
  }
  return analyze(screens, tests, violations);
}

/** Values of a repeatable `--name a,b` / `--name=a,b` option; undefined when absent. */
function listArg(args: readonly string[], name: string): string[] | undefined {
  let out: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    let value: string | undefined;
    if (arg === name) value = args[++i] ?? '';
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    if (value === undefined) continue;
    out = [
      ...(out ?? []),
      ...value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ];
  }
  return out;
}

export function main(argv: readonly string[], root: string): number {
  const report = loadReport(root);
  const selected = selectScreens(report, listArg(argv, '--phase'), listArg(argv, '--screens'));
  if (argv.includes('--list-specs')) {
    // Spec files of the selected screens that exist (CI passes them to `playwright test`).
    const specs = report.screens
      .filter((s) => selected.has(s.id) && s.testPath?.endsWith('.spec.ts'))
      .map((s) => s.testPath as string)
      .filter((path) => existsSync(join(root, path)));
    console.log([...new Set(specs)].join('\n'));
    return 0;
  }
  console.log(formatReport(report));
  if (!argv.includes('--strict')) return 0;
  const problems = strictProblems(report, selected);
  const scope = selected.size ? [...selected].join(', ') : 'global title checks only';
  console.log('', `strict (${scope}): ${problems.length ? 'FAIL' : 'OK'}`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  return problems.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2), join(import.meta.dirname, '..'));
  } catch (err) {
    console.error(`e2e:trace: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
