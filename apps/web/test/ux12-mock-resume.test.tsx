// @vitest-environment jsdom
// UX12-MOCKRESUME (docs/screens/ux12-mock-resume.md): 이어 풀기 on a mock exam's row and detail.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MockExamsPanel } from '../src/components/questions/mock-exams/mock-exams-panel';
import { canResume, resumeLabel } from '../src/components/questions/mock-exams/mock-exam-model';

const RUN = { id: 'run', total: 10, answered: 3, next_position: 4 };
const EXAM = {
  id: 'exam',
  title: '시험',
  status: 'ready',
  question_count_current: 10,
  current_generation: { id: 'generation', version: 1 },
  latest_generation: null,
  config: { variation_types: ['OPTION_SHUFFLE'], question_count: 10 },
  range: { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] },
  created_at: '2026-01-01T00:00:00Z',
  unfinished_run: RUN,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeApi(exam: object = EXAM, overrides: object = {}) {
  return {
    list: vi.fn(async () => ({ ok: true, data: { items: [exam], llm_available: false } })),
    get: vi.fn(async () => ({ ok: true, data: exam })),
    questions: vi.fn(async () => ({ ok: true, data: [] })),
    unfinishedRuns: vi.fn(async () => ({ ok: true, data: [] })),
    dismissRun: vi.fn(async () => ({ ok: true, data: null })),
    ...overrides,
  };
}

function panel(api: object, props: object = {}) {
  return (
    <MockExamsPanel
      open
      onOpenChange={() => undefined}
      container={null}
      workspaceId="w"
      canEdit
      view={{ view: 'list' }}
      onViewChange={() => undefined}
      onPractise={() => undefined}
      onBankStarted={() => undefined}
      onResume={() => undefined}
      api={api as never}
      {...props}
    />
  );
}

const DETAIL = { view: { view: 'detail', mockExamId: 'exam' } };

it('UX12-MOCKRESUME-AC01 needs a run and a playable exam', () => {
  expect(resumeLabel(RUN)).toBe('이어 풀기 3/10');
  expect(canResume(EXAM as never)).toBe(true);
  expect(canResume({ ...EXAM, unfinished_run: null } as never)).toBe(false);
  expect(canResume({ ...EXAM, unfinished_run: undefined } as never)).toBe(false);
  expect(canResume({ ...EXAM, question_count_current: 0 } as never)).toBe(false);
});

it('UX12-MOCKRESUME-AC01 a row leads with 이어 풀기 and keeps 풀기 in its menu', async () => {
  const onPractise = vi.fn();
  render(panel(fakeApi(), { onPractise }));
  const button = await screen.findByRole('button', { name: '시험 이어 풀기 3/10' });
  expect(button).toHaveTextContent('이어 풀기 3/10');
  expect(screen.queryByRole('button', { name: '풀기' })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '시험 메뉴' }));
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual([
    '풀기',
    '이어 풀기 지우기',
    '이름 바꾸기',
    '설정 바꾸기',
    '삭제',
  ]);
  await user.click(screen.getByRole('menuitem', { name: '풀기' }));
  await waitFor(() => expect(onPractise).toHaveBeenCalledOnce());
});

it('UX12-MOCKRESUME-AC01 a row without a run keeps 풀기 as its button', async () => {
  render(panel(fakeApi({ ...EXAM, unfinished_run: null })));
  expect(await screen.findByRole('button', { name: '풀기' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /이어 풀기/ })).toBeNull();
});

it('UX12-MOCKRESUME-AC02 the detail shows one button and moves 풀기 to 더보기', async () => {
  const onPractise = vi.fn();
  render(panel(fakeApi(), { ...DETAIL, onPractise }));
  await screen.findByRole('button', { name: '이어 풀기 3/10' });
  expect(screen.queryByRole('button', { name: '풀기' })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '더보기' }));
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual([
    '풀기',
    '이어 풀기 지우기',
    '설정 바꾸기',
    '다시 만들기',
    '이름 바꾸기',
    '삭제',
  ]);
  await user.click(screen.getByRole('menuitem', { name: '풀기' }));
  await waitFor(() => expect(onPractise).toHaveBeenCalledOnce());
});

it('UX12-MOCKRESUME-AC02 a viewer gets the menu only for the run', async () => {
  render(panel(fakeApi(), { canEdit: false, ...DETAIL }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '더보기' }));
  const items = await screen.findAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['풀기', '이어 풀기 지우기']);
});

it('UX12-MOCKRESUME-AC03 이어 풀기 hands over the run and its next position', async () => {
  const onResume = vi.fn();
  render(panel(fakeApi(), { onResume }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '시험 이어 풀기 3/10' }));
  expect(onResume).toHaveBeenCalledWith('run', 4);
});

it('UX12-MOCKRESUME-AC03 the detail reads the exam again when the run closes', async () => {
  const api = fakeApi();
  const { rerender } = render(panel(api, { ...DETAIL, runOpen: true }));
  await screen.findByRole('button', { name: '이어 풀기 3/10' });
  api.get.mockResolvedValue({
    ok: true,
    data: { ...EXAM, unfinished_run: { ...RUN, answered: 4, next_position: 5 } },
  });
  rerender(panel(api, { ...DETAIL, runOpen: false }));
  expect(await screen.findByRole('button', { name: '이어 풀기 4/10' })).toBeEnabled();
});

it('UX12-MOCKRESUME-AC07 이어 풀기 지우기 drops the run and brings 풀기 back', async () => {
  const api = fakeApi();
  render(panel(api));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '시험 메뉴' }));
  api.list.mockResolvedValue({
    ok: true,
    data: { items: [{ ...EXAM, unfinished_run: null }], llm_available: false },
  });
  await user.click(await screen.findByRole('menuitem', { name: '이어 풀기 지우기' }));
  await waitFor(() => expect(api.dismissRun).toHaveBeenCalledWith('run'));
  const list = await screen.findByRole('list', { name: '모의고사 목록' });
  expect(await within(list).findByRole('button', { name: '풀기' })).toBeEnabled();
});

it('UX12-MOCKRESUME-AC07 a failed 지우기 says so on the detail', async () => {
  const api = fakeApi(EXAM, {
    dismissRun: async () => ({ ok: false, kind: 'unavailable', message: '지우지 못했습니다.' }),
  });
  render(panel(api, DETAIL));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '더보기' }));
  await user.click(await screen.findByRole('menuitem', { name: '이어 풀기 지우기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('지우지 못했습니다.');
  expect(screen.getByRole('button', { name: '이어 풀기 3/10' })).toBeEnabled();
});
