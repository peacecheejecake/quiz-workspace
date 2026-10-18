// Server-only plumbing shared by the QBANK-01 loader and server actions: every call goes through the
// Bearer helper (the access token never reaches the browser) and FastAPI decides what is allowed.
import type { ApiClient } from '@quiz/api-client';
import { redirect } from 'next/navigation';
import { createServerApiClient, NotAuthenticatedError } from '@/lib/api/server';
import { loginRedirectPath } from '@/lib/auth/routes';
import { classifyQuestionFailure, type QuestionFailure } from './problems';

export type ApiOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: QuestionFailure };

/** Runs one API call; a signed-out session or a 401 sends the browser to /login (→ `returnTo`). */
export async function callQuestionApi<T>(
  returnTo: string,
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ApiOutcome<T>> {
  let outcome: ApiOutcome<T>;
  try {
    const api = await createServerApiClient();
    const { data, error, response } = await call(api);
    outcome = response.ok
      ? { ok: true, data: data as T }
      : { ok: false, failure: classifyQuestionFailure(response.status, error) };
  } catch (error) {
    outcome = {
      ok: false,
      failure: { kind: error instanceof NotAuthenticatedError ? 'unauthenticated' : 'unavailable' },
    };
  }
  // redirect() throws, so it stays outside the try block.
  if (!outcome.ok && outcome.failure.kind === 'unauthenticated') {
    redirect(loginRedirectPath(returnTo));
  }
  return outcome;
}

export function bankPath(workspaceId: string): string {
  return `/workspaces/${workspaceId}/questions/bank`;
}

// ---------------------------------------------------------------------------------------------
// Chapters (document outline) and source documents
// ---------------------------------------------------------------------------------------------

export interface ChapterOption {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly documentId: string;
  readonly documentTitle: string;
}

export interface DocumentOption {
  readonly id: string;
  readonly title: string;
}

interface OutlineNode {
  readonly id: string;
  readonly title: string;
  readonly level?: number;
  readonly children?: readonly OutlineNode[];
}

// `GET /documents/{id}/outline` (M3.4, fixtures/documents.ts A3: `{items: OutlineNode[]}`) is not
// in the generated client yet. Until it is, it is called untyped and a missing route simply
// yields no chapters. Remove this cast once `make contracts` includes the route.
type UntypedGet = (
  path: string,
  init: { params: { path: Record<string, string> } },
) => Promise<{ data?: unknown; response: Response }>;

function outlineNodes(body: unknown): OutlineNode[] {
  const items = (body as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: OutlineNode[] = [];
  const walk = (nodes: readonly unknown[], depth: number) => {
    for (const raw of nodes) {
      if (typeof raw !== 'object' || raw === null) continue;
      const node = raw as Record<string, unknown>;
      if (typeof node.id !== 'string' || typeof node.title !== 'string') continue;
      out.push({
        id: node.id,
        title: node.title.trim(),
        level: typeof node.level === 'number' ? node.level : depth,
      });
      if (Array.isArray(node.children)) walk(node.children, depth + 1);
    }
  };
  walk(items, 1);
  return out;
}

/**
 * Source documents (ready books) and the chapter picker: the outline nodes of each ready book's
 * current revision (the API only accepts chapters of a document's active revision). Failures
 * degrade to empty lists; the bank itself still loads.
 */
export async function loadChapterContext(
  api: ApiClient,
  workspaceId: string,
): Promise<{ chapters: ChapterOption[]; documents: DocumentOption[] }> {
  try {
    const { data } = await api.GET('/api/v1/workspaces/{workspace_id}/documents', {
      params: { path: { workspace_id: workspaceId }, query: { document_type: 'book' } },
    });
    const documents = (data?.items ?? [])
      .filter((d) => d.status === 'ready')
      .map((d) => ({ id: d.id, title: d.title || d.filename }));
    const get = api.GET as unknown as UntypedGet;
    const outlines = await Promise.all(
      documents.map(async (doc) => {
        try {
          const { data: body, response } = await get('/api/v1/documents/{document_id}/outline', {
            params: { path: { document_id: doc.id } },
          });
          return response.ok ? outlineNodes(body).map((n) => ({ ...n, doc })) : [];
        } catch {
          return [];
        }
      }),
    );
    const chapters = outlines.flat().map(({ id, title, level, doc }) => ({
      id,
      title,
      level: level ?? 1,
      documentId: doc.id,
      documentTitle: doc.title,
    }));
    return { chapters, documents };
  } catch {
    return { chapters: [], documents: [] };
  }
}
