// @vitest-environment jsdom
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RenameField } from '../src/components/questions/mock-exams/rename-field';

it('UX10-PLAY-AC06 puts save and cancel together below the input and keeps editing on failure', async () => {
  const user = userEvent.setup();
  const cancel = vi.fn();
  render(<RenameField initial="기존" onSave={async () => '저장 실패'} onCancel={cancel} />);
  const input = screen.getByRole('textbox', { name: '모의고사 이름' });
  const save = screen.getByRole('button', { name: '저장' });
  const cancelButton = screen.getByRole('button', { name: '취소' });
  expect(save.parentElement).toBe(cancelButton.parentElement);
  expect(save.parentElement).not.toBe(input.parentElement);
  await user.clear(input);
  await user.type(input, '새 이름');
  await user.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패');
  expect(input).toHaveValue('새 이름');
  expect(cancel).not.toHaveBeenCalled();
});

it('UX10-PLAY-AC06 prevents cancel during an in-flight save', async () => {
  const user = userEvent.setup();
  let finish!: (result: string | null) => void;
  const pending = new Promise<string | null>((resolve) => {
    finish = resolve;
  });
  const cancel = vi.fn();
  render(<RenameField initial="기존" onSave={() => pending} onCancel={cancel} />);
  const input = screen.getByRole('textbox', { name: '모의고사 이름' });
  await user.clear(input);
  await user.type(input, '새 이름');
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(screen.getByRole('button', { name: '취소' })).toBeDisabled();
  expect(input).toBeDisabled();
  finish('저장 실패');
  expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패');
  expect(cancel).not.toHaveBeenCalled();
});

it('UX10-PLAY-AC06 disables detail play during rename and restores it on cancel', async () => {
  const { MockExamDetail } =
    await import('../src/components/questions/mock-exams/mock-exam-detail');
  const { createRef } = await import('react');
  const exam = {
    id: 'exam',
    title: '시험',
    status: 'ready',
    question_count_current: 1,
    current_generation: { id: 'generation' },
    latest_generation: null,
    config: { variation_types: ['OPTION_SHUFFLE'], question_count: 1 },
    created_at: '2026-01-01T00:00:00Z',
  };
  const api = {
    get: async () => ({ ok: true, data: exam }),
    questions: async () => ({ ok: true, data: [] }),
  };
  const user = userEvent.setup();
  render(
    <MockExamDetail
      workspaceId="w"
      mockExamId="exam"
      api={api as never}
      canEdit
      llmAvailable={false}
      headingRef={createRef()}
      refreshKey={0}
      openSettings={false}
      onSettingsShown={() => undefined}
      onPractise={() => undefined}
      onResume={() => undefined}
      onDismissRun={() => undefined}
      dismissError={null}
      onBankSubmit={() => undefined}
      bankBusy={false}
      bankError={null}
      onRename={async () => null}
      onDelete={() => undefined}
      onChanged={() => undefined}
    />,
  );
  const play = await screen.findByRole('button', { name: '풀기' });
  expect(play).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '더보기' }));
  await user.click(await screen.findByRole('menuitem', { name: '이름 바꾸기' }));
  expect(await screen.findByRole('button', { name: '풀기' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '취소' }));
  expect(await screen.findByRole('button', { name: '풀기' })).toBeEnabled();
});

it('UX10-PLAY-AC06 disables only the renamed list row and keeps it disabled after failure', async () => {
  const { MockExamsPanel } =
    await import('../src/components/questions/mock-exams/mock-exams-panel');
  const base = {
    workspace_id: 'w',
    status: 'ready',
    question_count_current: 1,
    current_generation: { id: 'generation' },
    latest_generation: null,
    config: { variation_types: ['OPTION_SHUFFLE'], question_count: 1 },
    created_at: '2026-01-01T00:00:00Z',
  };
  const exams = [
    { ...base, id: 'one', title: '첫 시험' },
    { ...base, id: 'two', title: '둘째 시험' },
  ];
  const api = {
    list: async () => ({ ok: true, data: { items: exams, llm_available: false } }),
    rename: async () => ({ ok: false, message: '저장 실패' }),
    unfinishedRuns: async () => ({ ok: true, data: [] }),
  };
  const user = userEvent.setup();
  render(
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
    />,
  );
  await user.click(await screen.findByRole('button', { name: '첫 시험 메뉴' }));
  await user.click(await screen.findByRole('menuitem', { name: '이름 바꾸기' }));
  // The renamed row's title is its field (no start button); the other row's title still starts.
  expect(screen.queryByRole('button', { name: '첫 시험' })).toBeNull();
  expect(screen.getByRole('button', { name: '둘째 시험' })).toBeEnabled();
  const input = screen.getByRole('textbox', { name: '모의고사 이름' });
  await user.clear(input);
  await user.type(input, '변경');
  await user.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패');
  expect(screen.queryByRole('button', { name: '첫 시험' })).toBeNull();
  expect(screen.getByRole('button', { name: '둘째 시험' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '취소' }));
  expect(screen.getByRole('button', { name: '첫 시험' })).toBeEnabled();
});
