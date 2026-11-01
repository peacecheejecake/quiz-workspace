// @vitest-environment jsdom
// UX7-DEDUP 중복 문제 정리 (QOV-01-AC16, QIMPORT-01-AC10): the dialog's review choices (default
// keep = the server's suggestion, groups left out, the merge request), the dialog body over the
// scan/merge actions, and the import review's duplicate rules (no default selection, outside
// 전체 선택, still selectable, the reason text).
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@quiz/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archivedCount,
  duplicateReason,
  initialChoices,
  mergeRequest,
  type DuplicateGroup,
} from '../src/lib/questions/duplicates';
import {
  initialSelection,
  isSelectable,
  selectAllScope,
  toggleAll,
  toggleOne,
  type DraftSummary,
} from '../src/lib/questions/drafts';

const scanDuplicatesAction = vi.fn();
const mergeDuplicatesAction = vi.fn();
vi.mock('../src/lib/questions/actions', () => ({
  scanDuplicatesAction: (...a: unknown[]) => scanDuplicatesAction(...a),
  mergeDuplicatesAction: (...a: unknown[]) => mergeDuplicatesAction(...a),
}));

const { QuestionDuplicates } =
  await import('../src/components/questions/duplicates/question-duplicates');

const WS = '55555555-5555-4555-8555-555555555555';
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

function q(n: number) {
  return {
    question_id: id(n),
    question_number: n,
    question_type: 'MCQ' as const,
    chapter_id: null,
    chapter_title: null,
    created_at: `2026-10-0${n}T00:00:00Z`,
    stem: `같은 문제 ${n}`,
    options: [
      { id: 'a', text: `① 보기 가` },
      { id: 'b', text: `② 보기 나` },
    ],
  };
}

function group(fingerprint: string, ns: number[], answersDiffer = false): DuplicateGroup {
  const first = ns[0] ?? 1;
  return {
    fingerprint,
    suggested_keep_question_id: id(first),
    answers_differ: answersDiffer,
    questions: ns.map(q),
  };
}

describe('duplicate review choices', () => {
  const groups = [group('f1', [1, 2, 3]), group('f2', [4, 5])];

  it('keeps the suggested question of every group by default', () => {
    const choices = initialChoices(groups);
    expect(mergeRequest(groups, choices)).toEqual([
      { keep_question_id: id(1), duplicate_question_ids: [id(2), id(3)] },
      { keep_question_id: id(4), duplicate_question_ids: [id(5)] },
    ]);
    expect(archivedCount(groups, choices)).toBe(3);
  });

  it('follows the chosen keep and leaves out unchecked groups', () => {
    const choices = new Map([
      ['f1', { keep: id(3), include: true }],
      ['f2', { keep: id(5), include: false }],
    ]);
    expect(mergeRequest(groups, choices)).toEqual([
      { keep_question_id: id(3), duplicate_question_ids: [id(1), id(2)] },
    ]);
    expect(archivedCount(groups, choices)).toBe(2);
  });

  it('falls back to the suggestion when the chosen keep is not in the group', () => {
    const choices = new Map([['f1', { keep: id(9), include: true }]]);
    expect(mergeRequest([groups[0] as DuplicateGroup], choices)[0]?.keep_question_id).toBe(id(1));
  });

  it('says why an import draft is a duplicate', () => {
    expect(
      duplicateReason({ kind: 'question', question_id: id(1), draft_id: null, number: 7 }),
    ).toBe('이미 등록된 7번 문제와 같습니다');
    expect(
      duplicateReason({ kind: 'question', question_id: id(1), draft_id: null, number: null }),
    ).toBe('이미 등록된 문제와 같습니다');
    expect(duplicateReason({ kind: 'draft', question_id: null, draft_id: id(2), number: 5 })).toBe(
      '이 PDF의 5번 초안과 같습니다',
    );
    expect(duplicateReason(null)).toBeNull();
  });
});

describe('import review duplicates (QIMPORT-01-AC10)', () => {
  function summary(n: number, extra: Partial<DraftSummary> = {}): DraftSummary {
    return {
      id: id(n),
      version: '1',
      position: n - 1,
      questionNumber: n,
      type: 'MCQ',
      reviewStatus: 'pending',
      publishedQuestionId: null,
      publishable: true,
      answerMissing: false,
      issues: [],
      duplicateOf: null,
      ...extra,
    };
  }
  const duplicate = summary(2, {
    reviewStatus: 'approved',
    duplicateOf: { kind: 'question', question_id: id(9), draft_id: null, number: 7 },
  });
  const drafts = [summary(1, { reviewStatus: 'approved' }), duplicate, summary(3)];

  it('leaves duplicates out of the initial selection and 전체 선택', () => {
    expect([...initialSelection(drafts)]).toEqual([id(1)]);
    expect(selectAllScope(drafts).map((d) => d.id)).toEqual([id(1), id(3)]);
    expect([...toggleAll(drafts, new Set(), true)]).toEqual([id(1), id(3)]);
  });

  it('keeps a duplicate selectable on purpose', () => {
    expect(isSelectable(duplicate)).toBe(true);
    const picked = toggleOne(toggleAll(drafts, new Set(), true), duplicate.id, true);
    expect(picked.has(duplicate.id)).toBe(true);
  });
});

describe('중복 문제 정리 dialog (QOV-01-AC16)', () => {
  beforeEach(() => {
    scanDuplicatesAction.mockReset();
    mergeDuplicatesAction.mockReset();
  });

  function show() {
    const onMerged = vi.fn();
    render(
      <ToastProvider>
        <QuestionDuplicates workspaceId={WS} onMerged={onMerged} />
      </ToastProvider>,
    );
    return onMerged;
  }

  it('shows the groups, merges the chosen keep after confirming and scans again', async () => {
    const user = userEvent.setup();
    scanDuplicatesAction
      .mockResolvedValueOnce({
        ok: true,
        data: { groups: [group('f1', [1, 2], true)], question_count: 3 },
      })
      .mockResolvedValueOnce({ ok: true, data: { groups: [], question_count: 2 } });
    mergeDuplicatesAction.mockResolvedValue({
      ok: true,
      data: {
        groups: [
          {
            keep_question_id: id(2),
            archived_question_ids: [id(1)],
            already_merged_question_ids: [],
          },
        ],
      },
    });
    const onMerged = show();
    expect(screen.getByRole('status')).toHaveTextContent('중복 문제를 찾는 중입니다.');

    const box = await screen.findByRole('group', { name: /중복 묶음 1/ });
    const keep = within(box).getByRole('radiogroup', { name: '중복 묶음 1 남길 문제' });
    expect(within(keep).getByRole('radio', { name: /1번 문제/ })).toBeChecked();
    expect(within(box).getByRole('checkbox', { name: '이 묶음 정리' })).toBeChecked();
    expect(box).toHaveTextContent('정답이 서로 다릅니다');
    expect(box).toHaveTextContent('① 보기 가');

    await user.click(within(keep).getByRole('radio', { name: /2번 문제/ }));
    await user.click(screen.getByRole('button', { name: '선택한 묶음 정리 (1)' }));
    const confirm = await screen.findByRole('alertdialog', { name: '중복 문제 1개를 보관할까요?' });
    expect(mergeDuplicatesAction).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: '보관' }));

    await waitFor(() =>
      expect(mergeDuplicatesAction).toHaveBeenCalledWith(WS, [
        { keep_question_id: id(2), duplicate_question_ids: [id(1)] },
      ]),
    );
    expect(await screen.findByText('중복 문제가 없습니다')).toBeInTheDocument();
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(scanDuplicatesAction).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('중복 문제 1개를 보관했습니다.')).toBeInTheDocument();
  });

  it('leaves out an unchecked group and disables the button when none is left', async () => {
    const user = userEvent.setup();
    scanDuplicatesAction.mockResolvedValue({
      ok: true,
      data: { groups: [group('f1', [1, 2])], question_count: 2 },
    });
    show();
    const box = await screen.findByRole('group', { name: /중복 묶음 1/ });
    await user.click(within(box).getByRole('checkbox', { name: '이 묶음 정리' }));
    expect(screen.getByRole('button', { name: '선택한 묶음 정리 (0)' })).toBeDisabled();
  });

  it('reports a refused merge and scans again', async () => {
    const user = userEvent.setup();
    scanDuplicatesAction.mockResolvedValue({
      ok: true,
      data: { groups: [group('f1', [1, 2])], question_count: 2 },
    });
    mergeDuplicatesAction.mockResolvedValue({
      ok: false,
      kind: 'changed',
      message: '그 사이 문제가 바뀌었습니다. 다시 확인해 주세요.',
    });
    show();
    await screen.findByRole('group', { name: /중복 묶음 1/ });
    await user.click(screen.getByRole('button', { name: '선택한 묶음 정리 (1)' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '보관' }),
    );
    expect(
      await screen.findByText('그 사이 문제가 바뀌었습니다. 다시 확인해 주세요.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(scanDuplicatesAction).toHaveBeenCalledTimes(2));
  });

  it('offers 다시 시도 when the scan fails', async () => {
    const user = userEvent.setup();
    scanDuplicatesAction
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '일시적인 오류' })
      .mockResolvedValueOnce({ ok: true, data: { groups: [], question_count: 0 } });
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('중복 문제를 찾지 못했습니다.');
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('중복 문제가 없습니다')).toBeInTheDocument();
  });
});
