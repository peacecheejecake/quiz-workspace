// QGEN-01 first render (Server Component): the source question of `?source=`, its newest
// generation run and that run's drafts, so a reload shows the same review and registration
// state. Without a (valid) source it loads the workspace's CONFIRMED questions to pick one from.
// Unknown/foreign workspaces never get here (the workspace layout already answered 404).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import type { ImportDraft } from './drafts';
import type { Question, QuestionDetail } from './form';
import { classifyGenerationFailure, generatePath, type GenerationRun } from './generation-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many CONFIRMED questions the source picker lists. */
export const SOURCE_PICKER_LIMIT = 50;

export type GenerationScreenData =
  | {
      readonly kind: 'source';
      readonly source: QuestionDetail;
      readonly run: GenerationRun | null;
      readonly drafts: readonly ImportDraft[];
      /** The newest run or its drafts could not be loaded (the screen offers a reload). */
      readonly loadFailed: boolean;
    }
  | {
      readonly kind: 'pick';
      /** `?source=` named a question that does not exist here (or is not readable). */
      readonly sourceMissing: boolean;
      readonly candidates: readonly Question[];
      readonly loadFailed: boolean;
    };

export function sourceParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && UUID.test(raw) ? raw.toLowerCase() : null;
}

export async function loadGenerationScreen(
  workspaceId: string,
  sourceId: string | null,
): Promise<GenerationScreenData> {
  const returnTo = generatePath(workspaceId, sourceId);
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
  const kindOf = (status: number, body: unknown, { workspace = false } = {}) => {
    const kind = classifyGenerationFailure(status, body);
    if (kind === 'unauthenticated') redirect(loginRedirectPath(returnTo));
    if (kind === 'notFound' && workspace) notFound();
    return kind;
  };

  const pick = async (sourceMissing: boolean): Promise<GenerationScreenData> => {
    const list = await api
      .GET('/api/v1/workspaces/{workspace_id}/questions', {
        params: {
          path: { workspace_id: workspaceId },
          query: { publication_status: ['CONFIRMED'], limit: SOURCE_PICKER_LIMIT },
        },
      })
      .catch(() => null);
    if (!list?.data) {
      if (list) kindOf(list.response.status, list.error, { workspace: true });
      return { kind: 'pick', sourceMissing, candidates: [], loadFailed: true };
    }
    return { kind: 'pick', sourceMissing, candidates: list.data.items, loadFailed: false };
  };

  if (!sourceId) return pick(false);

  const question = await api
    .GET('/api/v1/questions/{question_id}', { params: { path: { question_id: sourceId } } })
    .catch(() => null);
  if (!question?.data) {
    const kind = question ? kindOf(question.response.status, question.error) : 'unavailable';
    if (kind !== 'notFound') {
      return { kind: 'pick', sourceMissing: false, candidates: [], loadFailed: true };
    }
    return pick(true);
  }
  // A question of another workspace is "not here", whatever the API allows the caller to read.
  if (question.data.workspace_id !== workspaceId) return pick(true);
  const source = question.data;

  const runs = await api
    .GET('/api/v1/workspaces/{workspace_id}/question-generations', {
      params: {
        path: { workspace_id: workspaceId },
        query: { source_question_id: source.id, limit: 1 },
      },
    })
    .catch(() => null);
  if (!runs?.data) {
    if (runs) kindOf(runs.response.status, runs.error, { workspace: true });
    return { kind: 'source', source, run: null, drafts: [], loadFailed: true };
  }
  const run = runs.data.items[0] ?? null;
  if (!run) return { kind: 'source', source, run: null, drafts: [], loadFailed: false };

  const drafts = await api
    .GET('/api/v1/question-generations/{generation_id}/drafts', {
      params: { path: { generation_id: run.id } },
    })
    .catch(() => null);
  if (!drafts?.data) {
    if (drafts) kindOf(drafts.response.status, drafts.error);
    return { kind: 'source', source, run, drafts: [], loadFailed: true };
  }
  return { kind: 'source', source, run, drafts: drafts.data.items, loadFailed: false };
}
