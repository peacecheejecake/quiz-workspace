// QBANK-01 first render (Server Component): the first page of the bank under the URL filters plus
// the chapter picker and source documents. Unknown/foreign workspaces never get here (the
// workspace layout already answered 404).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { statusQuery, type BankFilters } from './filters';
import type { Question } from './form';
import { classifyQuestionFailure, type QuestionFailureKind } from './problems';
import { bankPath, loadChapterContext, type ChapterOption, type DocumentOption } from './server';

export const BANK_PAGE_SIZE = 50;

export interface BankData {
  readonly items: readonly Question[];
  readonly nextCursor: string | null;
  /** Set when the list could not be loaded (the screen shows a retryable error). */
  readonly failure: QuestionFailureKind | null;
  readonly chapters: readonly ChapterOption[];
  readonly documents: readonly DocumentOption[];
}

export async function loadBank(workspaceId: string, filters: BankFilters): Promise<BankData> {
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(bankPath(workspaceId)));
    throw error;
  }
  const [list, context] = await Promise.all([
    api
      .GET('/api/v1/workspaces/{workspace_id}/questions', {
        params: {
          path: { workspace_id: workspaceId },
          query: {
            publication_status: statusQuery(filters.status),
            limit: BANK_PAGE_SIZE,
            ...(filters.q ? { q: filters.q } : {}),
            ...(filters.type ? { question_type: filters.type } : {}),
            ...(filters.chapter ? { chapter_id: filters.chapter } : {}),
          },
        },
      })
      .catch(() => null),
    loadChapterContext(api, workspaceId),
  ]);

  let failure: QuestionFailureKind | null = null;
  if (!list) failure = 'unavailable';
  else if (!list.data) failure = classifyQuestionFailure(list.response.status, list.error).kind;
  if (failure === 'notFound') notFound();
  if (failure === 'unauthenticated') redirect(loginRedirectPath(bankPath(workspaceId)));

  return {
    items: list?.data?.items ?? [],
    nextCursor: list?.data?.next_cursor ?? null,
    failure,
    chapters: context.chapters,
    documents: context.documents,
  };
}
