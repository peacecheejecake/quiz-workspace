// CHMAN-01 챕터 관리 (docs/screens/chapter-management.md): the panel's pure tree rules, which mirror
// `quiz_api.chapter_tree` so the screen disables what the server would refuse, and its browser API.
// Calls go to this app's own `/api/...` relay routes; FastAPI decides everything.
import type { Schemas } from '@quiz/api-client';
import type { ChapterPickerNode } from '@quiz/ui';
import { chapterPickerNodes, WORKSPACE_CHAPTERS } from '@/lib/questions/chapter-picker';

export type ChapterTree = Schemas['ChapterTree'];
export type TreeDocument = Schemas['TreeDocument'];
export type TreeChapter = Schemas['TreeChapter'];
export type ChapterMove = Schemas['ChapterMove'];
export type ChapterWrite = Schemas['ChapterWrite'];
export type ChapterTreeResult = Schemas['ChapterTreeResult'];
export type ChapterDeleteResult = Schemas['ChapterDeleteResult'];

export const MAX_LEVEL = 20;
/** `move_questions_to` for "챕터 없음". */
export const NO_CHAPTER_TARGET = 'none';

export type RowAction = 'up' | 'down' | 'indent' | 'outdent';

function childrenOf(chapters: readonly TreeChapter[], parent: string | null): TreeChapter[] {
  return chapters.filter((c) => c.parent_id === parent);
}

function byId(chapters: readonly TreeChapter[], id: string): TreeChapter | undefined {
  return chapters.find((c) => c.id === id);
}

/** 1 at the top level. Stored levels may have gaps until the first edit, so parents decide. */
export function depthOf(chapters: readonly TreeChapter[], id: string): number {
  let depth = 0;
  let node = byId(chapters, id);
  while (node) {
    depth += 1;
    node = node.parent_id === null ? undefined : byId(chapters, node.parent_id);
  }
  return depth;
}

/** Levels the chapter's subtree spans, itself included. */
function subtreeHeight(chapters: readonly TreeChapter[], id: string): number {
  const below = childrenOf(chapters, id).map((c) => subtreeHeight(chapters, c.id));
  return 1 + Math.max(0, ...below);
}

function fitsUnder(chapters: readonly TreeChapter[], id: string, parent: string): boolean {
  return depthOf(chapters, parent) + subtreeHeight(chapters, id) <= MAX_LEVEL;
}

function isWithin(chapters: readonly TreeChapter[], node: string, root: string): boolean {
  let current = byId(chapters, node);
  while (current) {
    if (current.id === root) return true;
    current = current.parent_id === null ? undefined : byId(chapters, current.parent_id);
  }
  return false;
}

/** The move a row's 위로·아래로·들여쓰기·내어쓰기 sends, or null when it cannot be done. */
export function rowMove(
  chapters: readonly TreeChapter[],
  id: string,
  action: RowAction,
): ChapterMove | null {
  const chapter = byId(chapters, id);
  if (!chapter) return null;
  const siblings = childrenOf(chapters, chapter.parent_id);
  const index = siblings.findIndex((c) => c.id === id);
  switch (action) {
    case 'up':
      return index > 0
        ? { chapter_id: id, parent_id: chapter.parent_id, position: index - 1 }
        : null;
    case 'down':
      return index < siblings.length - 1
        ? { chapter_id: id, parent_id: chapter.parent_id, position: index + 1 }
        : null;
    case 'indent': {
      const previous = siblings[index - 1];
      if (!previous || !fitsUnder(chapters, id, previous.id)) return null;
      return {
        chapter_id: id,
        parent_id: previous.id,
        position: childrenOf(chapters, previous.id).length,
      };
    }
    case 'outdent': {
      if (chapter.parent_id === null) return null;
      const parent = byId(chapters, chapter.parent_id);
      if (!parent) return null;
      const uncles = childrenOf(chapters, parent.parent_id);
      return {
        chapter_id: id,
        parent_id: parent.parent_id,
        position: uncles.findIndex((c) => c.id === parent.id) + 1,
      };
    }
  }
}

/** A drop on another row: the last child of it. Null when the tree would break or nothing moves. */
export function dropMove(
  chapters: readonly TreeChapter[],
  id: string,
  target: string,
): ChapterMove | null {
  const chapter = byId(chapters, id);
  if (!chapter || !byId(chapters, target) || chapter.parent_id === target) return null;
  if (isWithin(chapters, target, id) || !fitsUnder(chapters, id, target)) return null;
  return { chapter_id: id, parent_id: target, position: childrenOf(chapters, target).length };
}

/** `canAddChild`: a new chapter under this one stays within the depth limit. */
export function canAddChild(chapters: readonly TreeChapter[], id: string): boolean {
  return depthOf(chapters, id) < MAX_LEVEL;
}

/**
 * The panel's groups: each book, then the Workspace chapters as one more group when there are some
 * or no book offers a place to add one (UX12-CHAPTERADD).
 */
export function treeGroups(tree: ChapterTree): TreeDocument[] {
  const { workspace } = tree;
  if (tree.documents.length > 0 && workspace.chapters.length === 0) return tree.documents;
  return [
    ...tree.documents,
    {
      document_id: WORKSPACE_CHAPTERS,
      title: workspace.title,
      revision_id: '',
      version: workspace.version,
      chapters: workspace.chapters,
    },
  ];
}

/** Every book's chapters as a `ChapterPicker` tree, without `exclude`. */
export function treePickerNodes(
  tree: ChapterTree,
  exclude: string | null = null,
): ChapterPickerNode[] {
  return chapterPickerNodes(
    treeGroups(tree).flatMap((doc) =>
      doc.chapters
        .filter((c) => c.id !== exclude)
        .map((c) => ({
          id: c.id,
          title: c.title,
          level: depthOf(doc.chapters, c.id),
          documentId: doc.document_id,
          documentTitle: doc.title,
        })),
    ),
  );
}

export function documentOf(tree: ChapterTree, chapterId: string): TreeDocument | undefined {
  return treeGroups(tree).find((d) => d.chapters.some((c) => c.id === chapterId));
}

// --- browser API --------------------------------------------------------------------------------

const PROBLEM = 'urn:quiz-workspace:problem:';

export type ChapterFailureKind =
  'changed' | 'publishing' | 'invalid' | 'targetRequired' | 'readOnly' | 'notFound' | 'unavailable';

export const CHAPTER_FAILURE_MESSAGES: Readonly<Record<ChapterFailureKind, string>> = {
  changed: '그 사이 챕터가 바뀌어 저장하지 않았습니다. 목록을 다시 불러왔습니다.',
  publishing: '교정본을 발행하는 중입니다. 끝난 뒤 다시 시도해 주세요.',
  invalid: '그 위치로는 옮길 수 없습니다. 챕터는 20단계까지 만들 수 있습니다.',
  targetRequired: '이 챕터의 문제를 옮길 챕터를 골라 주세요.',
  readOnly: '이 Workspace는 편집할 수 없습니다.',
  notFound: '챕터를 찾을 수 없습니다. 목록을 다시 불러왔습니다.',
  unavailable: '챕터를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

export function classifyChapterFailure(status: number, body: unknown): ChapterFailureKind {
  const type =
    typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : undefined;
  if (type === `${PROBLEM}chapter-tree-changed`) return 'changed';
  if (type === `${PROBLEM}publish-in-progress`) return 'publishing';
  if (type === `${PROBLEM}chapter-tree-invalid` || type === `${PROBLEM}chapter-invalid`) {
    return 'invalid';
  }
  if (type === `${PROBLEM}chapter-target-required`) return 'targetRequired';
  if (status === 403) return 'readOnly';
  if (status === 404) return 'notFound';
  return 'unavailable';
}

export type ChapterResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: ChapterFailureKind };

export interface ChapterApi {
  tree(signal?: AbortSignal): Promise<ChapterResult<ChapterTree>>;
  create(
    documentId: string,
    parentId: string | null,
    title: string,
    key: string,
  ): Promise<ChapterResult<ChapterWrite>>;
  /** `새 챕터`: the server places it by the chapter chosen now. */
  createNear(
    nearChapterId: string | null,
    title: string,
    key: string,
  ): Promise<ChapterResult<ChapterWrite>>;
  rename(chapterId: string, title: string, key: string): Promise<ChapterResult<ChapterWrite>>;
  move(
    documentId: string,
    expectedVersion: number,
    moves: readonly ChapterMove[],
    key: string,
  ): Promise<ChapterResult<ChapterTreeResult>>;
  remove(
    chapterId: string,
    target: string | null,
    key: string,
  ): Promise<ChapterResult<ChapterDeleteResult>>;
}

export function createChapterApi(workspaceId: string, fetchImpl: typeof fetch = fetch): ChapterApi {
  async function call<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      key?: string;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<ChapterResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`/api${path}`, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: init.signal ?? null,
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
    if (!response.ok) return { ok: false, kind: classifyChapterFailure(response.status, body) };
    if (body === undefined) return { ok: false, kind: 'unavailable' };
    return { ok: true, data: body as T };
  }
  return {
    tree: (signal) => call(`/workspaces/${workspaceId}/chapter-tree`, { signal }),
    create: (documentId, parentId, title, key) =>
      call(`/workspaces/${workspaceId}/chapters`, {
        method: 'POST',
        key,
        body: {
          document_id: documentId === WORKSPACE_CHAPTERS ? null : documentId,
          parent_id: parentId,
          title,
        },
      }),
    createNear: (nearChapterId, title, key) =>
      call(`/workspaces/${workspaceId}/chapters`, {
        method: 'POST',
        key,
        body: { title, near_chapter_id: nearChapterId },
      }),
    rename: (chapterId, title, key) =>
      call(`/chapters/${chapterId}`, { method: 'PATCH', key, body: { title } }),
    move: (documentId, expectedVersion, moves, key) =>
      call(
        documentId === WORKSPACE_CHAPTERS
          ? `/workspaces/${workspaceId}/chapters/tree`
          : `/documents/${documentId}/chapters/tree`,
        {
          method: 'POST',
          key,
          body: { expected_version: expectedVersion, moves },
        },
      ),
    remove: (chapterId, target, key) =>
      call(
        `/chapters/${chapterId}${target === null ? '' : `?move_questions_to=${encodeURIComponent(target)}`}`,
        { method: 'DELETE', key },
      ),
  };
}
