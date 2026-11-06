// CHMAN-01 (UX12 CHAPTER-5, CHAPTER-6): the panel's tree rules, its API and the home filter's tree.
import { describe, expect, it, vi } from 'vitest';
import {
  canAddChild,
  classifyChapterFailure,
  createChapterApi,
  depthOf,
  dropMove,
  MAX_LEVEL,
  rowMove,
  treeGroups,
  treePickerNodes,
  type ChapterTree,
  type TreeChapter,
} from '../src/lib/chapters/tree';
import { outlineChoiceNodes, WORKSPACE_CHAPTERS } from '../src/lib/questions/chapter-picker';

function chapter(id: string, parent: string | null, sort: number, level = 1): TreeChapter {
  return {
    id,
    parent_id: parent,
    section_key: id,
    title: id,
    level,
    sort_order: sort,
    page: null,
    question_count: 0,
    attached_question_count: 0,
    has_note: false,
    user_created: false,
  };
}

/** a > (a1, a2), b > b1 */
const TREE = [
  chapter('a', null, 0),
  chapter('a1', 'a', 1, 2),
  chapter('a2', 'a', 2, 2),
  chapter('b', null, 3),
  chapter('b1', 'b', 4, 2),
];

describe('rowMove', () => {
  it('moves among siblings', () => {
    expect(rowMove(TREE, 'a2', 'up')).toEqual({ chapter_id: 'a2', parent_id: 'a', position: 0 });
    expect(rowMove(TREE, 'a1', 'down')).toEqual({ chapter_id: 'a1', parent_id: 'a', position: 1 });
    expect(rowMove(TREE, 'a1', 'up')).toBeNull();
    expect(rowMove(TREE, 'a2', 'down')).toBeNull();
    expect(rowMove(TREE, 'a', 'up')).toBeNull();
  });

  it('indents under the previous sibling, as its last child', () => {
    expect(rowMove(TREE, 'a2', 'indent')).toEqual({
      chapter_id: 'a2',
      parent_id: 'a1',
      position: 0,
    });
    expect(rowMove(TREE, 'b', 'indent')).toEqual({ chapter_id: 'b', parent_id: 'a', position: 2 });
    expect(rowMove(TREE, 'a', 'indent')).toBeNull();
  });

  it('outdents to right after the parent', () => {
    expect(rowMove(TREE, 'a1', 'outdent')).toEqual({
      chapter_id: 'a1',
      parent_id: null,
      position: 1,
    });
    expect(rowMove(TREE, 'a', 'outdent')).toBeNull();
  });

  it('knows nothing of an unknown row', () => {
    expect(rowMove(TREE, 'x', 'up')).toBeNull();
  });
});

function chain(length: number): TreeChapter[] {
  return Array.from({ length }, (_, n) => chapter(`c${n}`, n === 0 ? null : `c${n - 1}`, n, n + 1));
}

describe('depth limit', () => {
  it('counts depth from parents, not stored levels', () => {
    expect(depthOf([chapter('a', null, 0), chapter('b', 'a', 1, 5)], 'b')).toBe(2);
  });

  it('refuses a move past 20 levels, counting the moved subtree', () => {
    const deep = [...chain(MAX_LEVEL), chapter('x', null, 30), chapter('y', 'x', 31, 2)];
    expect(dropMove(deep, 'x', `c${MAX_LEVEL - 3}`)).not.toBeNull();
    expect(dropMove(deep, 'x', `c${MAX_LEVEL - 2}`)).toBeNull();
    expect(dropMove(deep, 'y', `c${MAX_LEVEL - 2}`)).not.toBeNull();
    expect(dropMove(deep, 'y', `c${MAX_LEVEL - 1}`)).toBeNull();
    expect(canAddChild(deep, `c${MAX_LEVEL - 1}`)).toBe(false);
    expect(canAddChild(deep, `c${MAX_LEVEL - 2}`)).toBe(true);
  });

  it('does not offer an indent past the limit', () => {
    const deep = [...chain(MAX_LEVEL), chapter('s', `c${MAX_LEVEL - 2}`, 40, MAX_LEVEL)];
    expect(rowMove(deep, 's', 'indent')).toBeNull();
  });
});

describe('dropMove', () => {
  it('drops as the last child', () => {
    expect(dropMove(TREE, 'a1', 'b')).toEqual({ chapter_id: 'a1', parent_id: 'b', position: 1 });
  });

  it('refuses its own subtree and a drop on its parent', () => {
    expect(dropMove(TREE, 'a', 'a')).toBeNull();
    expect(dropMove(TREE, 'a', 'a1')).toBeNull();
    expect(dropMove(TREE, 'a1', 'a')).toBeNull();
  });
});

const CHAPTER_TREE: ChapterTree = {
  documents: [
    { document_id: 'd1', title: '교재 1', revision_id: 'r1', version: 3, chapters: TREE },
    { document_id: 'd2', title: '교재 2', revision_id: 'r2', version: 1, chapters: [] },
  ],
  workspace: { title: 'Workspace 챕터', version: 0, chapters: [] },
};

describe('treePickerNodes', () => {
  it('lists chapters at their depth without the excluded one', () => {
    expect(treePickerNodes(CHAPTER_TREE, 'a2').map((n) => [n.value, n.level])).toEqual([
      ['a', 1],
      ['a1', 2],
      ['b', 1],
      ['b1', 2],
    ]);
  });
});

describe('classifyChapterFailure', () => {
  const P = 'urn:quiz-workspace:problem:';
  it.each([
    [409, `${P}chapter-tree-changed`, 'changed'],
    [409, `${P}publish-in-progress`, 'publishing'],
    [422, `${P}chapter-tree-invalid`, 'invalid'],
    [422, `${P}chapter-invalid`, 'invalid'],
    [422, `${P}chapter-target-required`, 'targetRequired'],
    [403, `${P}workspace-archived`, 'readOnly'],
    [404, undefined, 'notFound'],
    [500, undefined, 'unavailable'],
  ])('%s %s', (status, type, kind) => {
    expect(classifyChapterFailure(status, { type })).toBe(kind);
  });
});

describe('createChapterApi', () => {
  function ok(body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  }

  it('sends a batch move with the version and the key', async () => {
    const fetchImpl = ok({ version: 4, chapters: [] });
    const api = createChapterApi('w1', fetchImpl as unknown as typeof fetch);
    const moves = [{ chapter_id: 'a', parent_id: null, position: 0 }];
    await expect(api.move('d1', 3, moves, 'key')).resolves.toEqual({
      ok: true,
      data: { version: 4, chapters: [] },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/documents/d1/chapters/tree');
    expect(JSON.parse(init.body as string)).toEqual({ expected_version: 3, moves });
    expect(init.headers).toMatchObject({ 'idempotency-key': 'key' });
  });

  it('names the target of a delete only when there is one', async () => {
    const fetchImpl = ok({ moved_questions: 0, version: 2 });
    const api = createChapterApi('w1', fetchImpl as unknown as typeof fetch);
    await api.remove('c1', null, 'k1');
    await api.remove('c1', 'none', 'k2');
    const urls = fetchImpl.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls).toEqual(['/api/chapters/c1', '/api/chapters/c1?move_questions_to=none']);
  });

  it('reports a network failure as unavailable', async () => {
    const api = createChapterApi('w1', (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);
    await expect(api.tree()).resolves.toEqual({ ok: false, kind: 'unavailable' });
  });
});

describe('outlineChoiceNodes', () => {
  const top = { id: 't', title: '1장' };

  it('nests a chapter under an ancestor without questions, as a heading', () => {
    expect(
      outlineChoiceNodes([
        { value: 'c1', title: '1.1', ancestors: [top] },
        { value: 'c2', title: '1.2', ancestors: [top] },
        { value: 'none', title: '챕터 없음', ancestors: [] },
      ]),
    ).toEqual([
      { value: 'ancestor:t', label: '1장', level: 1, group: true },
      { value: 'c1', label: '1.1', level: 2 },
      { value: 'c2', label: '1.2', level: 2 },
      { value: 'none', label: '챕터 없음', level: 1 },
    ]);
  });

  it('keeps an ancestor with its own questions choosable', () => {
    expect(
      outlineChoiceNodes([
        { value: 't', title: '1장', ancestors: [] },
        { value: 'c1', title: '1.1', ancestors: [top] },
      ]),
    ).toEqual([
      { value: 't', label: '1장', level: 1 },
      { value: 'c1', label: '1.1', level: 2 },
    ]);
  });
});

describe('Workspace chapters (UX12-CHAPTERADD)', () => {
  const workspace = { title: 'Workspace 챕터', version: 4, chapters: [chapter('w', null, 0)] };

  it('is one more group when it has chapters', () => {
    const groups = treeGroups({ ...CHAPTER_TREE, workspace });
    expect(groups.map((d) => d.title)).toEqual(['교재 1', '교재 2', 'Workspace 챕터']);
    expect(groups[2]?.document_id).toBe(WORKSPACE_CHAPTERS);
    expect(groups[2]?.version).toBe(4);
  });

  it('stays away while a book offers a place and it is empty', () => {
    expect(treeGroups(CHAPTER_TREE).map((d) => d.title)).toEqual(['교재 1', '교재 2']);
  });

  it('is the place to add chapters without a book', () => {
    const groups = treeGroups({ documents: [], workspace: { ...workspace, chapters: [] } });
    expect(groups.map((d) => d.title)).toEqual(['Workspace 챕터']);
  });

  it('is offered to the question pickers', () => {
    const nodes = treePickerNodes({ ...CHAPTER_TREE, workspace });
    expect(nodes.at(-1)).toMatchObject({ value: 'w', triggerLabel: 'w (Workspace 챕터)' });
  });

  it('sends writes to the workspace routes', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}');
    }) as typeof fetch;
    const api = createChapterApi('ws', fetchImpl);
    await api.create(WORKSPACE_CHAPTERS, null, '장', 'k1');
    await api.move(WORKSPACE_CHAPTERS, 4, [], 'k2');
    await api.createNear('c1', '장', 'k3');
    expect(seen).toEqual([
      {
        url: '/api/workspaces/ws/chapters',
        body: { document_id: null, parent_id: null, title: '장' },
      },
      { url: '/api/workspaces/ws/chapters/tree', body: { expected_version: 4, moves: [] } },
      { url: '/api/workspaces/ws/chapters', body: { title: '장', near_chapter_id: 'c1' } },
    ]);
  });
});
