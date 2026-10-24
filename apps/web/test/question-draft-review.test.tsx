// @vitest-environment jsdom
// QuestionDraftReview (shared by QIMPORT-01 and QGEN-01): one list item per draft, state as text
// (never color alone), approval blocked with a reason until an answer exists, no review controls
// for registered drafts or read-only viewers, and actions reported with the draft.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionDraftReview } from '../src/components/questions/drafts/question-draft-review';
import type { ReviewDraft } from '../src/lib/questions/drafts';

function draft(overrides: Partial<ReviewDraft>): ReviewDraft {
  return {
    id: 'd1',
    version: 'v1',
    origin: 'pdf_import',
    position: 0,
    questionNumber: 1,
    type: 'MCQ',
    stem: '첫 번째 문제',
    options: [
      { id: 'o1', text: '가', correct: true },
      { id: 'o2', text: '나', correct: false },
    ],
    isMultiAnswer: false,
    correctOptionIds: ['o1'],
    acceptedAnswers: null,
    rubric: null,
    explanation: null,
    answerMissing: false,
    reviewStatus: 'pending',
    publishedQuestionId: null,
    publishable: true,
    issues: [],
    sourceDocumentId: 'doc',
    pages: [1],
    locations: [{ page: 1, bbox: null }],
    ...overrides,
  };
}

const DRAFTS: ReviewDraft[] = [
  draft({}),
  draft({
    id: 'd3',
    position: 2,
    questionNumber: 3,
    stem: '세 번째 문제',
    options: [
      { id: 'o1', text: '응고', correct: false },
      { id: 'o2', text: '증발', correct: false },
    ],
    correctOptionIds: null,
    answerMissing: true,
    publishable: false,
    issues: [{ code: 'provenance_missing', severity: 'warning' }],
    pages: [2, 3],
  }),
  draft({
    id: 'd5',
    position: 4,
    questionNumber: 5,
    stem: '다섯 번째 문제',
    reviewStatus: 'approved',
    publishedQuestionId: 'q5',
  }),
];

describe('QuestionDraftReview', () => {
  it('renders one list item per draft with number, answer state and page links', () => {
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        pageHref={(d, page) => `/doc?page=${page}&d=${d.id}`}
      />,
    );
    const list = screen.getByRole('list', { name: '가져온 초안' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [first, third, fifth] = items as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(first).getByText('1번 문제')).toBeTruthy();
    expect(within(first).getByText('정답')).toBeTruthy();
    expect(within(first).queryByText('정답 없음')).toBeNull();
    expect(within(first).getByRole('link', { name: '1쪽' }).getAttribute('href')).toBe(
      '/doc?page=1&d=d1',
    );

    expect(within(third).getByText('정답 없음')).toBeTruthy();
    expect(within(third).getByRole('link', { name: '2쪽' })).toBeTruthy();
    expect(within(third).getByRole('link', { name: '3쪽' })).toBeTruthy();
    expect(within(third).getByText(/원본 PDF의 쪽 정보가 없습니다/)).toBeTruthy();

    expect(within(fifth).getByText('등록됨')).toBeTruthy();
  });

  it('blocks approval with a reason until an answer exists and reports approvals', async () => {
    const onApproveChange = vi.fn();
    const onEdit = vi.fn();
    const onCompare = vi.fn();
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        onApproveChange={onApproveChange}
        onEdit={onEdit}
        onCompare={onCompare}
      />,
    );
    const blocked = screen.getByRole('checkbox', { name: '3번 문제 승인' });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    expect(blocked.getAttribute('aria-describedby')).toBeTruthy();

    // A registered draft has no review controls left.
    expect(screen.queryByRole('checkbox', { name: '5번 문제 승인' })).toBeNull();
    expect(screen.queryByRole('button', { name: '편집: 5번 문제' })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: '1번 문제 승인' }));
    expect(onApproveChange).toHaveBeenCalledWith(DRAFTS[0], true);
    await user.click(screen.getByRole('button', { name: '편집: 3번 문제' }));
    expect(onEdit).toHaveBeenCalledWith(DRAFTS[1]);
    await user.click(screen.getByRole('button', { name: '원본 비교: 5번 문제' }));
    expect(onCompare).toHaveBeenCalledWith(DRAFTS[2]);
  });

  it('shows the optimistic approval while in flight and an inline error after a failure', () => {
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        states={{ d1: { approving: true }, d3: { error: '승인하지 못했습니다.' } }}
        onApproveChange={vi.fn()}
      />,
    );
    const pending = screen.getByRole('checkbox', { name: '1번 문제 승인' });
    expect(pending.getAttribute('aria-checked')).toBe('true');
    expect(pending.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('승인하지 못했습니다.');
  });

  it('has no review controls when read-only', () => {
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        readOnly
        onApproveChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /편집/ })).toBeNull();
  });

  it('selection mode: a plain checkbox per draft, blocked drafts disabled with the reason', async () => {
    const onSelectChange = vi.fn();
    const onApproveChange = vi.fn();
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        selected={new Set(['d1'])}
        onSelectChange={onSelectChange}
        onApproveChange={onApproveChange}
      />,
    );
    // No approve control in selection mode.
    expect(screen.queryByRole('checkbox', { name: /승인/ })).toBeNull();
    const first = screen.getByRole('checkbox', { name: '1번 문제 선택' });
    expect(first.getAttribute('aria-checked')).toBe('true');
    const blocked = screen.getByRole('checkbox', { name: '3번 문제 선택' });
    expect(blocked.hasAttribute('disabled')).toBe(true);
    const reason = document.getElementById(blocked.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toContain('정답 보기를 지정해야');
    // Registered drafts cannot be selected again.
    expect(screen.queryByRole('checkbox', { name: '5번 문제 선택' })).toBeNull();

    await userEvent.setup().click(first);
    expect(onSelectChange).toHaveBeenCalledWith(DRAFTS[0], false);
    expect(onApproveChange).not.toHaveBeenCalled();
  });

  it('selection mode: the checkboxes cannot change while disabled', () => {
    render(
      <QuestionDraftReview
        label="가져온 초안"
        drafts={DRAFTS}
        selected={new Set()}
        selectionDisabled
        onSelectChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: '1번 문제 선택' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
