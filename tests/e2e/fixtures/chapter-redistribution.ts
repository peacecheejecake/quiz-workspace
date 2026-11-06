// Chapter redistribution (CHREDIST-01) fixtures: API helpers for the list / preview / assignment
// endpoints, the import fixture whose question-paper chapter matches a book chapter, superuser
// reads of the history rows, and the CHREDIST-01 UI label contract. UX9.0 keeps every assumption
// about UX9-REDIST-B / UX9-REDIST-W in this header (mirrored by
// tests/integration/questions/chapter_redistribution/).
//
// Grounded in the docs (docs/screens/chapter-redistribution.md, docs/questions.md §14,
// docs/architecture.md §5–§6): routes GET /workspaces/{id}/chapter-redistribution/questions,
// POST /workspaces/{id}/chapter-redistribution/preview {question_ids | all: true,
// include_manual}, POST /workspaces/{id}/questions/chapter-assignments {source: manual |
// recommendation, items: [{question_id, chapter_id, expected_chapter_id}]} + Idempotency-Key;
// columns questions.chapter_source (manual | auto), chapter_set_by, chapter_set_at; table
// question_chapter_changes; activity `questions.chapters_reassigned`; problems insufficient-role,
// workspace-archived, chapter-changed (409, the changed question ids), question-not-confirmed,
// chapter-invalid (422), idempotency-key-reused (422); preview reasons source_in_book | matched and
// no-recommendation reasons no_source | no_source_chapter | no_match | ambiguous.
//
// NOT in the docs (UX9.0 assumptions, to confirm or change in UX9-REDIST-B):
//   R1 GET …/chapter-redistribution/questions → 200 {items: [{question_id, chapter_id,
//      question_number, question_type, label ("3번"), stem_preview, chapter_source}],
//      chapters: [{id: string|null, title}] (Heatmap order, "챕터 없음" last), targets:
//      [{document_id, document_title, chapters: [{id, title, depth}]}]} — no answers.
//   R2 POST …/preview → 200 {items: [{question_id, number_label, stem_preview, current_chapter:
//      {id, title}|null, recommended_chapter: {id, title}|null, reason}], unchanged: int,
//      no_recommendation: {no_source?, no_source_chapter?, no_match?, ambiguous?: int},
//      skipped_manual: int}.
//   R3 POST …/questions/chapter-assignments → 200 {moved: int, unchanged: int}; a 409
//      chapter-changed problem carries `question_ids: string[]`.
//   R4 GET /questions/{id} and the list API carry `chapter_source`.
//   R5 The import fixture (no new PDF): book-ko.pdf ("1장 물의 순환" / "2장 정수 처리") plus
//      questions-ko.pdf imported as a question paper; its only chapter is the paper's title
//      heading PAPER_CHAPTER, so drafts suggest no chapter (CHAPTER-MAP `no_match`) until the same
//      PDF is uploaded a second time as a *book* ("titled book"), whose chapter has exactly that
//      title (QIMPORT-01-AC08's trick). Suggestions are computed on read, so drafts registered
//      before the titled book are `auto` under "챕터 없음" and the redistribution preview then
//      recommends the titled book's chapter for them (`matched`, "문제지 장 제목과 일치").
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   `문제` menu item "챕터 재분배" after "중복 문제 정리" (editor-only: aria-disabled + the menu
//   reason text otherwise). Modal FloatingSidePanel (role=dialog, aria-modal="true") named
//   "챕터 재분배" with close button "챕터 재분배 닫기"; `?panel=chapter-redistribution`.
//   List step: the QuestionRangePicker (fixtures/range-picker.ts), rows carry the text badge
//   "직접 정함" for `manual`; combobox "옮길 챕터" (option "챕터 없음" first, then chapters by
//   document); button "이동 (n)" with reason texts "옮길 문제를 고르세요" / "옮길 챕터를
//   고르세요" (aria-describedby); checkbox "직접 정한 챕터도 다시 추천"; button "자동 추천 보기"
//   with the scope text "선택한 n문제" / "전체 문제". Empty: "옮길 확정 문제가 없습니다".
//   Preview step: back button/link "목록으로"; summary text "바뀔 문제 k개 · 그대로 u개 · 추천
//   없음 r개 · 직접 정한 챕터라 건너뜀 m개" (zero parts omitted); list "추천" with one listitem
//   per change holding a checkbox named "적용 …" (default checked), "현재: <장> → 추천: <장>" and
//   the reason text; tri-state checkbox "모두 적용"; button "선택한 추천 적용 (k)".
//   Confirm: alertdialog "문제 n개를 <챕터>로 옮길까요?" / "추천한 챕터로 문제 k개를 옮길까요?" with
//   button "옮기기"; status "문제 n개를 <챕터>로 옮겼습니다." / "문제 k개의 챕터를 추천대로
//   바꿨습니다."; conflict alert "그 사이 바뀐 문제가 있어 옮기지 않았습니다. 목록을 다시
//   불러왔습니다.".
import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
import type { ApiResponse } from './api.ts';
import { localDbAdminUrl } from './local-env.ts';
import { HOME_MENU_NAME, main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export const REDIST_PANEL = 'chapter-redistribution';
export const PAPER_CHAPTER = '제1회 합성 확인 평가 — 물의 순환과 정수 처리';

export const REDIST_PROBLEMS = {
  chapterChanged: 'urn:quiz-workspace:problem:chapter-changed',
  notConfirmed: 'urn:quiz-workspace:problem:question-not-confirmed',
  chapterInvalid: 'urn:quiz-workspace:problem:chapter-invalid',
  keyReused: 'urn:quiz-workspace:problem:idempotency-key-reused',
} as const;

export interface AssignmentItem {
  readonly question_id: string;
  readonly chapter_id: string | null;
  readonly expected_chapter_id: string | null;
}

export function redistributionList(member: Member, workspaceId: string): Promise<ApiResponse> {
  return member.api.request('GET', `/workspaces/${workspaceId}/chapter-redistribution/questions`);
}

export function redistributionPreview(
  member: Member,
  workspaceId: string,
  body: { question_ids?: readonly string[]; all?: true; include_manual: boolean },
): Promise<ApiResponse> {
  return member.api.request(
    'POST',
    `/workspaces/${workspaceId}/chapter-redistribution/preview`,
    body,
  );
}

export function assignChapters(
  member: Member,
  workspaceId: string,
  body: { source: 'manual' | 'recommendation'; items: readonly AssignmentItem[] },
  idempotencyKey?: string,
): Promise<ApiResponse> {
  return member.api.request(
    'POST',
    `/workspaces/${workspaceId}/questions/chapter-assignments`,
    body,
    idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  );
}

function psqlValue(sql: string): string {
  try {
    return execFileSync('psql', [localDbAdminUrl(), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? '';
    throw new Error(`redistribution fixture: psql failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

function uuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('redistribution fixture: invalid uuid');
  return `'${id}'`;
}

/** Superuser read: question_chapter_changes rows of a workspace (no API lists them). */
export function chapterChangeCount(workspaceId: string): number {
  return Number(
    psqlValue(
      `select count(*) from public.question_chapter_changes where workspace_id = ${uuid(workspaceId)}`,
    ),
  );
}

/** Superuser read: `questions.chapters_reassigned` activity rows of a workspace. */
export function reassignedActivityCount(workspaceId: string): number {
  return Number(
    psqlValue(
      `select count(*) from public.activity_events where workspace_id = ${uuid(workspaceId)} ` +
        `and event_type = 'questions.chapters_reassigned'`,
    ),
  );
}

/** Superuser read: number of revisions of a question (moving never adds one). */
export function revisionCount(questionId: string): number {
  return Number(
    psqlValue(
      `select count(*) from public.question_revisions where question_id = ${uuid(questionId)}`,
    ),
  );
}

/** Test-only: put questions back under "no chapter" (a book upload re-matches chapterless auto questions). */
export function clearQuestionChapters(questionIds: string[]): void {
  const ids = questionIds.map((id) => uuid(id)).join(', ');
  psqlValue(`update public.questions set chapter_id = null where id in (${ids}) returning id`);
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const redistUi = {
  menuItem: (page: Page) =>
    page
      .getByRole('menu', { name: HOME_MENU_NAME })
      .getByRole('menuitem', { name: /^(챕터 재분배|redistribute chapters)$/i }),
  dialog: (page: Page) =>
    page.getByRole('dialog', { name: /^(챕터 재분배|redistribute chapters)$/i }),
  close: (dialog: Locator) => dialog.getByRole('button', { name: /^(챕터 재분배 닫기|close)$/i }),
  loading: (dialog: Locator) => dialog.getByText(/문제를 불러오는 중입니다|loading questions/i),
  empty: (dialog: Locator) =>
    dialog.getByText(/옮길 확정 문제가 없습니다|no confirmed questions to move/i),
  manualBadge: (scope: Locator) => scope.getByText(/^(직접 정함|set by hand|manual)$/i),
  /** A question checkbox row by a unique stem fragment. */
  questionByStem: (dialog: Locator, stem: string) =>
    dialog.getByRole('checkbox', { name: new RegExp(`\\d+번 · .*${escape(stem)}`) }),
  /** The element holding a question row (checkbox + badge); `has` is relative to the row. */
  rowByStem: (dialog: Locator, stem: string) =>
    dialog
      .getByRole('listitem')
      .filter({
        has: dialog
          .page()
          .getByRole('checkbox', { name: new RegExp(`\\d+번 · .*${escape(stem)}`) }),
      })
      .last(),
  target: (dialog: Locator) => dialog.getByRole('combobox', { name: /^(옮길 챕터|move to)/i }),
  move: (dialog: Locator) => dialog.getByRole('button', { name: /^(이동|move)(\s*\(\d+\))?$/i }),
  moveCount: (n: number) => new RegExp(`^(이동|move)\\s*\\(${n}\\)$`, 'i'),
  pickQuestionsReason: (dialog: Locator) =>
    dialog.getByText(/옮길 문제를 고르세요|choose questions to move/i),
  pickChapterReason: (dialog: Locator) =>
    dialog.getByText(/옮길 챕터를 고르세요|choose a chapter/i),
  includeManual: (dialog: Locator) =>
    dialog.getByRole('checkbox', { name: /직접 정한 챕터도 다시 추천|include (manual|hand-set)/i }),
  recommend: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(자동 추천 보기|show recommendations)$/i }),
  allScope: (dialog: Locator) => dialog.getByText(/^(전체 문제|all questions)$/i),
  backToList: (dialog: Locator) =>
    dialog
      .getByRole('button', { name: /^(목록으로|back to (the )?list)$/i })
      .or(dialog.getByRole('link', { name: /^(목록으로|back to (the )?list)$/i }))
      .first(),
  computing: (dialog: Locator) => dialog.getByText(/추천을 계산하는 중입니다|computing/i),
  summary: (dialog: Locator) => dialog.getByText(/바뀔 문제\s*\d+개|\d+ to change/i),
  noChanges: (dialog: Locator) =>
    dialog.getByText(/추천과 다른 챕터의 문제가 없습니다|no question differs/i),
  previewRows: (dialog: Locator) =>
    dialog.getByRole('list', { name: /^(추천|recommendations)$/i }).getByRole('listitem'),
  previewRow: (dialog: Locator, stem: string) =>
    redistUi.previewRows(dialog).filter({ hasText: stem }),
  applyRow: (row: Locator) => row.getByRole('checkbox', { name: /^(적용|apply)/i }),
  applyAll: (dialog: Locator) => dialog.getByRole('checkbox', { name: /^(모두 적용|apply all)$/i }),
  applySelected: (dialog: Locator) =>
    dialog.getByRole('button', { name: /^(선택한 추천 적용|apply selected)(\s*\(\d+\))?$/i }),
  confirm: (page: Page) =>
    page.getByRole('alertdialog', {
      name: /문제 \d+개를 .+로 옮길까요|추천한 챕터로 문제 \d+개를 옮길까요|move \d+ questions?/i,
    }),
  confirmMove: (confirm: Locator) =>
    confirm.getByRole('button', { name: /^(옮기기|move|적용|apply)$/i }),
  moved: (page: Page) =>
    page
      .getByRole('status')
      .filter({ hasText: /문제 \d+개를 .+ 옮겼습니다|moved \d+ questions?/i }),
  applied: (page: Page) =>
    page
      .getByRole('status')
      .filter({ hasText: /문제 \d+개의 챕터를 추천대로 바꿨습니다|applied \d+ recommendations?/i }),
  conflict: (scope: Page | Locator) =>
    scope
      .getByRole('alert')
      .filter({ hasText: /그 사이 바뀐 문제가 있어 옮기지 않았습니다|changed in the meantime/i }),
  heatmapGroup: (page: Page, title: string) =>
    main(page)
      .getByRole('group', { name: /문제 heatmap|heatmap/i })
      .getByRole('region', { name: new RegExp(`^${escape(title)}`) }),
};

export function summaryText(parts: {
  change: number;
  unchanged?: number;
  none?: number;
  skipped?: number;
}): RegExp {
  const out = [`바뀔 문제 ${parts.change}개`];
  if (parts.unchanged) out.push(`그대로 ${parts.unchanged}개`);
  if (parts.none) out.push(`추천 없음 ${parts.none}개`);
  if (parts.skipped) out.push(`직접 정한 챕터라 건너뜀 ${parts.skipped}개`);
  return new RegExp(`^${out.map(escape).join('\\s*·\\s*')}$`);
}

/** Opens `문제` › `챕터 재분배` with the keyboard (Enter, arrows) and returns the dialog. */
export async function openRedistributionByKeyboard(page: Page): Promise<Locator> {
  const button = main(page).getByRole('button', { name: HOME_MENU_NAME });
  const item = redistUi.menuItem(page);
  // Right after a navigation the page may still be settling (hydration, a late history write):
  // a menu that lost its focus meanwhile is closed with Escape and opened again, keyboard only.
  await expect(async () => {
    if (!(await item.isVisible())) {
      await button.focus();
      await page.keyboard.press('Enter');
    }
    await expect(item).toBeVisible({ timeout: 2_000 });
    for (let i = 0; i < 8 && !(await item.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('ArrowDown');
    }
    if (!(await item.evaluate((el) => el === document.activeElement))) {
      await page.keyboard.press('Escape');
      throw new Error('챕터 재분배 is not focused yet');
    }
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press('Enter');
  const dialog = redistUi.dialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

// ---------------------------------------------------------------------------------------------
// Keyboard / modal helpers (also used by the CHNOTE-02 and HILITE-01 specs)
// ---------------------------------------------------------------------------------------------

/** Presses Tab `presses` times; focus must stay inside `dialog` every time (modal focus trap). */
export async function expectFocusTrapped(
  page: Page,
  dialog: Locator,
  presses: number,
  key: 'Tab' | 'Shift+Tab' = 'Tab',
): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key);
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      `focus stays in the dialog after ${key} ×${i + 1}`,
    ).toBe(true);
  }
}

/** Presses Tab until `target` has focus (at most `max` presses). */
export async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Chooses `option` in a focused select / combobox with the keyboard only. */
export async function keyboardChoose(page: Page, select: Locator, option: string): Promise<void> {
  await expect(select).toBeFocused();
  const native = (await select.evaluate((el) => el.tagName)) === 'SELECT';
  if (native) {
    for (let i = 0; i < 40; i++) {
      const text = await select.evaluate(
        (el) => (el as HTMLSelectElement).selectedOptions[0]?.text.trim() ?? '',
      );
      if (text.startsWith(option)) return;
      await page.keyboard.press('ArrowDown');
    }
    throw new Error('keyboardChoose: option not reached');
  }
  await page.keyboard.press('Enter');
  const target = page.getByRole('option', { name: new RegExp(`^\\s*${escape(option)}`) });
  await expect(target).toBeVisible();
  for (let i = 0; i < 40; i++) {
    const active = await target.evaluate(
      (el) => el === document.activeElement || el.getAttribute('data-highlighted') !== null,
    );
    if (active) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
}

/** Neither the page nor `scope` scrolls horizontally. */
export async function expectNoHorizontalScroll(page: Page, scope: Locator): Promise<void> {
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(pageOverflow, 'page has no horizontal scroll').toBeLessThanOrEqual(0);
  const own = await scope.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(own, 'panel has no horizontal scroll').toBeLessThanOrEqual(0);
}

/** Picks `option` in the `옮길 챕터` select (native select or a Radix listbox). */
export async function chooseTarget(page: Page, dialog: Locator, option: string): Promise<void> {
  const select = redistUi.target(dialog);
  if ((await select.evaluate((el) => el.tagName)) === 'SELECT') {
    const label = await select.evaluate(
      (el, text) =>
        [...(el as HTMLSelectElement).options].find((o) => o.text.trim().startsWith(text))?.text ??
        '',
      option,
    );
    await select.selectOption({ label });
  } else {
    await select.click();
    await page.getByRole('option', { name: new RegExp(`^\\s*${escape(option)}`) }).click();
  }
}
