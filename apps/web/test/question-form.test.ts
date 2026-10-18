// QBANK-01 editor logic the browser cannot observe directly: option id stability across edits,
// validation that mirrors quiz_api.question_rules, request bodies, 422 loc → field mapping,
// problem classification and the URL filter state.
import { describe, expect, it } from 'vitest';
import { parseBankFilters, serializeBankFilters, statusQuery } from '../src/lib/questions/filters';
import {
  acceptedAnswerList,
  addOption,
  addSource,
  contentBody,
  createBody,
  emptyForm,
  errorSummary,
  fieldErrorsFromIssues,
  formFromQuestion,
  MESSAGES,
  moveOption,
  newOptionId,
  optionKey,
  parseFormValues,
  parseSourceSnapshot,
  removeOption,
  removeSource,
  setMultiAnswer,
  setOptionCorrect,
  setOptionText,
  sourcesChanged,
  sourceSnapshot,
  updateBody,
  updateSource,
  validateQuestionForm,
  type Question,
  type QuestionFormValues,
} from '../src/lib/questions/form';
import { classifyQuestionFailure, QUESTION_PROBLEM_TYPES } from '../src/lib/questions/problems';

const REV = '11111111-1111-4111-8111-111111111111';
const CHAPTER = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

function counter() {
  let n = 0;
  return () => `opt-test${(n += 1)}`;
}

function mcq(texts: string[], correct: number[] = [], multi = false): QuestionFormValues {
  const mint = counter();
  let values: QuestionFormValues = { ...emptyForm(mint), options: [], multiAnswer: multi };
  for (const text of texts) {
    values = addOption(values, mint);
    const id = values.options.at(-1)?.id ?? '';
    values = setOptionText(values, id, text);
  }
  for (const i of correct) values = setOptionCorrect(values, values.options[i]?.id ?? '', true);
  return { ...values, stem: '물이 기체로 변하는 과정은?' };
}

const QUESTION: Question = {
  id: '44444444-4444-4444-8444-444444444444',
  workspace_id: '55555555-5555-4555-8555-555555555555',
  question_type: 'MCQ',
  publication_status: 'CONFIRMED',
  origin: 'manual',
  chapter_id: CHAPTER,
  chapter: { id: CHAPTER, document_id: DOC, title: '1장 물의 순환' },
  question_number: 3,
  revision: {
    id: REV,
    version: 1,
    stem: '염소 소독의 주된 목적은?',
    options: [
      { id: 'server-a', text: '색' },
      { id: 'server-b', text: '미생물' },
      { id: 'server-c', text: '온도' },
    ],
    correct_option_ids: ['server-b'],
    accepted_answers: null,
    is_multi_answer: false,
    explanation: '해설',
    rubric: null,
    created_at: '2026-10-17T00:00:00Z',
  },
  sources: [{ document_id: DOC, document_revision_id: null, page_start: 4, page_end: 4 }],
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
};

describe('option ids', () => {
  it('mints opaque opt-<random> ids without whitespace', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newOptionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^opt-[a-z0-9]{12}$/);
  });

  it('keeps every id through text edits, reordering, removal and adds', () => {
    let values = mcq(['가', '나', '다', '라'], [1]);
    const [a, b, c, d] = values.options.map((o) => o.id);
    values = setOptionText(values, c ?? '', '다 (수정)');
    values = moveOption(values, d ?? '', -1);
    values = removeOption(values, a ?? '');
    values = addOption(values, () => 'opt-new');
    expect(values.options.map((o) => o.id)).toEqual([b, d, c, 'opt-new']);
    expect(values.options.find((o) => o.id === c)?.text).toBe('다 (수정)');
    expect(contentBody(values).correct_option_ids).toEqual([b]);
  });

  it('keeps server ids when editing an existing question and never re-mints them', () => {
    let values = formFromQuestion(QUESTION);
    values = setOptionText(values, 'server-c', '물의 온도를 높인다');
    const body = updateBody(values, REV, null);
    expect(body.options?.map((o) => o.id)).toEqual(['server-a', 'server-b', 'server-c']);
    expect(body.options?.[2]?.text).toBe('물의 온도를 높인다');
    expect(body.correct_option_ids).toEqual(['server-b']);
    expect(body.base_revision_id).toBe(REV);
    expect(body.chapter_id).toBe(CHAPTER);
    expect(body.sources).toEqual([{ document_id: DOC, page_start: 4, page_end: 4 }]);
    expect(body).not.toHaveProperty('question_type');
  });

  it('never reuses an id already in the question when the mint collides', () => {
    const values = mcq(['가']);
    const taken = values.options[0]?.id ?? '';
    const mints = [taken, taken, 'opt-fresh'];
    const next = addOption(values, () => mints.shift() ?? 'opt-x');
    expect(next.options.map((o) => o.id)).toEqual([taken, 'opt-fresh']);
  });
});

describe('sources on edit (provenance is kept unless they change)', () => {
  const base = sourceSnapshot(QUESTION);

  it('omits unchanged sources so the API keeps their pinned document revision', () => {
    const values = setOptionText(formFromQuestion(QUESTION), 'server-a', '색을 진하게');
    expect(base).toEqual([{ document_id: DOC, page_start: 4, page_end: 4 }]);
    expect(sourcesChanged(values, base)).toBe(false);
    expect(updateBody(values, REV, base)).not.toHaveProperty('sources');
  });

  it('sends sources when pages, documents or the list change', () => {
    const values = formFromQuestion(QUESTION);
    const key = values.sources[0]?.key ?? '';
    const paged = updateSource(values, key, { pageEnd: '5' });
    expect(updateBody(paged, REV, base).sources).toEqual([
      { document_id: DOC, page_start: 4, page_end: 5 },
    ]);
    const other = updateSource(values, key, { documentId: CHAPTER });
    expect(updateBody(other, REV, base)).toHaveProperty('sources');
    expect(updateBody(removeSource(values, key), REV, base).sources).toEqual([]);
    expect(updateBody(addSource(values, DOC), REV, base).sources).toHaveLength(2);
  });

  it('leaves a source of a deleted document alone when the edit does not touch sources', () => {
    const withDeleted: Question = {
      ...QUESTION,
      sources: [
        ...QUESTION.sources,
        { document_id: null, document_revision_id: null, page_start: 7, page_end: 7 },
      ],
    };
    const values = formFromQuestion(withDeleted);
    expect(updateBody(values, REV, sourceSnapshot(withDeleted))).not.toHaveProperty('sources');
  });

  it('re-reads the base snapshot sent by the client and sends sources when it is unusable', () => {
    expect(parseSourceSnapshot(JSON.parse(JSON.stringify(base)))).toEqual(base);
    expect(parseSourceSnapshot('x')).toBeNull();
    expect(parseSourceSnapshot([{ document_id: 1, page_start: null, page_end: null }])).toBeNull();
    expect(parseSourceSnapshot([{ document_id: DOC, page_start: 1.5, page_end: null }])).toBeNull();
    expect(updateBody(formFromQuestion(QUESTION), REV, null)).toHaveProperty('sources');
  });
});

describe('correct answers', () => {
  it('single answer keeps exactly one correct option', () => {
    let values = mcq(['가', '나', '다'], [0]);
    values = setOptionCorrect(values, values.options[2]?.id ?? '', true);
    expect(values.options.map((o) => o.correct)).toEqual([false, false, true]);
  });

  it('multi answer toggles independently and falls back to the first on switching back', () => {
    let values = mcq(['가', '나', '다'], [], true);
    values = setOptionCorrect(values, values.options[1]?.id ?? '', true);
    values = setOptionCorrect(values, values.options[2]?.id ?? '', true);
    expect(values.options.map((o) => o.correct)).toEqual([false, true, true]);
    values = setMultiAnswer(values, false);
    expect(values.options.map((o) => o.correct)).toEqual([false, true, false]);
    expect(contentBody(values).is_multi_answer).toBe(false);
  });
});

describe('validation (mirrors quiz_api.question_rules)', () => {
  it('accepts a complete MCQ', () => {
    expect(validateQuestionForm(mcq(['응결', '증발'], [1]))).toEqual({});
  });

  it('requires a stem, option texts, two options and a correct option', () => {
    const values = { ...mcq(['응결', ' ']), stem: '  ' };
    const errors = validateQuestionForm(values);
    expect(errors.stem).toBe(MESSAGES.stemRequired);
    expect(errors[optionKey(values.options[1]?.id ?? '')]).toBe(MESSAGES.optionRequired(2));
    expect(errors.correct).toBe(MESSAGES.correctRequired);
    expect(validateQuestionForm(mcq(['응결'], [0])).options).toBe(MESSAGES.tooFewOptions);
  });

  it('refuses NUL characters and lone surrogates like the API', () => {
    expect(validateQuestionForm({ ...mcq(['a', 'b'], [0]), stem: 'x\u0000' }).stem).toBe(
      MESSAGES.controlChars,
    );
    expect(validateQuestionForm({ ...mcq(['a', 'b'], [0]), stem: 'x\ud800' }).stem).toBe(
      MESSAGES.controlChars,
    );
    expect(validateQuestionForm({ ...mcq(['a', 'b'], [0]), stem: '😀' })).toEqual({});
  });

  it('counts code points for length limits', () => {
    const stem = '😀'.repeat(20000);
    expect(validateQuestionForm({ ...mcq(['a', 'b'], [0]), stem })).toEqual({});
    expect(validateQuestionForm({ ...mcq(['a', 'b'], [0]), stem: `${stem}a` }).stem).toBe(
      MESSAGES.stemTooLong,
    );
  });

  it('short answers: one per line, empty means not auto-gradable', () => {
    const base = { ...emptyForm(counter()), type: 'SHORT_ANSWER' as const, stem: '단계는?' };
    expect(validateQuestionForm(base)).toEqual({});
    expect(contentBody(base)).toMatchObject({
      options: [],
      correct_option_ids: null,
      accepted_answers: null,
      is_multi_answer: false,
    });
    const answered = { ...base, acceptedAnswers: ' 여과 \n\n침전\n' };
    expect(acceptedAnswerList(answered.acceptedAnswers)).toEqual(['여과', '침전']);
    expect(contentBody(answered).accepted_answers).toEqual(['여과', '침전']);
    const many = {
      ...base,
      acceptedAnswers: Array.from({ length: 51 }, (_, i) => `a${i}`).join('\n'),
    };
    expect(validateQuestionForm(many).acceptedAnswers).toBe(MESSAGES.acceptedTooMany);
  });

  it('essays send the rubric only', () => {
    const essay = {
      ...emptyForm(counter()),
      type: 'ESSAY' as const,
      stem: '서술하시오.',
      rubric: '침투 감소',
      acceptedAnswers: 'ignored',
    };
    expect(createBody(essay)).toMatchObject({
      question_type: 'ESSAY',
      publication_status: 'CONFIRMED',
      options: [],
      correct_option_ids: null,
      accepted_answers: null,
      rubric: '침투 감소',
      chapter_id: null,
      question_number: null,
      sources: [],
    });
  });

  it('checks the question number and source pages', () => {
    const values = { ...mcq(['a', 'b'], [0]), questionNumber: '0' };
    expect(validateQuestionForm(values).questionNumber).toBe(MESSAGES.questionNumber);
    const withSource: QuestionFormValues = {
      ...mcq(['a', 'b'], [0]),
      sources: [{ key: 's1', documentId: DOC, pageStart: '5', pageEnd: '4' }],
    };
    expect(validateQuestionForm(withSource)['source:s1']).toBe(MESSAGES.sourcePages);
    const ok: QuestionFormValues = {
      ...withSource,
      questionNumber: '12',
      sources: [{ key: 's1', documentId: DOC, pageStart: '4', pageEnd: '' }],
    };
    expect(validateQuestionForm(ok)).toEqual({});
    expect(createBody(ok)).toMatchObject({
      question_number: 12,
      sources: [{ document_id: DOC, page_start: 4, page_end: 4 }],
    });
  });
});

describe('API 422 → form fields', () => {
  it('maps body locs, resolving option and source indexes to their rows', () => {
    const values: QuestionFormValues = {
      ...mcq(['a', 'b', 'c'], [0]),
      sources: [{ key: 's1', documentId: DOC, pageStart: '1', pageEnd: '' }],
    };
    const errors = fieldErrorsFromIssues(
      [
        { loc: ['body', 'stem'], msg: 'Must not be blank.' },
        { loc: ['body', 'options', 2, 'text'], msg: 'Must not be blank.' },
        { loc: ['body', 'correct_option_ids', 0], msg: 'unknown' },
        { loc: ['body', 'chapter_id'], msg: 'not current' },
        { loc: ['body', 'sources', 0, 'document_id'], msg: 'unknown' },
        { loc: ['body', 'something_else'], msg: 'x' },
      ],
      values,
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        'stem',
        optionKey(values.options[2]?.id ?? ''),
        'correct',
        'chapterId',
        'source:s1',
        'form',
      ].sort(),
    );
    // Korean messages only; the API's English text never reaches the UI.
    for (const message of Object.values(errors)) expect(message).not.toMatch(/[A-Za-z]{4,}/);
    expect(errorSummary(errors, values)[0]).toBe(errors.form);
  });
});

describe('problem classification', () => {
  const problem = (type: string, extra = {}) => ({ type, title: 't', status: 0, ...extra });
  it('distinguishes stale revisions, idempotency conflicts and role/archive refusals', () => {
    expect(classifyQuestionFailure(409, problem(QUESTION_PROBLEM_TYPES.staleRevision)).kind).toBe(
      'staleRevision',
    );
    expect(
      classifyQuestionFailure(409, problem(QUESTION_PROBLEM_TYPES.idempotencyKeyReused)).kind,
    ).toBe('idempotencyKeyReused');
    expect(
      classifyQuestionFailure(403, problem(QUESTION_PROBLEM_TYPES.workspaceArchived)).kind,
    ).toBe('archived');
    expect(
      classifyQuestionFailure(403, problem(QUESTION_PROBLEM_TYPES.insufficientRole)).kind,
    ).toBe('forbidden');
    expect(classifyQuestionFailure(404, undefined).kind).toBe('notFound');
    expect(classifyQuestionFailure(401, 'x').kind).toBe('unauthenticated');
    expect(classifyQuestionFailure(500, null).kind).toBe('unavailable');
  });

  it('keeps well-formed 422 issues and drops malformed ones', () => {
    const failure = classifyQuestionFailure(
      422,
      problem('about:blank', {
        errors: [
          { loc: ['body', 'options', 1, 'text'], msg: 'blank', type: 'value_error' },
          { loc: 'nope', msg: 'bad' },
          null,
        ],
      }),
    );
    expect(failure).toEqual({
      kind: 'invalid',
      issues: [{ loc: ['body', 'options', 1, 'text'], msg: 'blank', type: 'value_error' }],
    });
  });
});

describe('untrusted form values (server actions)', () => {
  it('accepts a real form and rejects malformed input', () => {
    const values = mcq(['a', 'b'], [0]);
    expect(parseFormValues(JSON.parse(JSON.stringify(values)))).toEqual(values);
    expect(parseFormValues(null)).toBeNull();
    expect(parseFormValues({ ...values, type: 'TRUE_FALSE' })).toBeNull();
    expect(
      parseFormValues({ ...values, options: [{ id: 1, text: 'a', correct: true }] }),
    ).toBeNull();
    expect(parseFormValues({ ...values, stem: 42 })).toBeNull();
    expect(parseFormValues({ ...values, extra: 'dropped' })).not.toHaveProperty('extra');
  });
});

describe('URL filter state', () => {
  it('round-trips and drops unknown values', () => {
    const filters = parseBankFilters({
      q: '  자갈 ',
      type: 'ESSAY',
      chapter: CHAPTER.toUpperCase(),
      status: 'ALL',
    });
    expect(filters).toEqual({ q: '자갈', type: 'ESSAY', chapter: CHAPTER, status: 'ALL' });
    expect(parseBankFilters(new URLSearchParams(serializeBankFilters(filters)))).toEqual(filters);
    expect(parseBankFilters({ type: 'X', chapter: 'not-a-uuid', status: 'nope' })).toEqual({
      q: '',
      type: null,
      chapter: null,
      status: 'CONFIRMED',
    });
    expect(serializeBankFilters(parseBankFilters({}))).toBe('');
    expect(statusQuery('ALL')).toEqual(['CONFIRMED', 'DRAFT', 'ARCHIVED']);
    expect(statusQuery('DRAFT')).toEqual(['DRAFT']);
  });
});
