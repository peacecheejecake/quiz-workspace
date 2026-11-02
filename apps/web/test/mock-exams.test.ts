// MOCK-01 모의고사 helpers (docs/screens/mock-exams.md): the dialog's URL views and their place among
// the home's dialogs (QOV-01-AC14: list → 만들기 / 상세 is not a close; a mock exam run's range step
// borrows `mock`), the options' limits and the config a round sends, how a saved range is shown
// again, the labels, the API failures and the mock run's session mapping. Pure, no network.
import { describe, expect, it } from 'vitest';
import {
  classifyMockFailure,
  sessionFromMock,
  submitFromMock,
  type MockPracticeSession,
} from '../src/components/questions/mock-exams/mock-exam-client';
import {
  canPractise,
  checkOptions,
  configFrom,
  failureText,
  generationProgress,
  madeCount,
  metaText,
  optionsFromConfig,
  partialText,
  progressValueText,
  questionRowTitle,
  replaceText,
  selectionFromRange,
  type MockExamQuestion,
  type OptionValues,
} from '../src/components/questions/mock-exams/mock-exam-model';
import { mockRangeOverview } from '../src/components/questions/mock-exams/mock-run';
import { rangeGroups, type RangeGroup } from '../src/components/questions/viewer/range-model';
import { eventLabel, jobTypeLabel } from '../src/lib/history/model';
import { withRunState } from '../src/lib/questions/practice-runs';
import {
  closeDialog,
  exclusiveClose,
  mockViewOf,
  openDialogs,
  parsePanels,
  runOwnsMockParam,
  withMockRun,
  withMockView,
  withoutMockExams,
  withShownMockView,
  withoutPanels,
} from '../src/lib/workspaces/home';

const EXAM = '44444444-4444-4444-8444-000000000001';
const P = (q: string) => new URLSearchParams(q);

describe('모의고사 dialog URL state', () => {
  it('reads the list, 만들기, a detail and an unusable id', () => {
    expect(mockViewOf(P('panel=mock-exams'))).toEqual({ view: 'list' });
    expect(mockViewOf(P('panel=mock-exams&mock=new'))).toEqual({ view: 'create' });
    expect(mockViewOf(P(`panel=mock-exams&mock=${EXAM.toUpperCase()}`))).toEqual({
      view: 'detail',
      mockExamId: EXAM,
    });
    expect(mockViewOf(P('panel=mock-exams&mock=nope'))).toEqual({ view: 'missing' });
  });

  it('opens on a view, and changing the view is not a close', () => {
    const list = withMockView('?q=물', { view: 'list' });
    expect(parsePanels(P(list))).toEqual(['mock-exams']);
    const detail = withMockView(list, { view: 'detail', mockExamId: EXAM });
    expect(P(detail).get('mock')).toBe(EXAM);
    expect(openDialogs(detail)).toEqual(openDialogs(list));
    expect(P(withMockView(detail, { view: 'list' })).has('mock')).toBe(false);
  });

  it('closing the dialog takes its view along, but not a run range step’s mock exam', () => {
    const detail = withMockView('?q=물', { view: 'detail', mockExamId: EXAM });
    expect(withoutMockExams(detail)).toBe('?q=%EB%AC%BC');
    expect(closeDialog(detail, 'mock-exams')).toBe('?q=%EB%AC%BC');
    expect(withoutPanels(detail)).toBe('?q=%EB%AC%BC');
    const run = withRunState(withMockView('', { view: 'list' }), {
      step: 'picker',
      source: 'mock',
      mockExamId: EXAM,
    });
    expect(runOwnsMockParam(P(run))).toBe(true);
    expect(P(withoutMockExams(run)).get('mock')).toBe(EXAM);
    expect(withoutPanels(run)).toBe('');
  });

  // MOCK-W-2 (QVIEW-01-AC09): a mock exam's 풀기 is the run panel, so it closes the practice panel.
  it('a mock exam run closes the practice panel; the dialog stays under it', () => {
    const Q = '66666666-6666-4666-8666-666666666666';
    const detail = `${withMockView('?q=x', { view: 'detail', mockExamId: EXAM })}&question=${Q}`;
    const fromDetail = withMockRun(detail, EXAM);
    expect(P(fromDetail).has('question')).toBe(false);
    expect(openDialogs(fromDetail)).toEqual(['mock-exams', 'practice']);
    expect(runOwnsMockParam(P(fromDetail))).toBe(true);
    expect(P(fromDetail).get('mock')).toBe(EXAM);
    expect(exclusiveClose(detail, fromDetail)).toBe(`?q=x&panel=mock-exams&mock=${EXAM}`);

    const list = `${withMockView('', { view: 'list' })}&question=${Q}`;
    const fromList = withMockRun(list, EXAM);
    expect(fromList).toBe(`?panel=mock-exams&practice=new&source=mock&mock=${EXAM}`);
    expect(exclusiveClose(list, fromList)).toBe('?panel=mock-exams');
    // Closing the run leaves the dialog (its view is the home's to restore, keepMockView).
    expect(closeDialog(fromList, 'practice')).toBe('?panel=mock-exams');
    // Closing the run (button or Back) hands `mock` back to the view the dialog showed.
    const detailView = { view: 'detail', mockExamId: EXAM } as const;
    expect(withShownMockView(closeDialog(fromList, 'practice'), detailView)).toBe(
      `?panel=mock-exams&mock=${EXAM}`,
    );
    expect(withShownMockView(closeDialog(fromList, 'practice'), { view: 'list' })).toBe(
      '?panel=mock-exams',
    );
    // Still the run's while its range step is open; nothing without the dialog.
    expect(withShownMockView(fromList, { view: 'create' })).toBe(fromList);
    expect(withShownMockView('?q=x', detailView)).toBe('?q=x');
    // Nothing to close without a question.
    expect(exclusiveClose('?panel=mock-exams', withMockRun('?panel=mock-exams', EXAM))).toBeNull();
  });
});

const groups: RangeGroup[] = [
  {
    key: 'c1',
    title: '1장',
    questions: [
      { id: 'a', number: '1장 1번', preview: 'a', type: 'MCQ' },
      { id: 'b', number: '1장 2번', preview: 'b', type: 'MCQ' },
    ],
  },
  {
    key: 'none',
    title: '챕터 없음',
    questions: [{ id: 'c', number: '1번', preview: 'c', type: 'MCQ' }],
  },
];

describe('saved range as a selection (설정 바꾸기)', () => {
  it('selects all, whole chapters and single questions, minus exclusions', () => {
    const range = { chapter_ids: [], question_ids: [], excluded_question_ids: [] };
    expect([...selectionFromRange(groups, { ...range, all: true })]).toEqual(['a', 'b', 'c']);
    expect([
      ...selectionFromRange(groups, { ...range, all: true, excluded_question_ids: ['b'] }),
    ]).toEqual(['a', 'c']);
    expect([...selectionFromRange(groups, { ...range, chapter_ids: ['none'] })]).toEqual(['c']);
    expect([...selectionFromRange(groups, { ...range, question_ids: ['b', 'gone'] })]).toEqual([
      'b',
    ]);
  });
});

const options = (patch: Partial<OptionValues>): OptionValues => ({
  title: '중간 점검',
  types: ['PARAPHRASE'],
  count: '20',
  wholeRange: false,
  difficulty: null,
  ...patch,
});

describe('만들기 options', () => {
  it('checks the name, the types, the environment and the 문항 수 limits', () => {
    expect(checkOptions(options({}), true)).toBeNull();
    expect(checkOptions(options({ title: '  ' }), true)?.field).toBe('title');
    expect(checkOptions(options({ types: [] }), true)?.field).toBe('types');
    expect(checkOptions(options({}), false)?.message).toBe(
      '이 환경에서는 AI 변형을 쓸 수 없습니다.',
    );
    expect(checkOptions(options({ count: '101' }), true)?.field).toBe('count');
    expect(checkOptions(options({ count: '0' }), true)?.field).toBe('count');
    expect(checkOptions(options({ types: ['OPTION_SHUFFLE'], count: '400' }), false)).toBeNull();
    expect(
      checkOptions(options({ types: ['OPTION_SHUFFLE'], count: '', wholeRange: true }), false),
    ).toBeNull();
  });

  it('makes min(문항 수, 범위); 보기 섞기 only caps its count at the range or takes it all', () => {
    expect(madeCount(options({ count: '4' }), 6)).toBe(4);
    expect(madeCount(options({ count: '20' }), 6)).toBe(6);
    expect(configFrom(options({ count: '20', difficulty: 'hard' }), 6)).toEqual({
      variation_types: ['PARAPHRASE'],
      question_count: 20,
      difficulty: 'hard',
    });
    const shuffle = options({ types: ['OPTION_SHUFFLE'], count: '4', difficulty: 'hard' });
    expect(configFrom(shuffle, 2)).toEqual({
      variation_types: ['OPTION_SHUFFLE'],
      question_count: 2,
      difficulty: null,
    });
    expect(configFrom({ ...shuffle, wholeRange: true }, 2).question_count).toBeNull();
    expect(madeCount({ ...shuffle, wholeRange: true }, 7)).toBe(7);
  });

  it('starts 설정 바꾸기 from the saved config', () => {
    expect(
      optionsFromConfig('x', {
        variation_types: ['INVERT_POLARITY', 'PARAPHRASE'],
        question_count: null,
        difficulty: null,
      }),
    ).toEqual({
      title: 'x',
      types: ['PARAPHRASE', 'INVERT_POLARITY'],
      count: '20',
      wholeRange: true,
      difficulty: null,
    });
  });
});

describe('labels', () => {
  it('words the list meta, progress, failures, partial rounds and the replace confirmation', () => {
    expect(
      metaText({
        question_count_current: 18,
        config: { variation_types: ['INVERT_POLARITY', 'PARAPHRASE'], question_count: 18 },
        created_at: '2026-11-01T06:28:00Z',
      }),
    ).toBe('문제 18개 · 문구 변형, 정오 반전 · 2026. 11. 1. 오후 3:28');
    const generation = {
      requested_count: 20,
      created_count: 17,
      progress: { done: 7, total: 20 },
    } as Parameters<typeof generationProgress>[0];
    expect(progressValueText(generationProgress(generation))).toBe('20개 중 7개');
    expect(progressValueText(generationProgress(null))).toBe('0개 중 0개');
    expect(failureText('llm_timeout')).toBe(
      'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
    expect(failureText('no_valid_questions')).toMatch(/^검증을 통과한 문제를 만들지 못했습니다/);
    expect(failureText('other')).toBe('모의고사를 만들지 못했습니다. 다시 시도하세요.');
    expect(partialText({ requested_count: 3, created_count: 2 })).toBe(
      '3문항 중 2문항을 만들었습니다. 1개는 검증을 통과하지 못했습니다.',
    );
    expect(replaceText(4)).toBe(
      '지금 문제 4개를 새로 만든 문제로 바꿉니다. 편집한 문제도 바뀝니다.',
    );
    expect(questionRowTitle(`${'가'.repeat(45)} ( )`, 2)).toBe(`문제 2 · ${'가'.repeat(40)}…`);
    expect(canPractise({ current_generation: null, question_count_current: 0 })).toBe(false);
    expect(eventLabel('mock_exam.created')).toBe('모의고사 만들기');
    expect(jobTypeLabel('mock_exam.generate')).toBe('모의고사 생성');
  });
});

describe('mock exam API and run', () => {
  it('tells the problems apart', () => {
    const p = (slug: string) => ({ type: `urn:quiz-workspace:problem:${slug}` });
    expect(classifyMockFailure(403, p('workspace-archived'))).toBe('archived');
    expect(classifyMockFailure(403, p('insufficient-role'))).toBe('forbidden');
    expect(classifyMockFailure(404, undefined)).toBe('notFound');
    expect(classifyMockFailure(409, p('mock-generation-running'))).toBe('running');
    expect(classifyMockFailure(409, p('no-matching-questions'))).toBe('noMatching');
    expect(classifyMockFailure(409, p('mock-llm-disabled'))).toBe('llmDisabled');
    expect(classifyMockFailure(422, undefined)).toBe('invalid');
    expect(classifyMockFailure(429, undefined)).toBe('rateLimited');
  });

  it('lists a mock exam’s questions as one range group in order, without answers', () => {
    const q = (id: string, position: number): MockExamQuestion => ({
      id,
      position,
      question_type: 'MCQ',
      variation_type: 'OPTION_SHUFFLE',
      stem: `발문 ${id}`,
      options: [],
      is_multi_answer: false,
      revision: { id, version: 1 },
      edited: false,
      source: { question_id: null, label: '원본 삭제됨' },
    });
    const range = rangeGroups(mockRangeOverview([q('x', 1), q('y', 3)]));
    expect(range).toHaveLength(1);
    expect(range[0]?.questions.map((r) => [r.id, r.number])).toEqual([
      ['x', '1번'],
      ['y', '2번'],
    ]);
    expect(JSON.stringify(range)).not.toMatch(/correct|explanation/);
  });

  it('maps a mock session and its result onto the solve step’s shapes', () => {
    const session: MockPracticeSession = {
      id: 's',
      workspace_id: 'w',
      mock_exam_id: 'm',
      mock_exam_question_id: 'q',
      revision_id: 'r',
      question_type: 'MCQ',
      stem: '발문',
      is_multi_answer: false,
      displayed_option_ids: ['b', 'a'],
      options: [
        { id: 'b', text: 'B' },
        { id: 'a', text: 'A' },
      ],
      state: 'open',
      opened_at: '2026-11-02T00:00:00Z',
      practice_run_id: 'run',
      run_position: 2,
    };
    expect(sessionFromMock(session)).toMatchObject({
      question_id: 'q',
      question_revision_id: 'r',
      displayed_option_ids: ['b', 'a'],
      run_position: 2,
    });
    expect(
      submitFromMock({
        attempt_id: 't',
        practice_session_id: 's',
        mock_exam_question_id: 'q',
        revision_id: 'r',
        state: 'graded',
        result: 'correct',
        correct_option_ids: ['a'],
        accepted_answers: null,
        explanation: '해설',
        rubric: null,
      }),
    ).toMatchObject({ question_revision_id: 'r', result: 'correct', explanation: '해설' });
  });
});
