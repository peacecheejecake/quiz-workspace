// `QuestionRangePicker` locators shared by QVIEW-01 (practice-runs.ts, the range step of a run)
// and MOCK-01 (mock-exams.ts, the 범위 step of 만들기 / 설정 바꾸기): one component, one label
// contract (docs/screens/question-viewer.md "범위 고르기 단계").
//
//   checkbox "전체 선택" (aria-checked="mixed" when partly selected); one checkbox per chapter
//   named by the chapter title (+ count; "챕터 없음" for questions without a chapter) with its own
//   expand button "<장 제목> 펼치기" (aria-expanded); question checkboxes "1번 · <발문 앞부분> ·
//   <유형>"; the text "선택 n문제"; a collapsible "상태 필터" group
//   with the home chips (틀린 문제/오답, 다시 풀기, 즐겨찾기만, …) and "필터 초기화".
import { expect, type Locator } from '@playwright/test';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const chip = (group: Locator, name: RegExp) =>
  group.getByRole('button', { name }).or(group.getByRole('checkbox', { name }));

export const rangePickerUi = {
  selectAll: (scope: Locator) => scope.getByRole('checkbox', { name: /^(전체 선택|select all)$/i }),
  /** The chapter checkbox by title ("1장 물의 순환", "챕터 없음"), never by id. */
  chapter: (scope: Locator, title: string) =>
    scope.getByRole('checkbox', { name: new RegExp(`^${escape(title)}`) }),
  /** Chapter checkboxes ("1장 물의 순환 …"), not the question ones ("1번 · …"). */
  chapters: (scope: Locator) => scope.getByRole('checkbox', { name: /^\d+장 /i }),
  expand: (scope: Locator, title: string) =>
    scope.getByRole('button', {
      name: new RegExp(`${escape(title)}.*(펼치기|접기|expand|collapse)`, 'i'),
    }),
  /** A chapter's group: its chapter checkbox and, when expanded, its question rows. */
  group: (scope: Locator, title: string) =>
    scope.getByRole('listitem').filter({
      has: scope.page().getByRole('checkbox', { name: new RegExp(`^${escape(title)}`) }),
    }),
  /** Row "n번 · …" inside chapter `chapter`: printed numbers restart per chapter. */
  question: (scope: Locator, chapter: number, n: number) =>
    rangePickerUi
      .group(scope, `${chapter}장 `)
      .getByRole('checkbox', { name: new RegExp(`^${n}번 · `) }),
  questions: (scope: Locator) => scope.getByRole('checkbox', { name: /^\d+번 · / }),
  selected: (scope: Locator, n: number) =>
    scope.getByText(new RegExp(`선택 ${n}문제(?!\\d)|(?<!\\d)${n} selected`, 'i')),
  filterToggle: (scope: Locator) =>
    scope.getByRole('button', { name: /^(상태 필터|필터|status filter|filters?)$/i }),
  filters: (scope: Locator) =>
    scope.getByRole('group', { name: /^(상태 필터|필터|status filter|filters?)$/i }),
  incorrectFilter: (scope: Locator) =>
    chip(rangePickerUi.filters(scope), /^(틀린 문제|오답|incorrect)$/i),
  retryFilter: (scope: Locator) =>
    chip(rangePickerUi.filters(scope), /^(다시 풀기만?|retry( only)?)$/i),
  favoriteFilter: (scope: Locator) =>
    chip(rangePickerUi.filters(scope), /^(즐겨찾기만?|favou?rites?( only)?)$/i),
  resetFilters: (scope: Locator) =>
    scope.getByRole('button', { name: /^(필터 초기화|reset filters?|clear filters?)$/i }),
};

/** Expands the collapsible "상태 필터" group (no-op when it is open). */
export async function openRangeFilters(scope: Locator): Promise<Locator> {
  const toggle = rangePickerUi.filterToggle(scope);
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  const group = rangePickerUi.filters(scope);
  await expect(group).toBeVisible();
  return group;
}
