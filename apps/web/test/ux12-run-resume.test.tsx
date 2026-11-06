// @vitest-environment jsdom
// UX12-RESUME (docs/screens/ux12-run-resume.md): the 이어 풀기 group of the mock exam list.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MockExamsPanel } from '../src/components/questions/mock-exams/mock-exams-panel';
import {
  unfinishedRunName,
  unfinishedRunProgress,
} from '../src/components/questions/mock-exams/mock-exam-model';

const RUN = {
  id: 'run',
  total: 10,
  answered: 3,
  next_position: 4,
  chapter_title: null,
  created_at: '2026-11-06T00:00:00Z',
  last_touched_at: '2026-11-06T01:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeApi(runs: readonly object[], overrides: object = {}) {
  return {
    list: vi.fn(async () => ({ ok: true, data: { items: [], llm_available: false } })),
    unfinishedRuns: vi.fn(async () => ({ ok: true, data: runs })),
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
      canEdit={false}
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

const rows = async () =>
  within(await screen.findByRole('list', { name: '이어 풀기 목록' })).getAllByRole('listitem');

it('UX12-RESUME-AC01 names a run after its chapter, else 원본 풀이', () => {
  expect(unfinishedRunName(RUN)).toBe('원본 풀이');
  expect(unfinishedRunName({ ...RUN, chapter_title: '3장 물' })).toBe('3장 물');
  expect(unfinishedRunProgress(RUN)).toBe('3/10');
});

it('UX12-RESUME-AC01 shows a row for every viewer without counting it as a mock exam', async () => {
  render(panel(fakeApi([RUN])));
  const row = (await rows())[0] as HTMLElement;
  expect(row).toHaveTextContent('원본 풀이');
  expect(row).toHaveTextContent('3/10');
  expect(screen.getByText('모의고사 0개')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: '원본 풀이 이어 풀기' })).toBeEnabled();
});

it('UX12-RESUME-AC02 이어 풀기 hands over the run and its next position', async () => {
  const onResume = vi.fn();
  render(panel(fakeApi([RUN]), { onResume }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '원본 풀이 이어 풀기' }));
  expect(onResume).toHaveBeenCalledWith('run', 4);
});

it('UX12-RESUME-AC03 reads the list again when the run panel over it closes', async () => {
  const api = fakeApi([RUN]);
  const { rerender } = render(panel(api, { runOpen: true }));
  await rows();
  expect(api.unfinishedRuns).toHaveBeenCalledTimes(1);
  api.unfinishedRuns.mockResolvedValue({ ok: true, data: [{ ...RUN, answered: 4 }] });
  rerender(panel(api, { runOpen: false }));
  await waitFor(() => expect(screen.getByText(/4\/10/)).toBeInTheDocument());
  expect(api.unfinishedRuns).toHaveBeenCalledTimes(2);
  expect(api.list).toHaveBeenCalledTimes(2);
});

it('UX12-RESUME-AC03 reads the list again on a new opening', async () => {
  const api = fakeApi([RUN]);
  const { rerender } = render(panel(api));
  await rows();
  rerender(panel(api, { open: false }));
  rerender(panel(api, { open: true }));
  await waitFor(() => expect(api.unfinishedRuns).toHaveBeenCalledTimes(2));
});

it('UX12-RESUME-AC05 keeps the empty text away while runs load and while there are any', async () => {
  let answer: (value: object) => void = () => undefined;
  const unfinishedRuns = vi.fn(() => new Promise((resolve) => (answer = resolve)));
  render(panel(fakeApi([], { unfinishedRuns })));
  await waitFor(() => expect(unfinishedRuns).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve));
  expect(screen.queryByText('아직 모의고사가 없습니다.')).toBeNull();
  answer({ ok: true, data: [RUN] });
  await rows();
  expect(screen.queryByText('아직 모의고사가 없습니다.')).toBeNull();
});

it('UX12-RESUME-AC05 shows the empty text with no runs and no mock exams', async () => {
  render(panel(fakeApi([])));
  expect(await screen.findByText('아직 모의고사가 없습니다.')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: '이어 풀기 목록' })).toBeNull();
});

it('UX12-RESUME-AC06 지우기 takes the row out, for a viewer too', async () => {
  const api = fakeApi([RUN]);
  render(panel(api));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '원본 풀이 메뉴' }));
  await user.click(await screen.findByRole('menuitem', { name: '지우기' }));
  await waitFor(() => expect(api.dismissRun).toHaveBeenCalledWith('run'));
  await waitFor(() => expect(screen.queryByRole('list', { name: '이어 풀기 목록' })).toBeNull());
  expect(await screen.findByText('아직 모의고사가 없습니다.')).toBeInTheDocument();
});

it('UX12-RESUME-AC06 keeps the row and says so when 지우기 fails', async () => {
  const api = fakeApi([RUN], {
    dismissRun: async () => ({ ok: false, kind: 'unavailable', message: '지우지 못했습니다.' }),
  });
  render(panel(api));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '원본 풀이 메뉴' }));
  await user.click(await screen.findByRole('menuitem', { name: '지우기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('지우지 못했습니다.');
  expect(await rows()).toHaveLength(1);
});

it('UX12-RESUME-AC09 a failed read leaves the mock exam list and offers a retry', async () => {
  const unfinishedRuns = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '실패' })
    .mockResolvedValueOnce({ ok: true, data: [RUN] });
  render(panel(fakeApi([], { unfinishedRuns })));
  const user = userEvent.setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('이어 풀 문제를 불러오지 못했습니다');
  expect(screen.getByText('모의고사 0개')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await rows()).toHaveLength(1);
});

it('UX12-RESUME-AC03 polling a generating mock exam does not read the runs again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const generating = {
      id: 'exam',
      title: '시험',
      status: 'generating',
      question_count_current: 0,
      current_generation: null,
      latest_generation: { status: 'running', generated_count: 0, target_count: 1 },
      config: { variation_types: ['OPTION_SHUFFLE'], question_count: 1 },
      created_at: '2026-01-01T00:00:00Z',
    };
    const api = fakeApi([], {
      list: vi.fn(async () => ({ ok: true, data: { items: [generating], llm_available: false } })),
    });
    render(panel(api));
    await screen.findByRole('button', { name: '시험' });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(1));
    expect(api.unfinishedRuns).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
