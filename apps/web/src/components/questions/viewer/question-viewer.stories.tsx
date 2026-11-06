// QVIEW-01 QuestionViewer stories (docs/screens/question-viewer.md): every mode in light and dark,
// plus the sequence mode's range, solving, graded, results and mock exam states. Built by the
// @quiz/ui Storybook (packages/ui/.storybook/main.ts adds these stories and aliases the server
// actions and next/link to stories/). Plain CSF objects: apps/web does not depend on Storybook.
// Synthetic content only.
import type { ComponentProps } from 'react';
import type { PracticeRun, RunItem, RunResultItem } from '@/lib/questions/practice-runs';
import { QuestionViewer, type RunClient } from './question-viewer';
import { STORY_RESULT, STORY_SESSION } from './stories/story-server';

type Props = ComponentProps<typeof QuestionViewer>;
interface Story {
  readonly args: Props;
  readonly globals?: { readonly theme: 'light' | 'dark' };
}

const WS = STORY_SESSION.workspace_id;
const RUN = '33333333-3333-4333-8333-000000000001';
const noop = () => undefined;
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });

const REVISION = {
  id: '88888888-8888-4888-8888-000000000001',
  version: 2,
  stem: STORY_SESSION.stem,
  options: [
    { id: 'o1', text: '증발' },
    { id: 'o2', text: '응결' },
    { id: 'o3', text: '강수' },
  ],
  correct_option_ids: ['o1'],
  accepted_answers: null,
  is_multi_answer: false,
  explanation: STORY_RESULT.explanation,
  rubric: null,
  created_at: '2026-11-02T00:00:00Z',
};

function run(overrides: Partial<PracticeRun> = {}): PracticeRun {
  return {
    id: RUN,
    workspace_id: WS,
    source: 'bank',
    mock_exam_id: null,
    random_order: false,
    seed: 1,
    total: 5,
    answered: 1,
    reached: 2,
    created_at: '2026-11-02T00:00:00Z',
    finished_at: null,
    summary: { correct: 1, incorrect: 1, pending: 2, skipped: 1 },
    ...overrides,
  };
}

function item(overrides: Partial<RunItem> = {}): RunItem {
  return {
    position: 2,
    total: 5,
    available: true,
    question_id: STORY_SESSION.question_id,
    question_type: 'MCQ',
    chapter_id: '66666666-6666-4666-8666-000000000001',
    chapter_number: 3,
    chapter_title: '3장 물의 순환',
    question_number: 12,
    stem: STORY_SESSION.stem,
    is_multi_answer: false,
    options: STORY_SESSION.options,
    practice_session_id: null,
    session_state: null,
    attempt: null,
    ...overrides,
  };
}

const RESULTS: RunResultItem[] = (
  ['correct', 'incorrect', 'skipped', 'pending', 'pending'] as const
).map((result, i) => ({
  position: i + 1,
  question_id: `22222222-2222-4222-8222-00000000000${i + 1}`,
  available: true,
  question_type: i < 3 ? 'MCQ' : 'ESSAY',
  chapter_id: '66666666-6666-4666-8666-000000000001',
  chapter_number: 3,
  chapter_title: '3장 물의 순환',
  question_number: i + 1,
  preview: `물의 순환 ${i + 1}번 문제의 발문 앞부분`,
  result,
}));

function client(overrides: Partial<RunClient> = {}): RunClient {
  return {
    listRange: () =>
      ok({
        chapters: [
          { id: 'c1', title: '1장 물의 순환', number: 1, question_count: 3, document_id: null },
          { id: 'c2', title: '2장 정수 처리', number: 2, question_count: 2, document_id: null },
        ],
        items: ['c1', 'c1', 'c1', 'c2', 'c2'].map((chapter, i) => ({
          question_id: `22222222-2222-4222-8222-00000000000${i + 1}`,
          chapter_id: chapter,
          question_number: chapter === 'c1' ? i + 1 : i - 2,
          question_type: 'MCQ' as const,
          preview: `물의 순환과 정수 처리 ${i + 1}번 문제: 알맞은 것을 고르시오. ( )`,
          status: 'unseen' as const,
          is_favorite: false,
          needs_retry: false,
          last_graded_result: null,
          is_pending_grading: false,
        })),
      }),
    create: () => ok(run()),
    getRun: () => ok(run()),
    getItem: () => ok(item()),
    openSession: () => ok(STORY_SESSION),
    submit: () => ok(STORY_RESULT),
    selfGrade: (sessionId, grade) =>
      ok({
        attempt_id: STORY_RESULT.attempt_id,
        grades_attempt_id: STORY_RESULT.attempt_id,
        practice_session_id: sessionId,
        result: grade,
      }),
    finish: () => ok(run({ finished_at: '2026-11-02T00:10:00Z' })),
    results: () => ok({ total: RESULTS.length, offset: 0, limit: 200, items: RESULTS }),
    flags: () => Promise.resolve({ is_favorite: true, needs_retry: false }),
    setFlags: () => ok({ is_favorite: true, needs_retry: false } as never),
    ...overrides,
  };
}

const sequence = {
  mode: 'sequence',
  workspaceId: WS,
  archived: false,
  onNavigate: noop,
  onClose: noop,
} as const;

const meta = {
  title: 'Questions/QuestionViewer',
  component: QuestionViewer,
  parameters: { layout: 'fullscreen' },
};
export default meta;

const dark = <S extends Story>(story: S): S => ({ ...story, globals: { theme: 'dark' } });

export const Practice: Story = {
  args: {
    mode: 'practice',
    workspaceId: WS,
    question: {
      id: STORY_SESSION.question_id,
      title: '12번 문제',
      chapterTitle: '3장 물의 순환',
      questionType: 'MCQ',
      preview: STORY_SESSION.stem,
      isFavorite: false,
      needsRetry: true,
      lastGradedResult: 'correct',
      isPendingGrading: false,
    },
    readOnly: false,
    onClose: noop,
    onFlagsChange: noop,
    onViewed: noop,
  },
};
export const PracticeDark = dark(Practice);

export const SequenceRange: Story = {
  args: {
    ...sequence,
    state: { step: 'picker', source: 'bank', mockExamId: null },
    client: client(),
  },
};
export const SequenceRangeDark = dark(SequenceRange);

export const SequenceSolving: Story = {
  args: { ...sequence, state: { step: 'solve', runId: RUN, position: 2 }, client: client() },
};
export const SequenceSolvingDark = dark(SequenceSolving);

/** A submitted position read again: the result border with the check/X icon. */
export const SequenceGraded: Story = {
  args: {
    ...sequence,
    state: { step: 'solve', runId: RUN, position: 2 },
    client: client({
      getItem: () =>
        ok(
          item({
            session_state: 'graded',
            attempt: {
              attempt_id: STORY_RESULT.attempt_id,
              result: 'incorrect',
              submitted_answer: { selected_option_ids: ['o2'], answer_text: null },
              correct_option_ids: ['o1'],
              accepted_answers: null,
              explanation: STORY_RESULT.explanation,
              rubric: null,
            },
          }),
        ),
    }),
  },
};
export const SequenceGradedDark = dark(SequenceGraded);

export const SequenceResults: Story = {
  args: { ...sequence, state: { step: 'results', runId: RUN }, client: client() },
};
export const SequenceResultsDark = dark(SequenceResults);

/** A mock exam run: "문제 k", no favorite / retry toggles, no 문제 관리 menu. */
export const SequenceMock: Story = {
  args: {
    ...sequence,
    source: 'mock',
    state: { step: 'solve', runId: RUN, position: 2 },
    client: client({ flags: undefined, setFlags: undefined }),
  },
};
export const SequenceMockDark = dark(SequenceMock);

export const SequenceArchived: Story = {
  args: {
    ...sequence,
    archived: true,
    state: { step: 'solve', runId: RUN, position: 2 },
    client: client(),
  },
};

export const Manage: Story = {
  args: {
    mode: 'manage',
    workspaceId: WS,
    open: true,
    onClose: noop,
    description: '12번 문제 · 객관식 · 3장 물의 순환',
    focus: 'answers',
    load: {
      status: 'ready',
      question: {
        id: STORY_SESSION.question_id,
        workspace_id: WS,
        question_type: 'MCQ',
        publication_status: 'CONFIRMED',
        chapter_id: null,
        question_number: 12,
        revision: REVISION,
        revisions: [
          { id: REVISION.id, version: 2, created_at: '2026-11-02T00:00:00Z' },
          {
            id: '88888888-8888-4888-8888-000000000000',
            version: 1,
            created_at: '2026-11-01T00:00:00Z',
          },
        ],
        sources: [],
      } as never,
    },
    onRetry: noop,
    documents: [],
  },
};
export const ManageDark = dark(Manage);

export const ReadOnly: Story = {
  args: {
    mode: 'read-only',
    question: { questionType: 'MCQ', revision: REVISION },
    title: '12번 문제',
    description: '객관식 · 3장 물의 순환 · 조회 전용',
    onClose: noop,
  },
};
export const ReadOnlyDark = dark(ReadOnly);
