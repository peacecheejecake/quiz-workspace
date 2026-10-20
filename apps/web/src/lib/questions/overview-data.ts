// QOV-01 first render (Server Component): the caller's heatmap under the URL filters, through the
// server-side Bearer helper. Reading the overview never records a view (M5.1); only opening a
// practice session does. Unknown/foreign workspaces never get here (the layout answered 404).
import type { Schemas } from '@quiz/api-client';
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  EMPTY_OVERVIEW_FILTERS,
  isOverviewFiltered,
  overviewApiQuery,
  type OverviewFilters,
} from './overview-filters';
import { findPlaced, type PlacedQuestion } from './overview-placement';
import { classifyQuestionFailure, type QuestionFailureKind } from './problems';

export type QuestionOverview = Schemas['QuestionOverview'];
export type OverviewItem = Schemas['OverviewItem'];
export type OverviewChapter = Schemas['OverviewChapter'];

export interface ChapterChoice {
  /** Chapter id, or `'none'` for the "챕터 없음" group. */
  readonly value: string;
  readonly title: string;
}

export interface OverviewData {
  readonly overview: QuestionOverview;
  /** Chapter filter choices: every chapter group of the unfiltered heatmap. */
  readonly chapterChoices: readonly ChapterChoice[];
  /** Set when the heatmap could not be loaded (the screen shows a retryable error). */
  readonly failure: QuestionFailureKind | null;
  /**
   * The `?question=` deep link resolved without the filters (placed as in the unfiltered
   * heatmap) when the filtered list does not contain it, so the panel opens on reload/share.
   */
  readonly requested: PlacedQuestion | null;
}

const EMPTY: QuestionOverview = {
  counts: { total: 0, unseen: 0, viewed: 0, incorrect: 0, correct: 0, retry: 0, favorite: 0 },
  chapters: [],
  items: [],
};

export function overviewPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}`;
}

export function chapterChoices(chapters: readonly OverviewChapter[]): ChapterChoice[] {
  return chapters.map((c) => ({ value: c.id ?? 'none', title: c.title }));
}

export async function loadOverview(
  workspaceId: string,
  filters: OverviewFilters,
  questionId: string | null = null,
): Promise<OverviewData> {
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(loginRedirectPath(overviewPath(workspaceId)));
    }
    throw error;
  }
  const fetchOverview = (f: OverviewFilters) =>
    api
      .GET('/api/v1/workspaces/{workspace_id}/questions/overview', {
        params: { path: { workspace_id: workspaceId }, query: overviewApiQuery(f) },
      })
      .catch(() => null);
  // The response's `chapters` only lists the groups left by the filters; the chapter picker
  // offers every group, so a filtered view also reads the unfiltered heatmap.
  const filtered = isOverviewFiltered(filters);
  const [result, unfiltered] = await Promise.all([
    fetchOverview(filters),
    filtered ? fetchOverview(EMPTY_OVERVIEW_FILTERS) : Promise.resolve(null),
  ]);

  let failure: QuestionFailureKind | null = null;
  if (!result) failure = 'unavailable';
  else if (!result.data)
    failure = classifyQuestionFailure(result.response.status, result.error).kind;
  if (failure === 'notFound') notFound();
  if (failure === 'unauthenticated') redirect(loginRedirectPath(overviewPath(workspaceId)));

  const overview = result?.data ?? EMPTY;
  const choices = chapterChoices(
    filtered ? (unfiltered?.data?.chapters ?? overview.chapters) : overview.chapters,
  );
  // A chapter chosen in the URL stays selectable even when the unfiltered read failed.
  if (filters.chapter && !choices.some((c) => c.value === filters.chapter)) {
    const current = overview.chapters.find((c) => (c.id ?? 'none') === filters.chapter);
    choices.push({ value: filters.chapter, title: current?.title ?? '선택한 챕터' });
  }
  let requested: PlacedQuestion | null = null;
  if (questionId && !overview.items.some((i) => i.question_id === questionId)) {
    // Only a filtered list can miss an existing question; unfiltered, it is gone or foreign.
    const all = filtered ? unfiltered?.data : null;
    requested = all ? findPlaced(all, questionId) : null;
  }
  return { overview, chapterChoices: choices, failure, requested };
}
