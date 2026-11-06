// @vitest-environment jsdom
// UX12-MOCKNAV (docs/screens/ux12-mock-nav.md): the mock exam detail's 더보기 menu.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MockExamDetail } from '../src/components/questions/mock-exams/mock-exam-detail';
import { MockExamsPanel } from '../src/components/questions/mock-exams/mock-exams-panel';

const EXAM = {
  id: 'exam',
  title: '시험',
  status: 'ready',
  question_count_current: 1,
  current_generation: { id: 'generation' },
  latest_generation: null,
  config: { variation_types: ['OPTION_SHUFFLE'], question_count: 1 },
  range: { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] },
  created_at: '2026-01-01T00:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail(overrides: { canEdit?: boolean; exam?: object; onDelete?: () => void } = {}) {
  const data = overrides.exam ?? EXAM;
  const api = {
    get: async () => ({ ok: true, data }),
    questions: async () => ({ ok: true, data: [] }),
  };
  render(
    <MockExamDetail
      workspaceId="w"
      mockExamId="exam"
      api={api as never}
      canEdit={overrides.canEdit ?? true}
      llmAvailable={false}
      headingRef={createRef()}
      refreshKey={0}
      openSettings={false}
      onSettingsShown={() => undefined}
      onPractise={() => undefined}
      onBankSubmit={() => undefined}
      bankBusy={false}
      bankError={null}
      onRename={async () => null}
      onDelete={overrides.onDelete ?? (() => undefined)}
      onChanged={() => undefined}
    />,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  const more = await screen.findByRole('button', { name: '더보기' });
  await user.click(more);
  return more;
}

it('UX12-MOCKNAV-AC02 keeps 풀기 as the only action button and lists four menu items', async () => {
  const user = userEvent.setup();
  renderDetail();
  await openMenu(user);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    '설정 바꾸기',
    '다시 만들기',
    '이름 바꾸기',
    '삭제',
  ]);
  expect(screen.getByRole('button', { name: '풀기' })).toBeInTheDocument();
  for (const name of ['설정 바꾸기', '다시 만들기', '이름 바꾸기', '삭제']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
});

it('UX12-MOCKNAV-AC02 disables 설정 바꾸기 and 다시 만들기 while a round is being made', async () => {
  const user = userEvent.setup();
  renderDetail({
    exam: {
      ...EXAM,
      status: 'generating',
      latest_generation: { id: 'g', status: 'running', requested_count: 1, generated_count: 0 },
    },
  });
  await openMenu(user);
  for (const name of ['설정 바꾸기', '다시 만들기']) {
    expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
  }
  for (const name of ['이름 바꾸기', '삭제']) {
    expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true');
  }
});

it('UX12-MOCKNAV-AC02 returns focus to 더보기 after a cancelled rename and passes it to 삭제', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  renderDetail({ onDelete });
  const more = await openMenu(user);
  await user.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));
  await user.click(await screen.findByRole('button', { name: '취소' }));
  expect(more).toHaveFocus();

  await user.click(more);
  await user.click(screen.getByRole('menuitem', { name: '삭제' }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  expect(onDelete.mock.calls[0]).toEqual([expect.objectContaining({ id: 'exam' }), more]);
});

it('UX12-MOCKNAV-AC02 returns focus to 더보기 after a cancelled 설정 바꾸기', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ chapters: [], items: [], counts: {} }), { status: 200 }),
    ),
  );
  const user = userEvent.setup();
  renderDetail();
  await openMenu(user);
  await user.click(screen.getByRole('menuitem', { name: '설정 바꾸기' }));
  await user.click(await screen.findByRole('button', { name: '취소' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '더보기' })).toHaveFocus());
});

it('UX12-MOCKNAV-AC03 shows a viewer no 더보기', async () => {
  renderDetail({ canEdit: false });
  expect(await screen.findByRole('button', { name: '풀기' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '더보기' })).toBeNull();
});

function renderPanel(canEdit: boolean, view: { view: 'list' } | { view: 'create' }) {
  const onViewChange = vi.fn();
  const api = { list: async () => ({ ok: true, data: { items: [], llm_available: false } }) };
  render(
    <MockExamsPanel
      open
      onOpenChange={() => undefined}
      container={null}
      workspaceId="w"
      canEdit={canEdit}
      view={view}
      onViewChange={onViewChange}
      onPractise={() => undefined}
      onBankStarted={() => undefined}
      api={api as never}
    />,
  );
  return onViewChange;
}

it('UX12-MOCKNAV-AC05 shows 추가 without the hint on an empty list without edit rights', async () => {
  const user = userEvent.setup();
  const onViewChange = renderPanel(false, { view: 'list' });
  await user.click(await screen.findByRole('button', { name: '추가' }));
  expect(onViewChange).toHaveBeenCalledWith({ view: 'create' }, 'push');
  expect(screen.getByText('아직 모의고사가 없습니다.')).toBeInTheDocument();
  expect(screen.queryByText(/모의고사를 만드세요/)).toBeNull();
});

it('UX12-MOCKNAV-AC05 keeps the hint for editors', async () => {
  renderPanel(true, { view: 'list' });
  expect(await screen.findByRole('button', { name: '추가' })).toBeInTheDocument();
  expect(screen.getByText(/모의고사를 만드세요/)).toBeInTheDocument();
});

it('UX12-MOCKNAV-AC05 offers no variation in the form without edit rights', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chapters: [],
            items: [
              {
                question_id: '22222222-2222-4222-8222-000000000001',
                chapter_id: null,
                question_number: 1,
                question_type: 'MCQ',
                preview: '발문',
                status: 'unseen',
              },
            ],
            counts: {},
          }),
          { status: 200 },
        ),
    ),
  );
  renderPanel(false, { view: 'create' });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('checkbox', { name: '전체 선택' }));
  await user.click(screen.getByRole('button', { name: '다음' }));
  expect(screen.getByText('변형 출제에는 편집 권한이 필요합니다.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /보기 섞기/ })).toBeDisabled();
});
