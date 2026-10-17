// @vitest-environment jsdom
// QGEN-01 components (M6.3): VariationDiffViewer shows changes as <ins>/<del> with the validation
// state as text and no list items (the draft list keeps one item per draft);
// QuestionGenerationForm sends 보기 섞기 to the practice panel and LLM variations as a run body.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionGenerationForm } from '../src/components/questions/generate/question-generation-form';
import { VariationDiffViewer } from '../src/components/questions/generate/variation-diff-viewer';
import type { ReviewDraft } from '../src/lib/questions/drafts';

const ORIGINAL = {
  stem: '정수 처리 과정에 대한 설명으로 옳지 않은 것은?',
  options: [
    { id: 'opt-1', text: '가', correct: false },
    { id: 'opt-2', text: '나', correct: true },
  ],
};

function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: 'd1',
    version: 'v1',
    origin: 'generation',
    position: 0,
    questionNumber: null,
    type: 'MCQ',
    stem: '정수 처리 과정에 대한 설명으로 옳은 것은?',
    options: [
      { id: 'opt-1', text: '가', correct: true },
      { id: 'opt-2', text: '나', correct: false },
    ],
    isMultiAnswer: false,
    correctOptionIds: ['opt-1'],
    acceptedAnswers: null,
    rubric: null,
    explanation: null,
    answerMissing: false,
    reviewStatus: 'pending',
    publishedQuestionId: null,
    publishable: true,
    issues: [],
    sourceDocumentId: 'doc-1',
    pages: [4],
    locations: [{ page: 4, bbox: null }],
    generation: {
      variationType: 'INVERT_POLARITY',
      parentQuestionId: 'q',
      sourceRevisionId: 'r',
      justification: '반전했다.',
      evidence: [{ documentId: 'doc-1', pages: [4], quote: '원문 인용' }],
      acknowledgedCodes: [],
    },
    ...overrides,
  };
}

describe('VariationDiffViewer', () => {
  it('shows the diff, justification, cited page links and "검증 통과"', () => {
    const { container } = render(
      <VariationDiffViewer
        original={ORIGINAL}
        draft={draft()}
        pageHref={(doc, page) => `/doc/${doc}?page=${page}`}
      />,
    );
    expect(screen.getByRole('deletion')).toHaveTextContent('옳지');
    expect(screen.getByText('정오 반전')).toBeInTheDocument();
    expect(screen.getByText(/반전했다/)).toBeInTheDocument();
    expect(screen.getByText('원문 인용')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '4쪽' })).toHaveAttribute('href', '/doc/doc-1?page=4');
    expect(screen.getByText('검증 통과')).toBeInTheDocument();
    // Flipped answers are stated in words, never by color alone.
    expect(screen.getByText('원본에서는 오답')).toBeInTheDocument();
    expect(screen.getByText('원본에서는 정답')).toBeInTheDocument();
    expect(container.querySelector('li')).toBeNull();
  });

  it('says what blocks approval instead of "검증 통과"', () => {
    render(
      <VariationDiffViewer
        original={ORIGINAL}
        draft={draft({
          publishable: false,
          issues: [
            { code: 'inverted_answer_mismatch', severity: 'error' },
            { code: 'polarity_unchanged', severity: 'warning' },
          ],
        })}
      />,
    );
    expect(screen.queryByText('검증 통과')).toBeNull();
    expect(screen.getByText(/고쳐야 할 항목 1건 · 확인할 항목 1건/)).toBeInTheDocument();
    expect(screen.getByText('4쪽').tagName).toBe('SPAN');
  });
});

describe('QuestionGenerationForm', () => {
  const source = { questionType: 'MCQ' as const, confirmed: true, hasSources: true };

  it('opens the practice panel for 보기 섞기 instead of starting a run', async () => {
    const onShuffle = vi.fn();
    const onGenerate = vi.fn();
    render(
      <QuestionGenerationForm
        source={source}
        canGenerate
        canShuffle
        busy={false}
        onShuffle={onShuffle}
        onGenerate={onGenerate}
      />,
    );
    const group = screen.getByRole('group', { name: '변형 유형' });
    await userEvent.click(within(group).getByRole('checkbox', { name: '문구 변형' }));
    await userEvent.click(within(group).getByRole('checkbox', { name: '보기 섞기' }));
    expect(within(group).getByRole('checkbox', { name: '문구 변형' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    expect(onShuffle).toHaveBeenCalledOnce();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('starts a run with the chosen variations and asks for one when none is chosen', async () => {
    const onGenerate = vi.fn();
    render(
      <QuestionGenerationForm
        source={source}
        canGenerate
        canShuffle
        busy={false}
        onShuffle={vi.fn()}
        onGenerate={onGenerate}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    expect(screen.getByRole('alert')).toHaveTextContent('변형 유형을 하나 이상');
    await userEvent.click(screen.getByRole('checkbox', { name: '유사 개념' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '정오 반전' }));
    const count = screen.getByRole('spinbutton', { name: '변형별 후보 수' });
    await userEvent.clear(count);
    await userEvent.type(count, '2');
    await userEvent.click(screen.getByRole('button', { name: '생성' }));
    expect(onGenerate).toHaveBeenCalledWith({
      variation_types: ['INVERT_POLARITY', 'ANALOGOUS_CONCEPT'],
      candidate_count: 2,
    });
  });

  it('disables what the source or role does not allow, with the reason as text', () => {
    render(
      <QuestionGenerationForm
        source={{ ...source, hasSources: false }}
        canGenerate={false}
        canShuffle
        busy={false}
        onShuffle={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: '유사 개념' })).toBeDisabled();
    expect(screen.getByText(/문서 출처 쪽이 있어야/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '문구 변형' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '보기 섞기' })).toBeEnabled();
  });
});
