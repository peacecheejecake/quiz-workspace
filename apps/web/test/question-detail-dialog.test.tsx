// @vitest-environment jsdom
// UX7-BANK-2 문제 상세 dialog (QPLAY-01-AC10): a past-revision preview follows the latest
// selection; a late response of an earlier selection never replaces it or shows its error.
import './dom-setup';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getQuestionAction = vi.fn();
const getQuestionRevisionAction = vi.fn();
vi.mock('../src/lib/questions/actions', () => ({
  getQuestionAction: (...a: unknown[]) => getQuestionAction(...a),
  getQuestionRevisionAction: (...a: unknown[]) => getQuestionRevisionAction(...a),
}));

const { QuestionDetailDialog } =
  await import('../src/components/questions/detail/question-detail-dialog');

const WS = '55555555-5555-4555-8555-555555555555';
const QID = '44444444-4444-4444-8444-000000000001';
const rev = (v: number) => `88888888-8888-4888-8888-00000000000${v}`;

function revision(v: number) {
  return {
    id: rev(v),
    version: v,
    stem: `버전 ${v} 본문`,
    options: [{ id: 'o1', text: '보기 하나' }],
    correct_option_ids: ['o1'],
    accepted_answers: null,
    is_multi_answer: false,
    explanation: null,
    rubric: null,
    created_at: '2026-10-17T00:00:00Z',
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (v: T) => resolve(v) };
}

beforeEach(() => {
  getQuestionRevisionAction.mockReset();
  getQuestionAction.mockReset();
  getQuestionAction.mockResolvedValue({
    ok: true,
    data: {
      id: QID,
      workspace_id: WS,
      question_type: 'MCQ',
      publication_status: 'CONFIRMED',
      chapter_id: null,
      chapter: null,
      question_number: 1,
      revision: revision(3),
      sources: [],
      revisions: [3, 2, 1].map((v) => ({
        id: rev(v),
        version: v,
        created_at: '2026-10-17T00:00:00Z',
      })),
    },
  });
});

async function chooseOneThenTwo(first: unknown) {
  const user = userEvent.setup();
  const v1 = deferred<unknown>();
  const v2 = deferred<unknown>();
  getQuestionRevisionAction.mockImplementation((_ws: string, _q: string, id: string) =>
    id === rev(1) ? v1.promise : v2.promise,
  );
  render(
    <QuestionDetailDialog
      workspaceId={WS}
      target={{ questionId: QID, focus: 'history' }}
      onClose={vi.fn()}
      documents={[]}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: '문제 상세' });
  await user.click(await within(dialog).findByRole('button', { name: /^버전 1 ·/ }));
  await user.click(within(dialog).getByRole('button', { name: /^버전 2 ·/ }));
  await act(async () => v2.resolve({ ok: true, data: revision(2) }));
  await act(async () => v1.resolve(first));
  return dialog;
}

describe('UX7-BANK-2 문제 상세 revision preview', () => {
  it('QPLAY-01-AC10 a late success of an earlier selection never replaces the preview', async () => {
    const dialog = await chooseOneThenTwo({ ok: true, data: revision(1) });
    expect(within(dialog).getByText('버전 2 본문')).toBeInTheDocument();
    expect(within(dialog).queryByText('버전 1 본문')).toBeNull();
    expect(within(dialog).getByRole('button', { name: /^버전 2 ·/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('QPLAY-01-AC10 a late failure of an earlier selection shows no error', async () => {
    const dialog = await chooseOneThenTwo({
      ok: false,
      kind: 'unavailable',
      message: '실패했습니다.',
    });
    expect(within(dialog).getByText('버전 2 본문')).toBeInTheDocument();
    expect(within(dialog).queryByText('실패했습니다.')).toBeNull();
  });
});
