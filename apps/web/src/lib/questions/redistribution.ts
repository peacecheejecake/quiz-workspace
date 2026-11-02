// CHREDIST-01 챕터 재분배 (docs/screens/chapter-redistribution.md, docs/questions.md §14): the
// dialog's pure model (range groups with the "직접 정함" badge, the move counts, the preview
// summary) and its browser API. Calls go to this app's own `/api/...` relay routes, which attach
// the session's access token server-side; FastAPI decides everything (editors of an active
// workspace, the targets, the chapter each question still has). Unit-tested.
import type { Schemas } from '@quiz/api-client';
import type { RangeGroup } from '@/components/questions/viewer/range-model';
import { displayStem } from './display-stem';
import { NO_CHAPTER_KEY } from './overview-placement';

export type RedistributionList = Schemas['RedistributionList'];
export type RedistributionQuestion = Schemas['RedistributionQuestion'];
export type RedistributionPreview = Schemas['RedistributionPreview'];
export type RedistributionPreviewItem = Schemas['RedistributionPreviewItem'];
export type AssignmentResult = Schemas['ChapterAssignmentResult'];

export const NO_CHAPTER_TITLE = '챕터 없음';
/** The `옮길 챕터` value of "챕터 없음" (a Select value is never empty). */
export const NO_TARGET_CHAPTER = '__none__';
export const MANUAL_BADGE = '직접 정함';

export const REDIST_PROBLEMS = {
  chapterChanged: 'urn:quiz-workspace:problem:chapter-changed',
  notConfirmed: 'urn:quiz-workspace:problem:question-not-confirmed',
} as const;

/** "1장 3번"; a question without a chapter reads "챕터 없음 3번" (the list's own label). */
export function rowNumber(q: Pick<RedistributionQuestion, 'chapter_id' | 'label'>): string {
  return q.chapter_id === null ? `${NO_CHAPTER_TITLE} ${q.label}` : q.label;
}

function preview(text: string): string {
  return displayStem(text).replace(/\s+/g, ' ').trim();
}

/** The list as `QuestionRangePicker` groups, in the API's (Heatmap) order; `manual` rows badged. */
export function redistributionGroups(list: RedistributionList): RangeGroup[] {
  return list.chapters.map((chapter) => ({
    key: chapter.id ?? NO_CHAPTER_KEY,
    title: chapter.id === null ? NO_CHAPTER_TITLE : chapter.title,
    questions: list.items
      .filter((q) => q.chapter_id === chapter.id)
      .map((q) => ({
        id: q.question_id,
        number: rowNumber(q),
        preview: preview(q.stem_preview),
        type: q.question_type,
        ...(q.chapter_source === 'manual' ? { badge: MANUAL_BADGE } : {}),
      })),
  }));
}

export interface TargetOption {
  readonly value: string;
  readonly title: string;
  /** The document title, when several books offer chapters (disambiguates equal titles). */
  readonly documentTitle: string | null;
  readonly depth: number;
}

/** `옮길 챕터` options: "챕터 없음" first, then each book's chapters in outline order. */
export function targetOptions(list: RedistributionList): TargetOption[] {
  const several = list.targets.length > 1;
  return [
    { value: NO_TARGET_CHAPTER, title: NO_CHAPTER_TITLE, documentTitle: null, depth: 1 },
    ...list.targets.flatMap((doc) =>
      doc.chapters.map((c) => ({
        value: c.id,
        title: c.title,
        documentTitle: several ? doc.document_title : null,
        depth: c.depth,
      })),
    ),
  ];
}

export function targetChapterId(value: string): string | null {
  return value === NO_TARGET_CHAPTER ? null : value;
}

export interface AssignmentItem {
  readonly question_id: string;
  readonly chapter_id: string | null;
  readonly expected_chapter_id: string | null;
}

export interface MovePlan {
  /** The selected questions still listed. */
  readonly selected: number;
  /** Of them, already in the target chapter (not counted, not sent). */
  readonly already: number;
  readonly items: readonly AssignmentItem[];
}

/** The `이동 (n)` request: the selected questions not yet in `target` (null = no target yet). */
export function movePlan(
  list: RedistributionList,
  selected: ReadonlySet<string>,
  target: string | null,
): MovePlan {
  const picked = list.items.filter((q) => selected.has(q.question_id));
  if (target === null) return { selected: picked.length, already: 0, items: [] };
  const chapterId = targetChapterId(target);
  const moving = picked.filter((q) => q.chapter_id !== chapterId);
  return {
    selected: picked.length,
    already: picked.length - moving.length,
    items: moving.map((q) => ({
      question_id: q.question_id,
      chapter_id: chapterId,
      expected_chapter_id: q.chapter_id,
    })),
  };
}

/** The recommendation rows to apply (`적용` checked), as assignment items. */
export function applyItems(
  items: readonly RedistributionPreviewItem[],
  checked: ReadonlySet<string>,
): AssignmentItem[] {
  return items
    .filter((i) => checked.has(i.question_id))
    .map((i) => ({
      question_id: i.question_id,
      chapter_id: i.recommended_chapter.id,
      expected_chapter_id: i.current_chapter?.id ?? null,
    }));
}

export const NO_RECOMMENDATION_LABELS: Readonly<Record<string, string>> = {
  no_source: '출처가 없음',
  no_source_chapter: '출처의 장을 찾을 수 없음',
  no_match: '교재 장과 맞는 제목 없음',
  ambiguous: '맞는 장이 여럿',
};

export const REASON_LABELS: Readonly<Record<string, string>> = {
  source_in_book: '출처 교재의 장',
  matched: '문제지 장 제목과 일치',
};

export function noRecommendationCount(preview: RedistributionPreview): number {
  return Object.values(preview.no_recommendation).reduce((n, v) => n + v, 0);
}

/** "바뀔 문제 k개 · 그대로 u개 · 추천 없음 r개 · 직접 정한 챕터라 건너뜀 m개" (zero parts omitted). */
export function previewSummary(preview: RedistributionPreview): string {
  const parts = [`바뀔 문제 ${preview.items.length}개`];
  const none = noRecommendationCount(preview);
  if (preview.unchanged) parts.push(`그대로 ${preview.unchanged}개`);
  if (none) parts.push(`추천 없음 ${none}개`);
  if (preview.skipped_manual) parts.push(`직접 정한 챕터라 건너뜀 ${preview.skipped_manual}개`);
  return parts.join(' · ');
}

// --- browser API ---------------------------------------------------------------------------------

export type RedistFailureKind =
  'changed' | 'forbidden' | 'archived' | 'unauthenticated' | 'invalid' | 'unavailable';

export const REDIST_FAILURE_MESSAGES: Readonly<Record<RedistFailureKind, string>> = {
  changed: '그 사이 바뀐 문제가 있어 옮기지 않았습니다. 목록을 다시 불러왔습니다.',
  forbidden: '챕터를 옮길 권한이 없습니다.',
  archived: '보관된 Workspace는 읽기 전용입니다.',
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  invalid: '옮길 수 없는 챕터입니다. 목록을 다시 불러와 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export type RedistResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: RedistFailureKind };

export function classifyRedistFailure(status: number, body: unknown): RedistFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 401) return 'unauthenticated';
  if (status === 403) {
    return type === 'urn:quiz-workspace:problem:workspace-archived' ? 'archived' : 'forbidden';
  }
  // A question archived, deleted or moved meanwhile: the whole request was refused.
  if (status === 404) return 'changed';
  if (
    status === 409 &&
    (type === REDIST_PROBLEMS.chapterChanged || type === REDIST_PROBLEMS.notConfirmed)
  ) {
    return 'changed';
  }
  if (status === 422) return 'invalid';
  return 'unavailable';
}

type FetchLike = typeof fetch;

export interface RedistributionApi {
  list(signal?: AbortSignal): Promise<RedistResult<RedistributionList>>;
  preview(
    scope: readonly string[] | 'all',
    includeManual: boolean,
    signal?: AbortSignal,
  ): Promise<RedistResult<RedistributionPreview>>;
  assign(
    source: 'manual' | 'recommendation',
    items: readonly AssignmentItem[],
    key: string,
  ): Promise<RedistResult<AssignmentResult>>;
}

export function createRedistributionApi(
  workspaceId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): RedistributionApi {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  async function call<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; key?: string; signal?: AbortSignal } = {},
  ): Promise<RedistResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: init.signal,
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.key ? { 'idempotency-key': init.key } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      return { ok: false, kind: 'unavailable' };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) return { ok: false, kind: classifyRedistFailure(response.status, body) };
    if (body === undefined) return { ok: false, kind: 'unavailable' };
    return { ok: true, data: body as T };
  }
  return {
    list: (signal) => call('/chapter-redistribution/questions', { signal }),
    preview: (scope, includeManual, signal) =>
      call('/chapter-redistribution/preview', {
        method: 'POST',
        signal,
        body: {
          ...(scope === 'all' ? { all: true } : { question_ids: [...scope] }),
          include_manual: includeManual,
        },
      }),
    assign: (source, items, key) =>
      call('/questions/chapter-assignments', {
        method: 'POST',
        key,
        body: { source, items },
      }),
  };
}
