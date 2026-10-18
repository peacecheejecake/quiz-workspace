// @vitest-environment jsdom
// QBANK-01 editor behaviour the E2E specs cannot observe: one Idempotency-Key per creation attempt
// (reused for retries of the same content, new after a content change or a success), field errors
// from client validation, and the stale-revision reload prompt on edit.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../src/lib/questions/actions';
import type { Question, QuestionDetail, QuestionFormValues } from '../src/lib/questions/form';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/x/questions/bank',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const createQuestionAction =
  vi.fn<(ws: string, values: unknown, key: unknown) => Promise<ActionResult<Question>>>();
const updateQuestionAction =
  vi.fn<
    (
      ws: string,
      id: string,
      base: string,
      values: unknown,
      baseSources: unknown,
    ) => Promise<ActionResult<Question>>
  >();
const getQuestionAction =
  vi.fn<(ws: string, id: string) => Promise<ActionResult<QuestionDetail>>>();
vi.mock('../src/lib/questions/actions', () => ({
  createQuestionAction: (...a: Parameters<typeof createQuestionAction>) =>
    createQuestionAction(...a),
  updateQuestionAction: (...a: Parameters<typeof updateQuestionAction>) =>
    updateQuestionAction(...a),
  getQuestionAction: (...a: Parameters<typeof getQuestionAction>) => getQuestionAction(...a),
}));

const { QuestionEditor } = await import('../src/components/questions/question-editor');

const WS = '55555555-5555-4555-8555-555555555555';
const REV1 = '11111111-1111-4111-8111-111111111111';
const REV2 = '11111111-1111-4111-8111-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

function question(revisionId: string, stem: string): Question {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    workspace_id: WS,
    question_type: 'MCQ',
    publication_status: 'CONFIRMED',
    origin: 'manual',
    chapter_id: null,
    chapter: null,
    question_number: null,
    revision: {
      id: revisionId,
      version: revisionId === REV1 ? 1 : 2,
      stem,
      options: [
        { id: 'a', text: '가' },
        { id: 'b', text: '나' },
      ],
      correct_option_ids: ['a'],
      accepted_answers: null,
      is_multi_answer: false,
      explanation: null,
      rubric: null,
      created_at: '2026-10-17T00:00:00Z',
    },
    sources: [],
    created_at: '2026-10-17T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
  };
}

const unavailable: ActionResult<Question> = {
  ok: false,
  kind: 'unavailable',
  message: '일시적인 오류로 처리하지 못했습니다.',
};

function Harness({ edit }: { edit?: Question }) {
  const [state, setState] = useState<{ open: boolean; session: number }>({
    open: false,
    session: 0,
  });
  return (
    <ToastProvider>
      <button
        type="button"
        onClick={() => setState((s) => ({ open: true, session: s.session + 1 }))}
      >
        열기
      </button>
      <QuestionEditor
        workspaceId={WS}
        target={state.open ? (edit ? { mode: 'edit', question: edit } : { mode: 'create' }) : null}
        session={state.session}
        onClose={() => setState((s) => ({ ...s, open: false }))}
        chapters={[]}
        documents={[]}
        onSaved={() => undefined}
      />
    </ToastProvider>
  );
}

async function fillValidMcq(user: ReturnType<typeof userEvent.setup>, stem: string) {
  await user.type(screen.getByRole('textbox', { name: '문제 내용' }), stem);
  await user.type(screen.getByRole('textbox', { name: '보기 1' }), '응결');
  await user.type(screen.getByRole('textbox', { name: '보기 2' }), '증발');
  await user.click(screen.getByRole('button', { name: '보기 4 삭제' }));
  await user.click(screen.getByRole('button', { name: '보기 3 삭제' }));
  await user.click(screen.getByRole('checkbox', { name: '보기 2 정답' }));
}

beforeEach(() => {
  createQuestionAction.mockReset();
  updateQuestionAction.mockReset();
  getQuestionAction.mockReset();
});

describe('QuestionEditor create', () => {
  it('blocks an MCQ without a correct option before calling the API', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await user.type(screen.getByRole('textbox', { name: '문제 내용' }), '문제');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('정답 보기를 선택해 주세요.');
    expect(createQuestionAction).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '보기 1' })).toHaveAccessibleDescription(
      /보기 1의 내용을 입력/,
    );
  });

  it('reuses the Idempotency-Key for retries and mints a new one after a change or success', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await fillValidMcq(user, '물이 기체로');

    createQuestionAction.mockResolvedValue(unavailable);
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
    expect(await screen.findByRole('alert')).toHaveTextContent('일시적인 오류');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(createQuestionAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
    const [first, second] = createQuestionAction.mock.calls.map((c) => c[2]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    const sent = createQuestionAction.mock.calls[0]?.[1] as QuestionFormValues;
    expect(sent.options.map((o) => o.text)).toEqual(['응결', '증발']);
    expect(sent.options.every((o) => /^opt-[a-z0-9]{12}$/.test(o.id))).toBe(true);

    await user.type(screen.getByRole('textbox', { name: '문제 내용' }), '?');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(createQuestionAction).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
    const third = createQuestionAction.mock.calls[2]?.[2];
    expect(third).not.toBe(first);
    // The same options keep their ids across attempts.
    const again = createQuestionAction.mock.calls[2]?.[1] as QuestionFormValues;
    expect(again.options.map((o) => o.id)).toEqual(sent.options.map((o) => o.id));

    createQuestionAction.mockResolvedValue({ ok: true, data: question(REV1, '물이 기체로?') });
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createQuestionAction.mock.calls[3]?.[2]).toBe(third);

    await user.click(screen.getByRole('button', { name: '열기' }));
    await fillValidMcq(user, '물이 기체로?');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(createQuestionAction).toHaveBeenCalledTimes(5));
    expect(createQuestionAction.mock.calls[4]?.[2]).not.toBe(third);
  });
});

describe('QuestionEditor edit', () => {
  it('offers to reload after a stale revision and saves on top of the new revision', async () => {
    const user = userEvent.setup();
    render(<Harness edit={question(REV1, '원래 문제')} />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(screen.getByRole('radio', { name: '객관식' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '문제 내용' }), ' 수정');

    updateQuestionAction.mockResolvedValueOnce({
      ok: false,
      kind: 'staleRevision',
      message: '다른 곳에서 이 문제가 먼저 수정되었습니다.',
    });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('먼저 수정되었습니다');
    expect(updateQuestionAction.mock.calls[0]?.[2]).toBe(REV1);
    expect(updateQuestionAction.mock.calls[0]?.[4]).toEqual([]);

    getQuestionAction.mockResolvedValueOnce({
      ok: true,
      data: {
        ...question(REV2, '다른 사람이 고친 문제'),
        sources: [{ document_id: DOC, document_revision_id: null, page_start: 4, page_end: 4 }],
        revisions: [],
      },
    });
    await user.click(screen.getByRole('button', { name: '최신 내용 불러오기' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '문제 내용' })).toHaveValue(
        '다른 사람이 고친 문제',
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();

    updateQuestionAction.mockResolvedValueOnce({ ok: true, data: question(REV2, 'x') });
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(updateQuestionAction).toHaveBeenCalledTimes(2));
    expect(updateQuestionAction.mock.calls[1]?.[2]).toBe(REV2);
    // The edit is now based on the reloaded sources (unchanged → the action omits them).
    expect(updateQuestionAction.mock.calls[1]?.[4]).toEqual([
      { document_id: DOC, page_start: 4, page_end: 4 },
    ]);
    const values = updateQuestionAction.mock.calls[1]?.[3] as QuestionFormValues;
    expect(values.options.map((o) => o.id)).toEqual(['a', 'b']);
  });
});
