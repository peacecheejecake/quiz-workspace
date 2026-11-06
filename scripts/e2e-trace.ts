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
// `--list-specs --exclude-phase <phases>` prints the spec files of every *other* phase's screens
// that no listed phase also declares (CI runs all of tests/e2e minus these: the not-yet-GREEN ones).
// Reserved non-AC IDs: HARNESS-nn for harness self-tests in tests/e2e/harness/, and the M7.2
// cross-screen quality checks A11Y-nn / VISUAL-nn / SMOKE-nn / PERF-nn in tests/e2e/quality/.
//
// Runs on plain Node (type stripping): only erasable TypeScript syntax. Test calls are found with
// the TypeScript parser (root devDependency), not regexes, so comments and strings never count.
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

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
  /** Leading AC or reserved (HARNESS/A11Y/VISUAL/SMOKE/PERF) ID, if any. */
  readonly id: string | undefined;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Why it is a problem; defaults to "no focused/skipped tests". */
  readonly reason?: string;
}

const UNKNOWN_ALIAS =
  'unrecognized test identifier: import `test` (or `test as <alias>`) from tests/e2e/fixtures';

export const API_SCREEN_ID = 'AUTH-API';
export const HARNESS_DIR = 'tests/e2e/harness/';
export const QUALITY_DIR = 'tests/e2e/quality/';
/** Reserved non-AC test ID families → the only directory their tests may live in. */
export const RESERVED_FAMILIES: Readonly<Record<string, string>> = {
  HARNESS: HARNESS_DIR,
  A11Y: QUALITY_DIR,
  VISUAL: QUALITY_DIR,
  SMOKE: QUALITY_DIR,
  PERF: QUALITY_DIR,
};
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
  // QBANK-01 (M4.0) was retired by UX7-BANK (2026-11-01): docs/screens/questions-bank.md.
  'M4.0': ['QIMPORT-01'],
  'M5.0': ['QOV-01', 'QPLAY-01'],
  // QGEN-01 (M6.0) was retired by QGEN-RM (2026-11-02): docs/screens/questions-generation.md.
  'M7.0': ['HISTORY-01'],
  S0: ['WS-SHARE-01', 'WS-VIEW-01', 'WS-FORK-01'],
  // DOCSUM-SPEC (2026-10-29): full-text export, document summary, chapter notes.
  'DOCTXT.0': ['DOC-03'],
  'DOCSUM.0': ['DOCSUM-01'],
  'CHNOTE.0': ['CHNOTE-01'],
  // DOCVIEW-SPEC (2026-10-29) / DOCVIEW-PORT (2026-11-02): the DOC-02 / WS-VIEW-01 viewer layout —
  // docked outline panel, view modes, resizable and swappable split. It replaced DOC-02-AC06/AC10.
  'DOCVIEW.0': ['DOCVIEW-01'],
  // MOCK-SPEC (2026-11-01): mock exams, unified QuestionViewer range practice.
  'MOCK.0': ['MOCK-01'],
  'QVIEW.0': ['QVIEW-01'],
  // UX9-SPEC (2026-11-02): feedback batch — chapter redistribution, shared highlights, chapter note
  // reading tools, question PDF import two-pane layout, book-text search page, modal home dialogs.
  'UX9.0': ['CHREDIST-01', 'HILITE-01', 'CHNOTE-02', 'QIMPORT-02', 'SEARCH-02', 'HOMEDLG-01'],
  // ASK-SPEC (2026-11-01): ask the LLM, AI explanations and related passages after submission.
  'ASK.0': ['ASK-01'],
  'UX11-AI-DIRECT': ['UX11-AI-DIRECT'],
  'EXPL.0': ['AIEXPL-01'],
  'RELSRC.0': ['RELSRC-01'],
  // QSRC-SPEC (2026-11-04): question source preview ("문제 원문 보기").
  'QSRC.0': ['QSRC-01'],
  // RETRY-CORRECT (2026-11-04): `다시 풀기` only on questions whose last graded result is correct.
  'RETRY.0': ['RETRY-01'],
  // STEM-ITEMS (2026-11-05): stem item lists one per line in a 제시 항목 box (QPLAY-01-AC14).
  'STEM.0': ['QPLAY-01'],
  'UX11-STEM': ['UX11-STEM'],
  'UX10-UI.0': ['UX10-UI'],
  'UX10-DOC.0': ['UX10-DOC'],
  'UX10-AI.0': ['UX10-AI'],
  'UX10-QVIEW.0': ['UX10-QVIEW'],
  'UX10-PLAY.0': ['UX10-PLAY'],
  'UX10-HOME.0': ['UX10-HOME'],
  'UX11-RETURN': ['UX11-RETURN'],
  'UX12-PLAY.0': ['UX12-PLAY'],
  'UX12-HOME.0': ['UX12-HOME'],
  // UX12 HOME-4: the sticky 문서 N · 풀기 line and the single 문서 N menu (D-7).
  'UX12-HEADER.0': ['UX12-HEADER'],
  // UX12 HOME-5: the search and filter line under the sticky line (D-7).
  'UX12-FILTER.0': ['UX12-FILTER'],
  // UX12 HILITE-1 (2026-11-06): selection kept under the highlight menu, press again to close.
  'UX12-HILITE.0': ['UX12-HILITE'],
  // UX12 DESIGN-2: tooltip safe margin and closing a popper by pressing its trigger again.
  'UX12-DESIGN.0': ['UX12-POPPERS'],
  // UX12 EXTRACT-2 (2026-11-06): a draft question's source blocks are highlighted whole.
  'UX12-EXTRACT.0': ['UX12-EXTRACT'],
  'UX12-NUMBER.0': ['UX12-NUMBER'],
  // UX12 DESIGN-1: which buttons may drop the boundary, hover backgrounds, compact button rows.
  'UX12-CONTROLS.0': ['UX12-CONTROLS'],
  // UX12 EXPL-1 (2026-11-06): AI 해설 toolbar, shared disclosure heading, 작성중... text.
  'UX12-EXPL.0': ['UX12-EXPL'],
  // UX12 EXPL-3 (2026-11-06): cancelling an AI explanation being made.
  'UX12-EXPLCANCEL.0': ['UX12-EXPLCANCEL'],
  // UX12 VIEW-2: option hover, result icons, study toggles without a fill, option line breaks.
  'UX12-OPTIONS.0': ['UX12-OPTIONS'],
  // UX12 HOME-2: no leftover AI buttons, notices or reasons where the LLM is off (D-14).
  'UX12-AIOFF.0': ['UX12-AIOFF'],
  // UX12 HOME-3: `AI에게 묻기` in the 본문 검색 page header.
  'UX12-SEARCHPAGE.0': ['UX12-SEARCHPAGE'],
  // UX12 ASK: the conversation list's FAB, the floating composer and the answer labels (D-10).
  'UX12-ASK.0': ['UX12-ASK'],
  // UX12 VIEW-1: sequence arrows, footer 다시 풀기·초기화, panel body back to the top.
  'UX12-VIEW.0': ['UX12-VIEW'],
  // UX12 VIEW-3: drag handle for the editor's options, multi-line option input.
  'UX12-QEDIT.0': ['UX12-QEDIT'],
  // UX12 VIEW-6: pending mark on page links; DOC-02 keeps its 404 (no loading boundary).
  'UX12-NAV.0': ['UX12-NAV'],
  // UX12 DESIGN-3: surfaces follow the finger and leave with inertia; the return bar swipes away.
  'UX12-GESTURE.0': ['UX12-GESTURE'],
  // UX12 EXTRACT-8 (2026-11-06): merged table cells in the document view.
  'UX12-SPANS.0': ['UX12-SPANS'],
  // UX12 EXTRACT-3..5 (2026-11-06): tables in stems and options shown as columns.
  'QTABLE.0': ['QTABLE-01'],
  // UX12 VIEW-4: `원문 보기` in the question panel's menu; the body button stays.
  'UX12-SRCMENU.0': ['UX12-SRCMENU'],
  // UX12 DESIGN-4 + SHELL-2: the themed glass gradient and the return bar's shape (D-3).
  'UX12-GLASS.0': ['UX12-GLASS'],
};

const LEADING_ID = new RegExp(
  `^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?-AC\\d+|(?:${Object.keys(RESERVED_FAMILIES).join('|')})-\\d+)\\b`,
);

/** The directory a reserved (non-AC) ID must live in; undefined for AC IDs. */
export function reservedDir(id: string): string | undefined {
  const family = /^([A-Z0-9]+)-\d+$/.exec(id)?.[1];
  return family === undefined ? undefined : RESERVED_FAMILIES[family];
}

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

const TEST_FNS = new Set(['test', 'setup']);
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);
const FOCUS_OR_SKIP = new Set(['only', 'skip', 'fixme']);

/** Literal text of a title argument; for `${}` templates only the leading literal part. */
function literalTitle(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

/**
 * Local names bound to a test function by an import: `import { test }`, `import { test as
 * sharingTest }` (fixtures/sharing.ts' extended test) or `import { setup }` — from any module
 * (tests/e2e/fixtures/*, @playwright/test).
 */
function testIdentifiers(source: ts.SourceFile): Set<string> {
  const names = new Set(TEST_FNS);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (TEST_FNS.has(imported)) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * Executable `test(...)` / `test.<modifier>(...)` / `setup(...)` calls with a literal title, found
 * with the TypeScript parser so commented-out code and string contents never count. Imported
 * aliases of `test`/`setup` count the same. `test.only/skip/fixme` and
 * `test.describe.only/skip/fixme` are reported as violations, and so is `<x>.describe(...)` on an
 * identifier that is not a known test function (an alias this parser cannot resolve would
 * otherwise drop its tests from the trace silently).
 */
export function parsePlaywrightTests(
  file: string,
  text: string,
): { tests: TestCase[]; violations: Violation[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const tests: TestCase[] = [];
  const violations: Violation[] = [];
  const fns = testIdentifiers(source);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let isTest = false;
      if (ts.isIdentifier(callee)) {
        isTest = fns.has(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        const modifier = callee.name.text;
        const target = callee.expression;
        // `<x>.describe(...)` / `<x>.describe.<m>(...)` on an unknown identifier.
        const describeOwner =
          modifier === 'describe'
            ? target
            : ts.isPropertyAccessExpression(target) && target.name.text === 'describe'
              ? target.expression
              : undefined;
        if (describeOwner && ts.isIdentifier(describeOwner) && !fns.has(describeOwner.text)) {
          violations.push({
            file,
            line: lineOf(callee),
            text: `${describeOwner.text}.describe`,
            reason: UNKNOWN_ALIAS,
          });
        }
        if (ts.isIdentifier(target) && fns.has(target.text) && TEST_MODIFIERS.has(modifier)) {
          isTest = true;
          if (FOCUS_OR_SKIP.has(modifier)) {
            violations.push({ file, line: lineOf(callee), text: `${target.text}.${modifier}` });
          }
        } else if (
          FOCUS_OR_SKIP.has(modifier) &&
          ts.isPropertyAccessExpression(target) &&
          target.name.text === 'describe' &&
          ts.isIdentifier(target.expression) &&
          fns.has(target.expression.text)
        ) {
          const text = `${target.expression.text}.describe.${modifier}`;
          violations.push({ file, line: lineOf(callee), text });
        }
      }
      const title = isTest ? literalTitle(node.arguments[0]) : undefined;
      if (title !== undefined) {
        tests.push({ file, line: lineOf(node), title, id: LEADING_ID.exec(title)?.[1] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { tests, violations };
}

/** Blank out triple-quoted strings (docstrings), keeping newlines so line numbers stay valid. */
function stripPythonStrings(text: string): string {
  return text.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** pytest functions whose name carries an AC ID, e.g. `test_ws_share_01_ac02_...` → WS-SHARE-01-AC02. */
export function parsePytestTests(file: string, text: string): TestCase[] {
  const out: TestCase[] = [];
  // Line-anchored `def`, so `# def test_...` comments never match; docstrings are blanked first.
  const code = stripPythonStrings(text);
  for (const m of code.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(test_\w+)[ \t]*\(/gm)) {
    const name = m[1] as string;
    const ac = /^test_([a-z0-9]+(?:_[a-z0-9]+)*?_ac\d+)(?:_|$)/.exec(name);
    if (!ac?.[1]) continue;
    out.push({
      file,
      line: lineAt(code, m.index),
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
    } else if (reservedDir(t.id) !== undefined) {
      const dir = reservedDir(t.id) as string;
      if (!t.file.startsWith(dir)) misplacedTests.push({ ...t, expected: dir });
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

/** Screens of the phases NOT listed (validated like `--phase`) that no listed phase includes. */
export function screensOutsidePhases(phases: readonly string[]): Set<string> {
  const kept = selectScreensOfPhases(phases);
  const outside = new Set<string>();
  for (const [phase, ids] of Object.entries(PHASES)) {
    if (phases.includes(phase)) continue;
    for (const id of ids) if (!kept.has(id)) outside.add(id);
  }
  return outside;
}

function selectScreensOfPhases(phases: readonly string[]): Set<string> {
  const selected = new Set<string>();
  for (const phase of phases) {
    const ids = PHASES[phase];
    if (!ids) throw new Error(`unknown phase ${phase} (known: ${Object.keys(PHASES).join(', ')})`);
    ids.forEach((id) => selected.add(id));
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
    if ((t.id && reservedDir(t.id) !== undefined) || (t.id && selected.has(screenOfAc(t.id)))) {
      problems.push(`misplaced test ${t.file}:${t.line} "${t.title}" (expected in ${t.expected})`);
    }
  }
  for (const t of report.orphanTests)
    problems.push(`orphan test ${t.file}:${t.line} "${t.title}": ${t.id} is not in the docs`);
  for (const t of report.untitledTests)
    problems.push(`untitled test ${t.file}:${t.line} "${t.title}": title must start with an AC ID`);
  for (const v of report.violations)
    problems.push(`${v.text} at ${v.file}:${v.line}: ${v.reason ?? 'no focused/skipped tests'}`);
  return problems;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  const acCount = report.screens
    .filter((s) => s.id !== API_SCREEN_ID)
    .reduce((n, s) => n + s.acs.length, 0);
  const api = report.screens.find((s) => s.id === API_SCREEN_ID);
  const harness = report.tests.filter((t) => t.id?.startsWith('HARNESS-')).length;
  const quality = report.tests.filter((t) => t.id && reservedDir(t.id) === QUALITY_DIR).length;
  lines.push(
    `e2e:trace: ${acCount} screen ACs in ${report.screens.length - (api ? 1 : 0)} screens` +
      (api ? ` + ${api.acs.length} API contract ACs` : '') +
      `; ${report.tests.length} tests (${harness} HARNESS, ${quality} quality)`,
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
    'Focused/skipped tests and unrecognized test identifiers',
    report.violations.map(
      (v) => `${v.file}:${v.line} ${v.text}${v.reason ? ` (${v.reason})` : ''}`,
    ),
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
  // Only files: a directory can match the pattern too (e.g. a snapshot folder named after a spec).
  for (const file of specs
    .filter((f) => statSync(join(root, f)).isFile())
    .map(toPosix)
    .sort()) {
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

/** One spec path per line, newline-terminated; the empty string for an empty list. */
export function formatSpecList(specs: readonly string[]): string {
  return [...new Set(specs)].map((spec) => `${spec}\n`).join('');
}

export function main(argv: readonly string[], root: string): number {
  const report = loadReport(root);
  const excludePhases = listArg(argv, '--exclude-phase');
  const selected =
    excludePhases === undefined
      ? selectScreens(report, listArg(argv, '--phase'), listArg(argv, '--screens'))
      : screensOutsidePhases(excludePhases);
  if (argv.includes('--list-specs')) {
    const specsOf = (ids: ReadonlySet<string>): string[] =>
      report.screens
        .filter((s) => ids.has(s.id) && s.testPath?.endsWith('.spec.ts'))
        .map((s) => s.testPath as string)
        .filter((path) => existsSync(join(root, path)));
    // Spec files of the selected screens that exist (CI passes them to / excludes them from
    // `playwright test`). With --exclude-phase a spec also declared by a listed phase stays in.
    const keep =
      excludePhases === undefined
        ? new Set<string>()
        : new Set(specsOf(selectScreensOfPhases(excludePhases)));
    const specs = specsOf(selected).filter((path) => !keep.has(path));
    // Zero bytes when nothing is selected: a blank line would become an empty Playwright filter
    // that matches every spec.
    process.stdout.write(formatSpecList(specs));
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
