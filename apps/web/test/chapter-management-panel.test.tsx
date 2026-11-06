// @vitest-environment jsdom
// CHMAN-01: the 챕터 관리 panel against a fake relay: tree, row menu, delete confirmation, conflict.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChapterManagementPanel } from '../src/components/chapters/chapter-management-panel';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function node(id: string, title: string, sort: number, extra: object = {}) {
  return {
    id,
    parent_id: null,
    section_key: id,
    title,
    level: 1,
    sort_order: sort,
    page: 1,
    question_count: 0,
    attached_question_count: 0,
    has_note: false,
    user_created: false,
    ...extra,
  };
}

const TREE = {
  documents: [
    {
      document_id: 'd1',
      title: '교재',
      revision_id: 'r1',
      version: 7,
      chapters: [
        node(A, '1장', 0),
        node(B, '2장', 1, { question_count: 3, attached_question_count: 3, has_note: true }),
        node(C, '3장', 2, { attached_question_count: 2 }),
      ],
    },
  ],
};
const LIST = { items: [], chapters: [], targets: [] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function relay(writes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/chapter-tree')) return json(TREE);
    if (url.endsWith('/chapter-redistribution/questions')) return json(LIST);
    const write = writes[`${init.method} ${url}`];
    return write ? write() : json({}, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function mount(onChanged = vi.fn()) {
  render(
    <ChapterManagementPanel
      open
      onOpenChange={vi.fn()}
      container={null}
      workspaceId="w1"
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

async function chooseItem(user: ReturnType<typeof userEvent.setup>, chapter: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `${chapter} 챕터 메뉴` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChapterManagementPanel', () => {
  it('CHMAN-01-AC01 shows each book with question counts and a note mark', async () => {
    relay({});
    mount();
    const list = await screen.findByRole('list', { name: '교재 챕터' });
    expect(within(list).getByLabelText('3문제')).toBeTruthy();
    expect(within(list).getByText('노트')).toBeTruthy();
  });

  it('CHMAN-01-AC04 disables what the row cannot do and sends the version with a move', async () => {
    const calls = relay({
      'POST /api/documents/d1/chapters/tree': () => json({ version: 8, chapters: [] }),
    });
    const onChanged = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '1장 챕터 메뉴' }));
    expect((await screen.findByRole('menuitem', { name: '위로' })).dataset.disabled).toBe('');
    await user.keyboard('{Escape}');

    await chooseItem(user, '2장', '위로');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const move = calls.find((c) => c.url.endsWith('/chapters/tree'));
    expect(JSON.parse(move?.init.body as string)).toEqual({
      expected_version: 7,
      moves: [{ chapter_id: B, parent_id: null, position: 0 }],
    });
  });

  it('CHMAN-01-AC05 says so when the tree changed and tells the home nothing', async () => {
    relay({
      'POST /api/documents/d1/chapters/tree': () =>
        json({ type: 'urn:quiz-workspace:problem:chapter-tree-changed' }, 409),
    });
    const onChanged = mount();
    const user = userEvent.setup();
    await chooseItem(user, '2장', '위로');
    expect((await screen.findByRole('alert')).textContent).toContain('그 사이 챕터가 바뀌어');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('CHMAN-01-AC03 needs a target for a chapter with questions and warns about its note', async () => {
    relay({});
    mount();
    const user = userEvent.setup();
    await chooseItem(user, '2장', '삭제');
    const confirm = await screen.findByRole('region', { name: '2장을 삭제할까요?' });
    expect(within(confirm).getByText(/정리 노트는 더 이상 보이지 않습니다/)).toBeTruthy();
    expect(
      (within(confirm).getByRole('button', { name: '삭제' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('CHMAN-01-AC03 asks for a target when only drafts or archived questions are attached', async () => {
    relay({});
    mount();
    const user = userEvent.setup();
    await chooseItem(user, '3장', '삭제');
    const confirm = await screen.findByRole('region', { name: '3장을 삭제할까요?' });
    expect(within(confirm).getByText(/초안·보관 문제를 포함한 이 챕터의 문제 2개/)).toBeTruthy();
    expect(
      (within(confirm).getByRole('button', { name: '삭제' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('CHMAN-01-AC03 shows the destination choice after chapter-target-required', async () => {
    relay({
      [`DELETE /api/chapters/${A}`]: () =>
        json({ type: 'urn:quiz-workspace:problem:chapter-target-required' }, 422),
    });
    mount();
    const user = userEvent.setup();
    await chooseItem(user, '1장', '삭제');
    const confirm = await screen.findByRole('region', { name: '1장을 삭제할까요?' });
    expect(within(confirm).queryByText('문제를 옮길 챕터')).toBeNull();
    await user.click(within(confirm).getByRole('button', { name: '삭제' }));
    expect(await within(confirm).findByText('문제를 옮길 챕터')).toBeTruthy();
    expect(
      (within(confirm).getByRole('button', { name: '삭제' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('CHMAN-01-AC03 deletes an empty chapter without a target', async () => {
    const calls = relay({
      [`DELETE /api/chapters/${A}`]: () => json({ moved_questions: 0, version: 8 }),
    });
    mount();
    const user = userEvent.setup();
    await chooseItem(user, '1장', '삭제');
    const confirm = await screen.findByRole('region', { name: '1장을 삭제할까요?' });
    await user.click(within(confirm).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(calls.some((c) => c.init.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('CHMAN-01-AC02 adds a chapter from the form', async () => {
    const calls = relay({
      'POST /api/workspaces/w1/chapters': () =>
        json({ chapter: node('c', '새 장', 2), version: 8 }),
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '챕터 추가' }));
    await user.type(await screen.findByRole('textbox', { name: '챕터 이름' }), '  새 장 ');
    await user.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '챕터 이름' })).toBeNull());
    const create = calls.find((c) => c.url.endsWith('/w1/chapters'));
    expect(JSON.parse(create?.init.body as string)).toEqual({
      document_id: 'd1',
      parent_id: null,
      title: '새 장',
    });
  });
});

describe('without a book', () => {
  it('explains that chapters need a book', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => json(url.endsWith('/chapter-tree') ? { documents: [] } : LIST)),
    );
    mount();
    expect(await screen.findByText(/챕터를 관리할 교재가 없습니다/)).toBeTruthy();
  });
});
