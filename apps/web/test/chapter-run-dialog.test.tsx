// @vitest-environment jsdom
// UX12-CHAPTERRUN (docs/screens/ux12-chapter-run.md): the chapter 풀기 options dialog.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChapterRunDialog } from '@/components/questions/viewer/chapter-run-dialog';

const WS = '00000000-0000-4000-8000-0000000000aa';
const CHAPTER = '00000000-0000-4000-8000-0000000000bb';
const RUN = '00000000-0000-4000-8000-0000000000cc';
const TARGET = { id: CHAPTER, title: '1장 물의 순환' };

const fetchMock = vi.fn<typeof fetch>();

function created(): Response {
  return new Response(JSON.stringify({ id: RUN, workspace_id: WS }), { status: 201 });
}

function requestOf(call: number): { body: Record<string, unknown>; key: string | null } {
  const init = fetchMock.mock.calls[call]?.[1];
  return {
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    key: new Headers(init?.headers).get('idempotency-key'),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(overrides: { onClose?: () => void; onStarted?: (id: string) => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onStarted = overrides.onStarted ?? vi.fn();
  render(
    <ChapterRunDialog workspaceId={WS} target={TARGET} onClose={onClose} onStarted={onStarted} />,
  );
  return { onClose, onStarted, dialog: screen.getByRole('dialog', { name: '1장 물의 순환 풀기' }) };
}

it('UX12-CHAPTERRUN-AC02 offers only the two options, both off', () => {
  const { dialog } = open();
  const boxes = within(dialog).getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  for (const box of boxes) expect(box).not.toBeChecked();
  expect(within(dialog).getByRole('checkbox', { name: '보기 섞기' })).toBeInTheDocument();
  expect(within(dialog).getByRole('checkbox', { name: '문제 순서 무작위' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: /모의고사 목록/ })).toBeNull();
});

it('UX12-CHAPTERRUN-AC02 취소 and Escape create nothing', async () => {
  const user = userEvent.setup();
  const { dialog, onClose } = open();
  await user.click(within(dialog).getByRole('button', { name: '취소' }));
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('UX12-CHAPTERRUN-AC03 asks for the chapter with no filters and the chosen options', async () => {
  fetchMock.mockResolvedValueOnce(created());
  const user = userEvent.setup();
  const { dialog, onStarted } = open();
  await user.click(within(dialog).getByRole('checkbox', { name: '보기 섞기' }));
  await user.click(within(dialog).getByRole('button', { name: '시작' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUN));
  expect(requestOf(0).body).toEqual({
    source: 'bank',
    range: { chapter_ids: [CHAPTER] },
    random_order: false,
    question_count: null,
    shuffle_options: true,
  });
});

it('UX12-CHAPTERRUN-AC02 shows a failure and retries with the same key', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(created());
  const user = userEvent.setup();
  const { dialog, onStarted } = open();
  await user.click(within(dialog).getByRole('button', { name: '시작' }));
  expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '시작' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUN));
  expect(requestOf(1).key).toBe(requestOf(0).key);
});

it('UX12-CHAPTERRUN-AC02 stays open while the request runs', async () => {
  let finish: (response: Response) => void = () => undefined;
  fetchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const user = userEvent.setup();
  const { dialog, onClose, onStarted } = open();
  await user.click(within(dialog).getByRole('button', { name: '시작' }));
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  finish(created());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUN));
});
