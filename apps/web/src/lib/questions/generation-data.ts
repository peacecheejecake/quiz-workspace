// QGEN-01 first render (Server Component): the source question of `?source=`, its recent
// generation runs, the selected run (`?run=`, else the newest) with its drafts and the source
// revision that run was generated from (the diff original), so a reload shows the same review and
// registration state and earlier runs' unregistered drafts stay reachable. Without a (valid) source it loads the workspace's CONFIRMED questions to pick one from.
// Unknown/foreign workspaces never get here (the workspace layout already answered 404).
import { notFound, redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import type { ImportDraft } from './drafts';
import type { Question, QuestionDetail } from './form';
import {
  batchPath,
  classifyGenerationFailure,
  generatePath,
  type GenerationBatch,
  type GenerationRun,
} from './generation-client';
import { RUN_HISTORY_LIMIT } from './generation-model';

export type SourceRevision = QuestionDetail['revision'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many CONFIRMED questions the source picker lists. */
export const SOURCE_PICKER_LIMIT = 50;

export type GenerationScreenData =
  | {
      readonly kind: 'source';
      readonly source: QuestionDetail;
      /** Recent runs of the source, newest first. */
      readonly runs: readonly GenerationRun[];
      /** The selected run (`?run=` when it is one of `runs`, else the newest). */
      readonly run: GenerationRun | null;
      /** The source revision `run` was generated from, when it is not the current one (null =
       * the current revision, or it could not be loaded: the screen loads it). */
      readonly runRevision: SourceRevision | null;
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

export function idParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && UUID.test(raw) ? raw.toLowerCase() : null;
}

export async function loadGenerationScreen(
  workspaceId: string,
  sourceId: string | null,
  runId: string | null = null,
): Promise<GenerationScreenData> {
  const returnTo = generatePath(workspaceId, sourceId, runId);
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

  // The run history is keyed by the requested id, so it loads alongside the question; it is only
  // used once the question turned out to be a question of this workspace.
  const [question, runs] = await Promise.all([
    api
      .GET('/api/v1/questions/{question_id}', { params: { path: { question_id: sourceId } } })
      .catch(() => null),
    api
      .GET('/api/v1/workspaces/{workspace_id}/question-generations', {
        params: {
          path: { workspace_id: workspaceId },
          query: { source_question_id: sourceId, limit: RUN_HISTORY_LIMIT },
        },
      })
      .catch(() => null),
  ]);
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

  const empty = {
    kind: 'source',
    source,
    runs: [],
    run: null,
    runRevision: null,
    drafts: [],
  } as const;
  if (!runs?.data) {
    if (runs) kindOf(runs.response.status, runs.error, { workspace: true });
    return { ...empty, loadFailed: true };
  }
  const list = runs.data.items;
  const run = list.find((r) => r.id === runId) ?? list[0] ?? null;
  if (!run) return { ...empty, loadFailed: false };

  const [drafts, pinned] = await Promise.all([
    api
      .GET('/api/v1/question-generations/{generation_id}/drafts', {
        params: { path: { generation_id: run.id } },
      })
      .catch(() => null),
    run.source_question_revision_id === source.revision.id
      ? null
      : api
          .GET('/api/v1/questions/{question_id}/revisions/{revision_id}', {
            params: {
              path: { question_id: source.id, revision_id: run.source_question_revision_id },
            },
          })
          .then((r) => r.data ?? null)
          .catch(() => null),
  ]);
  const base = { kind: 'source', source, runs: list, run, runRevision: pinned } as const;
  if (!drafts?.data) {
    if (drafts) kindOf(drafts.response.status, drafts.error);
    return { ...base, drafts: [], loadFailed: true };
  }
  return { ...base, drafts: drafts.data.items, loadFailed: false };
}

export interface GenerationBatchScreenData {
  readonly batch: GenerationBatch | null;
  readonly loadFailed: boolean;
}

/** QGEN-MULTI `?batch=`: the batch with its runs, one per source (null: not a batch here). */
export async function loadGenerationBatch(
  workspaceId: string,
  batchId: string,
): Promise<GenerationBatchScreenData> {
  const returnTo = batchPath(workspaceId, batchId);
  let api;
  try {
    api = await createServerApiClient();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect(loginRedirectPath(returnTo));
    throw error;
  }
  const res = await api
    .GET('/api/v1/workspaces/{workspace_id}/question-generation-batches/{batch_id}', {
      params: { path: { workspace_id: workspaceId, batch_id: batchId } },
    })
    .catch(() => null);
  if (res?.data) return { batch: res.data, loadFailed: false };
  const kind = res ? classifyGenerationFailure(res.response.status, res.error) : 'unavailable';
  if (kind === 'unauthenticated') redirect(loginRedirectPath(returnTo));
  return { batch: null, loadFailed: kind !== 'notFound' };
}
