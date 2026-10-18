// Unit tests for scripts/e2e-trace.ts (`node --test scripts/`; part of `make test`).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  analyze,
  formatSpecList,
  loadReport,
  parseApiContracts,
  parsePlaywrightTests,
  parsePytestTests,
  parseScreenSpec,
  PHASES,
  screensOutsidePhases,
  selectScreens,
  strictProblems,
} from './e2e-trace.ts';

const LOGIN_DOC = `# AUTH-01 — 로그인

**Route:** \`/login\`
**연계 E2E:** \`tests/e2e/auth/login.spec.ts\`

### AUTH-01-AC01

- text mentioning AUTH-01-AC09 is not a heading

### AUTH-01-AC02
`;

const AUTH_DOC = `## 6. Phases
- \`AUTH-API-AC09\` outside the section
## 7. Auth 필수 E2E 시나리오
- \`AUTH-01-AC01\`: browser
- \`AUTH-API-AC01\`: 401
- \`AUTH-API-AC02\`: 403
## 8. Next
- \`AUTH-API-AC07\`
`;

const parsedLogin = parseScreenSpec('docs/screens/auth-login.md', LOGIN_DOC);
assert.ok(parsedLogin);
const LOGIN = parsedLogin;
const API = parseApiContracts('docs/auth.md', AUTH_DOC);

describe('parsers', () => {
  it('reads screen ID, AC headings and the declared spec path', () => {
    assert.deepEqual(LOGIN, {
      id: 'AUTH-01',
      doc: 'docs/screens/auth-login.md',
      testPath: 'tests/e2e/auth/login.spec.ts',
      acs: ['AUTH-01-AC01', 'AUTH-01-AC02'],
    });
  });

  it('reads only AUTH-API IDs from auth.md §7', () => {
    assert.deepEqual(API.acs, ['AUTH-API-AC01', 'AUTH-API-AC02']);
    assert.equal(API.testPath, 'tests/integration/');
  });

  it('reads Playwright titles, leading IDs and focused/skipped calls', () => {
    const src = [
      "test('AUTH-01-AC01 redirects', async () => {});",
      'test(',
      '  "AUTH-01-AC02 signs in", { tag: "@infra" }, async () => {});',
      "test.describe('AUTH-01 group', () => {});",
      "test.skip('AUTH-01-AC03 later', async () => {});",
      "test('no id here', async () => { await test.step('AUTH-01-AC09 step', () => {}); });",
      "test('HARNESS-01 self check', () => {});",
      "test('A11Y-03 axe on a screen', () => {});",
    ].join('\n');
    const { tests, violations } = parsePlaywrightTests('tests/e2e/auth/login.spec.ts', src);
    assert.deepEqual(
      tests.map((t) => [t.line, t.id, t.title]),
      [
        [1, 'AUTH-01-AC01', 'AUTH-01-AC01 redirects'],
        [2, 'AUTH-01-AC02', 'AUTH-01-AC02 signs in'],
        [5, 'AUTH-01-AC03', 'AUTH-01-AC03 later'],
        [6, undefined, 'no id here'],
        [7, 'HARNESS-01', 'HARNESS-01 self check'],
        [8, 'A11Y-03', 'A11Y-03 axe on a screen'],
      ],
    );
    assert.deepEqual(
      violations.map((v) => [v.line, v.text]),
      [[5, 'test.skip']],
    );
  });

  it('follows imported aliases of test and flags describe on unknown identifiers', () => {
    const src = [
      "import { expect, test } from '../fixtures/test.ts';",
      "import { createShareLink, test as sharingTest } from '../fixtures/sharing.ts';",
      "test('SEARCH-01-AC06 workspace page', async () => {});",
      "sharingTest.describe('shared view', () => {",
      "  sharingTest('SEARCH-01-AC06 shared view', async () => {});",
      "  sharingTest.skip('SEARCH-01-AC07 later', async () => {});",
      '});',
      "other.describe('group', () => { other('SEARCH-01-AC08 invisible', () => {}); });",
      "other.describe.only('focused group', () => {});",
    ].join('\n');
    const { tests, violations } = parsePlaywrightTests('tests/e2e/search/search.spec.ts', src);
    assert.deepEqual(
      tests.map((t) => [t.line, t.id]),
      [
        [3, 'SEARCH-01-AC06'],
        [5, 'SEARCH-01-AC06'],
        [6, 'SEARCH-01-AC07'],
      ],
    );
    assert.deepEqual(
      violations.map((v) => [v.line, v.text, v.reason === undefined]),
      [
        [6, 'sharingTest.skip', true],
        [8, 'other.describe', false],
        [9, 'other.describe', false],
      ],
    );
  });

  it('maps pytest names with an AC ID and ignores the rest', () => {
    const src = [
      'def test_auth_api_ac01_missing_jwt_is_401(client):',
      'async def test_ws_share_01_ac02_revoked(client) -> None:',
      'def test_jwks_publishes_keys(stack):',
      'def helper_auth_api_ac03():',
    ].join('\n');
    assert.deepEqual(
      parsePytestTests('tests/integration/api/test_auth.py', src).map((t) => t.id),
      ['AUTH-API-AC01', 'WS-SHARE-01-AC02'],
    );
  });

  it('ignores commented-out and string-embedded Playwright declarations', () => {
    const src = [
      "// test('AUTH-01-AC01 line-commented', async () => {});",
      '/*',
      "test('AUTH-01-AC02 block-commented', async () => {});",
      "test.only('AUTH-01-AC03 block-commented focus', async () => {});",
      '*/',
      'const doc = "test(\'AUTH-01-AC04 inside a string\', () => {})";',
      "const tpl = `test.skip('AUTH-01-AC05 inside a template', () => {})`;",
      "test(`AUTH-01-AC06 template title ${'x'}`, async () => {});",
      'test(`AUTH-01-AC07 plain template`, async () => {});',
      "test.describe.only('group', () => {});",
    ].join('\n');
    const { tests, violations } = parsePlaywrightTests('tests/e2e/auth/login.spec.ts', src);
    assert.deepEqual(
      tests.map((t) => [t.line, t.id]),
      [
        [8, 'AUTH-01-AC06'],
        [9, 'AUTH-01-AC07'],
      ],
    );
    assert.deepEqual(
      violations.map((v) => [v.line, v.text]),
      [[10, 'test.describe.only']],
    );
  });

  it('ignores commented-out and docstring pytest defs', () => {
    const src = [
      '# def test_auth_api_ac01_commented(client):',
      'def helper():',
      '    """Example:',
      '    def test_auth_api_ac02_in_docstring(client):',
      '    """',
      "    '''",
      'def test_auth_api_ac03_in_single_quoted_block():',
      "    '''",
      'def test_auth_api_ac04_real(client):',
    ].join('\n');
    assert.deepEqual(
      parsePytestTests('tests/integration/api/test_auth.py', src).map((t) => [t.line, t.id]),
      [[9, 'AUTH-API-AC04']],
    );
  });
});

describe('--list-specs', () => {
  it('formats one path per line and nothing for an empty list', () => {
    assert.equal(formatSpecList([]), '');
    assert.equal(formatSpecList(['a.spec.ts', 'b.spec.ts', 'a.spec.ts']), 'a.spec.ts\nb.spec.ts\n');
  });

  it('prints zero bytes for the harness-only phase', () => {
    const stdout = execFileSync(
      process.execPath,
      [join(import.meta.dirname, 'e2e-trace.ts'), '--list-specs', '--phase', 'P0.10'],
      { encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  });

  it('--exclude-phase lists the specs of the other phases only', () => {
    const list = (phases: string): string[] =>
      execFileSync(
        process.execPath,
        [join(import.meta.dirname, 'e2e-trace.ts'), '--list-specs', '--exclude-phase', phases],
        { encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
    const all = Object.keys(PHASES).join(',');
    assert.deepEqual(list(all), []);
    const withoutS0 = list(
      Object.keys(PHASES)
        .filter((p) => p !== 'S0')
        .join(','),
    );
    assert.ok(withoutS0.includes('tests/e2e/workspaces/fork.spec.ts'));
    assert.ok(!withoutS0.includes('tests/e2e/auth/login.spec.ts'));
    assert.ok(list('P0.10').includes('tests/e2e/auth/login.spec.ts'));
  });

  it('screensOutsidePhases validates phases and never drops a listed screen', () => {
    assert.throws(() => screensOutsidePhases(['M9.0']), /unknown phase/);
    const outside = screensOutsidePhases(['A0']);
    assert.ok(!outside.has('AUTH-01'));
    assert.ok(outside.has('WS-01'));
  });
});

describe('analyze + strict', () => {
  const tests = [
    { file: 'tests/e2e/auth/login.spec.ts', line: 1, title: 'AUTH-01-AC01 a', id: 'AUTH-01-AC01' },
    { file: 'tests/e2e/auth/other.spec.ts', line: 1, title: 'AUTH-01-AC02 b', id: 'AUTH-01-AC02' },
    { file: 'tests/integration/api/test_a.py', line: 1, title: 'x', id: 'AUTH-API-AC01' },
    { file: 'tests/integration/api/test_b.py', line: 1, title: 'y', id: 'AUTH-01-AC01' },
    {
      file: 'tests/e2e/auth/login.spec.ts',
      line: 5,
      title: 'AUTH-API-AC01 f',
      id: 'AUTH-API-AC01',
    },
    { file: 'tests/e2e/auth/login.spec.ts', line: 9, title: 'QOV-01-AC99 c', id: 'QOV-01-AC99' },
    { file: 'tests/e2e/harness/app.spec.ts', line: 1, title: 'HARNESS-01 d', id: 'HARNESS-01' },
    { file: 'tests/e2e/auth/login.spec.ts', line: 3, title: 'HARNESS-02 e', id: 'HARNESS-02' },
    { file: 'tests/e2e/quality/a11y.spec.ts', line: 1, title: 'A11Y-01 g', id: 'A11Y-01' },
    { file: 'tests/e2e/harness/app.spec.ts', line: 7, title: 'VISUAL-01 h', id: 'VISUAL-01' },
  ];
  const report = analyze([LOGIN, API], tests, []);

  it('finds orphan ACs, orphan tests and misplaced tests', () => {
    assert.deepEqual(report.orphanAcs, ['AUTH-API-AC02']);
    assert.deepEqual(
      report.orphanTests.map((t) => t.id),
      ['QOV-01-AC99'],
    );
    assert.deepEqual(
      report.misplacedTests.map((t) => [t.id, t.expected]),
      [
        ['AUTH-01-AC02', 'tests/e2e/auth/login.spec.ts'],
        ['AUTH-API-AC01', 'tests/integration/'],
        ['HARNESS-02', 'tests/e2e/harness/'],
        ['VISUAL-01', 'tests/e2e/quality/'],
      ],
    );
  });

  it('scopes AC problems to the selected screens but always reports unknown IDs', () => {
    const onlyLogin = strictProblems(report, selectScreens(report, [], ['AUTH-01']));
    assert.ok(onlyLogin.some((p) => p.includes('AUTH-01-AC02') && p.startsWith('misplaced')));
    assert.ok(onlyLogin.some((p) => p.includes('QOV-01-AC99')));
    assert.ok(!onlyLogin.some((p) => p.includes('AUTH-API-AC02')));
    const phaseA0 = strictProblems(report, selectScreens(report, ['A0'], []));
    assert.ok(phaseA0.some((p) => p === 'orphan AC AUTH-API-AC02: no test title starts with it'));
  });

  it('selects all screens without flags and none for the harness phase', () => {
    assert.deepEqual([...selectScreens(report, undefined, undefined)], ['AUTH-01', 'AUTH-API']);
    const harnessOnly = selectScreens(report, ['P0.10'], undefined);
    assert.equal(harnessOnly.size, 0);
    const problems = strictProblems(report, harnessOnly);
    assert.ok(problems.every((p) => !p.startsWith('orphan AC')));
    assert.ok(problems.some((p) => p.includes('QOV-01-AC99')));
  });

  it('rejects unknown phases and screens', () => {
    assert.throws(() => selectScreens(report, ['M9.0'], []), /unknown phase/);
    assert.throws(() => selectScreens(report, [], ['NOPE-01']), /unknown screen/);
  });
});

describe('repository docs', () => {
  it('declares 96 screen ACs (95 + M7.4b SEARCH-01-AC06), 21 screens with a spec path, and 3 API ACs', () => {
    const report = loadReport(join(import.meta.dirname, '..'));
    const screens = report.screens.filter((s) => s.id !== 'AUTH-API');
    assert.equal(screens.length, 21);
    assert.equal(
      screens.reduce((n, s) => n + s.acs.length, 0),
      96,
    );
    assert.ok(screens.every((s) => s.testPath?.startsWith('tests/e2e/')));
    assert.deepEqual(report.screens.find((s) => s.id === 'AUTH-API')?.acs, [
      'AUTH-API-AC01',
      'AUTH-API-AC02',
      'AUTH-API-AC03',
    ]);
  });
});
