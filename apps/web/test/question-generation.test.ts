// QGEN-01 model (M6.3): word diff of a variant against its source, the form's request rules
// (보기 섞기 never starts a run), the generation relay client's failure mapping, and the
// generation fields of the shared draft model — logic the E2E specs only observe indirectly.
import { describe, expect, it, vi } from 'vitest';
import {
  confirmTypeBody,
  formFromDraft,
  generationDraftUpdateBody,
  issueMessage,
  reviewDraftFromImport,
  type ImportDraft,
} from '../src/lib/questions/drafts';
import {
  classifyGenerationFailure,
  createGenerationClient,
  GENERATION_BFF_PATHS,
  GenerationApiError,
  runFailureMessage,
} from '../src/lib/questions/generation-client';
import {
  bodyKey,
  generationRequest,
  parseCandidateCount,
  runLabel,
  toggleVariation,
  unregisteredCount,
  upsertRun,
  variationBlocker,
} from '../src/lib/questions/generation-model';
import { generatePath, type GenerationRun } from '../src/lib/questions/generation-client';
import {
  diffOptions,
  diffWords,
  MAX_DIFF_CELLS,
  tokenize,
  unchanged,
} from '../src/lib/questions/variation-diff';

const joined = (segments: { kind: string; text: string }[], kind: string) =>
  segments
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join('|');

describe('diffWords', () => {
  it('marks the reworded words of a paraphrase (QGEN-01-AC02)', () => {
    const segments = diffWords(
      '정수 처리의 마지막 단계에서 남아 있는 병원성 미생물을 줄이기 위해 넣는 물질은?',
      '정수장에서 병원성 미생물을 줄이려고 마지막에 투입하는 소독제는 무엇인가?',
    );
    expect(joined(segments, 'insert')).toContain('투입하는');
    expect(joined(segments, 'delete')).toContain('넣는');
    expect(joined(segments, 'same')).toContain('병원성 미생물을');
  });

  it('reconstructs both texts from the segments', () => {
    const before = '  옳지 않은 것은?\n 보기  둘';
    const after = '옳은 것은?  보기 셋';
    const segments = diffWords(before, after);
    const afterText = segments
      .filter((s) => s.kind !== 'delete')
      .map((s) => s.text)
      .join('');
    expect(afterText.replace(/\s+/g, ' ').trim()).toBe(after.replace(/\s+/g, ' ').trim());
    expect(
      segments
        .filter((s) => s.kind !== 'insert')
        .map((s) => s.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(before.replace(/\s+/g, ' ').trim());
  });

  it('reports an unchanged stem and merges adjacent runs', () => {
    const same = diffWords('a b c', 'a b c');
    expect(unchanged(same)).toBe(true);
    expect(same).toHaveLength(1);
    expect(unchanged(diffWords('a', 'b'))).toBe(false);
  });

  it('falls back to a full replacement for huge inputs', () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1 }, (_, i) => `w${i}`);
    const segments = diffWords(big.join(' '), `${big.join(' ')} 끝`);
    expect(segments.map((s) => s.kind)).toEqual(['delete', 'insert']);
  });

  it('tokenizes words with their trailing whitespace', () => {
    expect(tokenize(' a  b')).toEqual([' ', 'a  ', 'b']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('diffOptions', () => {
  const original = [
    { id: 'opt-1', text: '가', correct: false },
    { id: 'opt-2', text: '나', correct: false },
    { id: 'opt-3', text: '다', correct: true },
  ];

  it('flags options whose correctness flipped in an inversion (QGEN-01-AC03)', () => {
    const inverted = original.map((o) => ({ ...o, correct: !o.correct }));
    const diff = diffOptions(original, inverted);
    expect(diff.map((d) => d.change)).toEqual(['same', 'same', 'same']);
    expect(diff.every((d) => d.answerChanged)).toBe(true);
  });

  it('matches by text in any order, pairs the rest by position and lists removed ones last', () => {
    const variant = [
      { id: 'opt-1', text: '다', correct: true },
      { id: 'opt-2', text: '나 바뀜', correct: false },
      { id: 'opt-3', text: '가', correct: false },
      { id: 'opt-4', text: '라', correct: false },
    ];
    const diff = diffOptions([...original, { id: 'opt-4', text: '마', correct: false }], variant);
    expect(diff.map((d) => d.change)).toEqual(['same', 'changed', 'same', 'changed']);
    expect(diff[1]?.segments.some((s) => s.kind === 'insert' && s.text.includes('바뀜'))).toBe(
      true,
    );
    const shorter = diffOptions(original, [{ id: 'x', text: '새 보기', correct: true }]);
    expect(shorter.map((d) => d.change)).toEqual(['changed', 'removed', 'removed']);
  });

  it('marks options of a different-length variant as added', () => {
    const diff = diffOptions([], [{ id: 'a', text: '하나', correct: true }]);
    expect(diff).toMatchObject([{ change: 'added', segments: [{ kind: 'insert' }] }]);
  });
});

describe('generation form model', () => {
  const mcq = { questionType: 'MCQ' as const, confirmed: true };

  it('keeps 보기 섞기 exclusive with the LLM variations', () => {
    expect(toggleVariation(['PARAPHRASE'], 'OPTION_SHUFFLE', true)).toEqual(['OPTION_SHUFFLE']);
    expect(toggleVariation(['OPTION_SHUFFLE'], 'ANALOGOUS_CONCEPT', true)).toEqual([
      'ANALOGOUS_CONCEPT',
    ]);
    expect(toggleVariation(['ANALOGOUS_CONCEPT'], 'PARAPHRASE', true)).toEqual([
      'PARAPHRASE',
      'ANALOGOUS_CONCEPT',
    ]);
    expect(toggleVariation(['PARAPHRASE', 'INVERT_POLARITY'], 'PARAPHRASE', false)).toEqual([
      'INVERT_POLARITY',
    ]);
  });

  it('shuffles instead of starting a run (QGEN-01-AC01)', () => {
    expect(generationRequest(['OPTION_SHUFFLE'], 'x', null)).toEqual({ kind: 'shuffle' });
  });

  it('builds the run body in a stable order and validates the count', () => {
    expect(generationRequest(['ANALOGOUS_CONCEPT', 'PARAPHRASE'], '3', 'harder')).toEqual({
      kind: 'generate',
      body: {
        variation_types: ['PARAPHRASE', 'ANALOGOUS_CONCEPT'],
        candidate_count: 3,
        difficulty: 'harder',
      },
    });
    expect(generationRequest(['PARAPHRASE'], '1', null)).toEqual({
      kind: 'generate',
      body: { variation_types: ['PARAPHRASE'], candidate_count: 1 },
    });
    expect(generationRequest([], '1', null)).toMatchObject({
      kind: 'invalid',
      field: 'variations',
    });
    expect(generationRequest(['PARAPHRASE'], '21', null)).toMatchObject({
      kind: 'invalid',
      field: 'count',
    });
    expect(parseCandidateCount(' 20 ')).toBe(20);
    expect(parseCandidateCount('0')).toBeNull();
    expect(parseCandidateCount('1.5')).toBeNull();
  });

  it('gives the same idempotency body key only to identical requests', () => {
    const a = bodyKey({ variation_types: ['PARAPHRASE'], candidate_count: 1 });
    expect(bodyKey({ variation_types: ['PARAPHRASE'], candidate_count: 1, difficulty: null })).toBe(
      a,
    );
    expect(bodyKey({ variation_types: ['PARAPHRASE'], candidate_count: 2 })).not.toBe(a);
  });

  it('explains which variations a source cannot use', () => {
    expect(variationBlocker('PARAPHRASE', mcq)).toBeNull();
    expect(variationBlocker('PARAPHRASE', { ...mcq, confirmed: false })).toMatch(/확정/);
    expect(variationBlocker('OPTION_SHUFFLE', { ...mcq, questionType: 'ESSAY' })).toMatch(/객관식/);
    // A source without cited pages can still be varied: the worker searches related passages.
    expect(variationBlocker('ANALOGOUS_CONCEPT', mcq)).toBeNull();
  });
});

describe('generation client', () => {
  it('maps API problems to Korean failure kinds', () => {
    const problem = (slug: string) => ({ type: `urn:quiz-workspace:problem:${slug}` });
    expect(classifyGenerationFailure(409, problem('question-not-confirmed'))).toBe('notConfirmed');
    expect(classifyGenerationFailure(403, problem('workspace-archived'))).toBe('archived');
    expect(classifyGenerationFailure(403, problem('insufficient-role'))).toBe('forbidden');
    expect(classifyGenerationFailure(409, problem('stale-draft'))).toBe('staleDraft');
    expect(classifyGenerationFailure(422, {})).toBe('invalid');
    expect(classifyGenerationFailure(409, problem('duplicate-question'))).toBe('duplicateQuestion');
    expect(classifyGenerationFailure(404, undefined)).toBe('notFound');
    expect(classifyGenerationFailure(500, undefined)).toBe('unavailable');
  });

  it('explains failed runs by error code without the API text', () => {
    expect(runFailureMessage('llm_output_invalid')).toMatch(/응답 형식.*\(llm_output_invalid\)/);
    expect(runFailureMessage('something_new')).toMatch(/알 수 없는 오류/);
    expect(runFailureMessage('source_passages_missing')).toMatch(/원문을 찾지 못했습니다/);
    expect(runFailureMessage('search_unavailable')).toMatch(/검색하지 못했습니다/);
  });

  it('sends the Idempotency-Key on start and reads the newest run of the source', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('question-generations?')
        ? Response.json({ items: [{ id: 'run-1' }] })
        : Response.json({ id: 'run-2' }, { status: 202 }),
    );
    const client = createGenerationClient(fetchImpl);
    await client.startGeneration(
      'q-1',
      { variation_types: ['PARAPHRASE'], candidate_count: 1 },
      'key-1',
    );
    const [path, init] = fetchImpl.mock.calls[0] ?? [];
    expect(path).toBe(GENERATION_BFF_PATHS.start('q-1'));
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
    expect(await client.listRuns('ws', 'q-1', 20)).toEqual([{ id: 'run-1' }]);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      '/api/workspaces/ws/question-generations?source_question_id=q-1&limit=20',
    );
  });

  it('rejects with a typed error (network vs. answered)', async () => {
    const offline = createGenerationClient(async () => {
      throw new TypeError('offline');
    });
    await expect(offline.getRun('r')).rejects.toMatchObject({ kind: 'network' });
    const refused = createGenerationClient(async () =>
      Response.json({ type: 'urn:quiz-workspace:problem:draft-not-approved' }, { status: 409 }),
    );
    const error = await refused.publish('r', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationApiError);
    expect(error).toMatchObject({ kind: 'draftNotApproved', status: 409 });
  });
});

function generationDraft(overrides: Partial<ImportDraft> = {}): ImportDraft {
  return {
    id: '11111111-1111-4111-8111-000000000001',
    import_id: null,
    run_id: '22222222-2222-4222-8222-222222222222',
    variation_type: 'INVERT_POLARITY',
    acknowledged_codes: [],
    position: 0,
    question_number: null,
    question_type: 'MCQ',
    is_multi_answer: false,
    rubric: null,
    review_status: 'pending',
    published_question_id: null,
    validations: [
      {
        code: 'inverted_answer_mismatch',
        severity: 'error',
        message: 'The inversion keeps the original options...',
        field: 'correct_option_ids',
      },
    ],
    answer_missing: false,
    pages: [4],
    publishable: false,
    publish_errors: [],
    version: 'v1',
    reviewed_at: null,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    payload: {
      schema_version: 1,
      id: 'gen-run-invert_polarity-01',
      origin: 'generation',
      question_type: 'MCQ',
      stem: '정수 처리 과정에 대한 설명으로 옳은 것은?',
      options: [
        { id: 'opt-1', text: '가' },
        { id: 'opt-2', text: '나' },
      ],
      correct_option_ids: ['opt-1'],
      accepted_answers: null,
      explanation: null,
      review_status: 'pending',
      validations: [],
      variation_type: 'INVERT_POLARITY',
      parent_question_id: '33333333-3333-4333-8333-333333333333',
      source_question_revision_id: '44444444-4444-4444-8444-444444444444',
      justification: "'옳지 않은 것'을 '옳은 것'으로 바꾸었다.",
      generator: { model: 'fake', prompt_version: 'questions.generate.invert_polarity/v1' },
      evidence: [
        {
          document_id: 'doc-1',
          revision_id: 'rev-1',
          block_ids: ['b2', 'b1'],
          locations: [
            { page: 5, block_id: 'b2', bbox: null },
            { page: 4, block_id: 'b1', bbox: null },
            { page: 4, block_id: 'b3', bbox: null },
          ],
          quote: '이 덩어리를 플록이라고 부른다.',
        },
      ],
    },
    ...overrides,
  } as ImportDraft;
}

describe('generation drafts in the shared review model', () => {
  it('keeps the variation, justification, cited pages and quote', () => {
    const draft = reviewDraftFromImport(generationDraft());
    expect(draft.origin).toBe('generation');
    expect(draft.sourceDocumentId).toBe('doc-1');
    expect(draft.generation).toEqual({
      variationType: 'INVERT_POLARITY',
      parentQuestionId: '33333333-3333-4333-8333-333333333333',
      sourceRevisionId: '44444444-4444-4444-8444-444444444444',
      justification: "'옳지 않은 것'을 '옳은 것'으로 바꾸었다.",
      evidence: [{ documentId: 'doc-1', pages: [4, 5], quote: '이 덩어리를 플록이라고 부른다.' }],
      acknowledgedCodes: [],
    });
    expect(draft.issues).toEqual([{ code: 'inverted_answer_mismatch', severity: 'error' }]);
  });

  it('shows the inverted-answer error as a Korean "복수 정답" warning', () => {
    expect(issueMessage('inverted_answer_mismatch')).toMatch(/^복수 정답/);
    expect(issueMessage('inverted_answer_mismatch')).not.toMatch(/inversion/);
  });

  it('import drafts carry no generation info', () => {
    const draft = reviewDraftFromImport(
      generationDraft({
        payload: { ...generationDraft().payload, origin: 'pdf_import' },
      }),
    );
    expect(draft.generation).toBeUndefined();
  });

  it('confirms a changed question type only explicitly or by changing it in the editor', () => {
    const draft = reviewDraftFromImport(generationDraft());
    const values = formFromDraft(draft);
    const edit = generationDraftUpdateBody({ ...values, stem: '고친 문제' }, draft, 'v1');
    expect(edit).not.toHaveProperty('question_type');
    expect(edit).toMatchObject({ base_version: 'v1', stem: '고친 문제', is_multi_answer: false });
    const multi = generationDraftUpdateBody(
      {
        ...values,
        multiAnswer: true,
        options: values.options.map((o) => ({ ...o, correct: true })),
      },
      draft,
      'v1',
    );
    expect(multi).toMatchObject({ is_multi_answer: true, correct_option_ids: ['opt-1', 'opt-2'] });
    expect(
      generationDraftUpdateBody({ ...values, type: 'SHORT_ANSWER' }, draft, 'v1'),
    ).toMatchObject({ question_type: 'SHORT_ANSWER' });
    expect(confirmTypeBody(draft)).toEqual({ base_version: 'v1', question_type: 'MCQ' });
  });
});

describe('run history', () => {
  function run(id: string, createdAt: string, overrides: Partial<GenerationRun> = {}) {
    return {
      id,
      created_at: createdAt,
      status: 'succeeded',
      variation_types: ['PARAPHRASE'],
      draft_count: 3,
      published_count: 1,
      ...overrides,
    } as GenerationRun;
  }

  it('keeps earlier runs, newest first, replacing an updated run in place', () => {
    const older = run('a', '2026-10-17T00:00:00Z');
    const newer = run('b', '2026-10-18T00:00:00Z', { status: 'running' });
    const list = upsertRun(upsertRun([older], newer), { ...newer, status: 'failed' });
    expect(list.map((r) => [r.id, r.status])).toEqual([
      ['b', 'failed'],
      ['a', 'succeeded'],
    ]);
  });

  it('labels each run with its variations, outcome and unregistered drafts', () => {
    expect(unregisteredCount(run('a', 'x'))).toBe(2);
    expect(runLabel(run('a', 'T'), (t) => t)).toBe('T · 문구 변형 · 완료 · 미등록 초안 2개');
    expect(runLabel(run('a', 'T', { published_count: 3 }), (t) => t)).toMatch(/모두 등록$/);
    expect(runLabel(run('a', 'T', { status: 'failed', draft_count: 0 }), (t) => t)).toBe(
      'T · 문구 변형 · 실패',
    );
  });

  it('puts the selected run into the screen URL', () => {
    expect(generatePath('ws', 'q', 'r')).toBe('/workspaces/ws/questions/generate?source=q&run=r');
    expect(generatePath('ws', 'q')).toBe('/workspaces/ws/questions/generate?source=q');
  });
});
