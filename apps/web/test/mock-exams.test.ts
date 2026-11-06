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
  cappedCount,
  chapterDefaultTitle,
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
import { formatDateTime } from '../src/components/questions/labels';
import { mockRangeOverview } from '../src/components/questions/mock-exams/mock-run';
import {
  allIds,
  EMPTY_RANGE_FILTERS,
  rangeGroups,
  rangeRequest,
  type RangeGroup,
} from '../src/components/questions/viewer/range-model';
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
      { id: 'a', number: '1번', preview: 'a', type: 'MCQ' },
      { id: 'b', number: '2번', preview: 'b', type: 'MCQ' },
    ],
  },
  {
    key: 'none',
    title: '챕터 없음',
    questions: [{ id: 'c', number: '3번', preview: 'c', type: 'MCQ' }],
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
    expect(checkOptions(options({ types: [] }), true)).toBeNull();
    expect(checkOptions(options({ types: [], title: '  ' }), true)).toBeNull();
    expect(checkOptions(options({ types: [], title: 'x'.repeat(101) }), true)).toBeNull();
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
      }),
    ).toBe('문제 18개 · 문구 변형, 정오 반전');
    // The row then adds " · " and a <time> with the creation time.
    expect(formatDateTime('2026-11-01T06:28:00Z')).toBe('2026. 11. 1. 오후 3:28');
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
    expect(failureText('mock_llm_disabled')).toMatch(/^이 환경에서는 AI 변형을 쓸 수 없습니다/);
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

  it('groups a mock exam’s questions by source chapter in plan rank, the none group last', () => {
    const chapter = (id: string, rank: number, number: number | null) => ({
      id,
      rank,
      number,
      title: number === null ? '부록' : `${number}장 제목`,
    });
    const q = (
      id: string,
      position: number,
      ch: ReturnType<typeof chapter> | null,
    ): MockExamQuestion => ({
      id,
      position,
      question_type: 'MCQ',
      variation_type: 'OPTION_SHUFFLE',
      stem: `발문 ${id}`,
      options: [],
      is_multi_answer: false,
      revision: { id, version: 1 },
      edited: false,
      source: ch
        ? { question_id: `src-${id}`, label: '1번', chapter: ch }
        : { question_id: null, label: '원본 삭제됨', chapter: null },
    });
    const one = chapter('c1', 0, 1);
    const two = chapter('c2', 1, 2);
    const appendix = chapter('c3', 2, null);
    // Mock exam order: 2장, deleted source, 1장, 부록, 1장 (a moved source keeps its plan rank).
    const range = rangeGroups(
      mockRangeOverview([
        q('a', 0, two),
        q('b', 1, null),
        q('c', 2, one),
        q('d', 3, appendix),
        q('e', 4, one),
      ]),
      'mock',
    );
    expect(range.map((g) => [g.key, g.title])).toEqual([
      ['c1', '1장 제목'],
      ['c2', '2장 제목'],
      ['c3', '부록'],
      ['none', '챕터 없음'],
    ]);
    // Rows keep the mock exam's own numbers ("문제 k" in mock order), never the source's.
    expect(range.map((g) => g.questions.map((r) => [r.id, r.number]))).toEqual([
      [
        ['c', '문제 3'],
        ['e', '문제 5'],
      ],
      [['a', '문제 1']],
      [['d', '문제 4']],
      [['b', '문제 2']],
    ]);
    expect(JSON.stringify(range)).not.toMatch(/correct|explanation/);

    // 시작 sends single question ids for a whole chapter (`chapter_ids` is 422 for a mock run).
    const all = new Set(allIds(range));
    expect(rangeRequest(range, all, EMPTY_RANGE_FILTERS, 'mock')).toEqual({ all: true });
    expect(rangeRequest(range, new Set(['c', 'e', 'b']), EMPTY_RANGE_FILTERS, 'mock')).toEqual({
      question_ids: ['c', 'e', 'b'],
    });
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

describe('UX12-MOCKFORM2 defaults taken from the chosen range', () => {
  const question = (id: string) => ({ id, number: id, preview: id, type: 'MCQ' as const });
  const group = (key: string, title: string, ...ids: string[]): RangeGroup => ({
    key,
    title,
    questions: ids.map(question),
  });
  const groups = [
    group('c1', '1장 물의 순환', 'a', 'b'),
    group('c2', '2장 정수 처리', 'c'),
    group('c3', '3장 수질', 'd'),
    group('none', '챕터 없음', 'e'),
  ];
  const fallback = '모의고사 3';
  const title = (...ids: string[]) => chapterDefaultTitle(groups, new Set(ids), fallback);

  it('names one chapter by its title, also when only part of it is chosen', () => {
    expect(title('a', 'b')).toBe('1장 물의 순환');
    expect(title('b')).toBe('1장 물의 순환');
  });

  it('names several chapters by the first in Heatmap order plus the others', () => {
    expect(title('c', 'a')).toBe('1장 물의 순환 외 1개');
    expect(title('a', 'c', 'd')).toBe('1장 물의 순환 외 2개');
  });

  it('keeps the fallback for 전체 선택, nothing chosen and questions without a chapter', () => {
    expect(title('a', 'b', 'c', 'd', 'e')).toBe(fallback);
    expect(title()).toBe(fallback);
    expect(title('e')).toBe(fallback);
  });

  it('counts only real chapters when questions without a chapter are mixed in', () => {
    expect(title('c', 'e')).toBe('2장 정수 처리');
    expect(title('a', 'c', 'e')).toBe('1장 물의 순환 외 1개');
  });

  it('ignores questions a filter hid', () => {
    expect(title('c', 'hidden')).toBe('2장 정수 처리');
  });

  it('fits the name limit', () => {
    const long = [
      group('c1', '가'.repeat(100), 'a'),
      group('c2', '둘째', 'b'),
      group('c3', 'x', 'c'),
    ];
    const named = chapterDefaultTitle(long, new Set(['a', 'b']), fallback);
    expect(named).toHaveLength(100);
    expect(named.endsWith(' 외 1개')).toBe(true);
  });

  it('caps 문항 수 at the selection', () => {
    expect(cappedCount('20', 3)).toBe('3');
    expect(cappedCount('20', 20)).toBe('20');
    expect(cappedCount('20', 300)).toBe('20');
  });
});
