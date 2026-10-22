// QuestionDraftReview model (QIMPORT-01, shared with QGEN-01): normalization of API drafts, the
// draft editor's validation and request bodies, and the approve-then-publish selection — logic
// the E2E specs only observe indirectly (which version is sent, that an unknown answer stays null,
// that the API's English validation text never reaches the UI).
import { describe, expect, it, vi } from 'vitest';
import {
  applyPublished,
  approvalBlocker,
  approvePublishInBatches,
  approvePublishSelection,
  initialSelection,
  pruneSelection,
  refusedMessage,
  selectAllScope,
  selectAllState,
  selectionBlocker,
  toggleAll,
  toggleOne,
  draftUpdateBody,
  formFromDraft,
  issueMessage,
  PUBLISH_BATCH_SIZE,
  publishBatches,
  publishedMessage,
  publishInBatches,
  publishSelection,
  replaceDraft,
  reviewBody,
  reviewDraftFromImport,
  sortDrafts,
  validateDraftForm,
  type ImportDraft,
  type ReviewDraft,
} from '../src/lib/questions/drafts';
import { MESSAGES } from '../src/lib/questions/form';

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

const DOC = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';

function importDraft(overrides: Partial<ImportDraft> = {}, payload: object = {}): ImportDraft {
  const base: ImportDraft = {
    id: '11111111-1111-4111-8111-000000000003',
    import_id: RUN,
    position: 2,
    question_number: 3,
    question_type: 'MCQ',
    is_multi_answer: false,
    rubric: null,
    review_status: 'pending',
    published_question_id: null,
    validations: [
      {
        code: 'answer_missing',
        severity: 'warning',
        message: 'No answer in the source.',
        field: 'correct_option_ids',
      },
    ],
    answer_missing: true,
    pages: [2],
    publishable: false,
    publish_errors: [{ field: 'correct_option_ids', message: 'needs an answer' }],
    version: 'v1',
    reviewed_at: null,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    payload: {
      schema_version: 1,
      id: `${DOC}-q003`,
      origin: 'pdf_import',
      question_type: 'MCQ',
      stem: '물이 기체로 변하는 현상은?',
      options: [
        { id: 'o1', text: '응고' },
        { id: 'o2', text: '증발' },
      ],
      correct_option_ids: null,
      accepted_answers: null,
      evidence: [
        {
          document_id: DOC,
          locations: [
            { page: 2, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
            { page: 2, bbox: null },
          ],
        },
      ],
      validations: [],
      review_status: 'pending',
      ...payload,
    },
    ...overrides,
  };
  return base;
}

describe('reviewDraftFromImport', () => {
  it('keeps a missing answer null and links the source pages', () => {
    const draft = reviewDraftFromImport(importDraft());
    expect(draft.correctOptionIds).toBeNull();
    expect(draft.acceptedAnswers).toBeNull();
    expect(draft.answerMissing).toBe(true);
    expect(draft.options.every((o) => !o.correct)).toBe(true);
    expect(draft.sourceDocumentId).toBe(DOC);
    expect(draft.pages).toEqual([2]);
    expect(draft.locations).toEqual([
      { page: 2, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
      { page: 2, bbox: null },
    ]);
    // "정답 없음" is shown from answer_missing, not as a second validation note.
    expect(draft.issues).toEqual([]);
  });

  it('marks the correct options by id', () => {
    const draft = reviewDraftFromImport(
      importDraft({ answer_missing: false }, { correct_option_ids: ['o2'] }),
    );
    expect(draft.options.map((o) => o.correct)).toEqual([false, true]);
  });

  it('falls back to evidence pages and sorts them', () => {
    const draft = reviewDraftFromImport(
      importDraft(
        { pages: [] },
        {
          evidence: [
            {
              document_id: DOC,
              locations: [{ page: 5 }, { page: 4 }, { page: 5 }],
            },
          ],
        },
      ),
    );
    expect(draft.pages).toEqual([4, 5]);
  });
});

describe('issueMessage', () => {
  it('is Korean for known and unknown codes (never the API text)', () => {
    expect(issueMessage('answer_not_in_options')).toMatch(/정답/);
    expect(issueMessage('something_new')).toBe('확인이 필요한 항목이 있습니다.');
    expect(issueMessage('something_new')).not.toMatch(/no answer/i);
  });
});

describe('approvalBlocker', () => {
  it('asks for a correct option on an MCQ without an answer', () => {
    expect(approvalBlocker(reviewDraftFromImport(importDraft()))).toMatch(/정답 보기/);
  });

  it('is null for publishable, approved or published drafts', () => {
    const ok = reviewDraftFromImport(importDraft({ publishable: true }));
    expect(approvalBlocker(ok)).toBeNull();
    expect(approvalBlocker({ ...ok, publishable: false, reviewStatus: 'approved' })).toBeNull();
    expect(approvalBlocker({ ...ok, publishable: false, publishedQuestionId: 'q' })).toBeNull();
  });
});

describe('draft editor', () => {
  const draft = reviewDraftFromImport(importDraft());

  it('allows saving an MCQ without an answer, but not two answers on a single-answer MCQ', () => {
    const values = formFromDraft(draft);
    expect(validateDraftForm(values)).toEqual({});
    const two = {
      ...values,
      options: values.options.map((o) => ({ ...o, correct: true })),
    };
    expect(validateDraftForm(two).correct).toBe(MESSAGES.singleAnswer);
    expect(validateDraftForm({ ...values, stem: ' ' }).stem).toBe(MESSAGES.stemRequired);
  });

  it('sends the edit on top of the opened version with option ids kept', () => {
    const values = formFromDraft(draft);
    const answered = {
      ...values,
      options: values.options.map((o) => ({ ...o, correct: o.text === '증발' })),
    };
    expect(draftUpdateBody(answered, 'v1')).toEqual({
      base_version: 'v1',
      question_type: 'MCQ',
      stem: draft.stem,
      options: [
        { id: 'o1', text: '응고' },
        { id: 'o2', text: '증발' },
      ],
      correct_option_ids: ['o2'],
      is_multi_answer: false,
      accepted_answers: null,
      explanation: null,
      rubric: null,
      question_number: 3,
    });
    // No answer chosen stays unknown (null), never an empty list.
    expect(draftUpdateBody(values, 'v1').correct_option_ids).toBeNull();
  });

  it('maps short answers and essay rubrics by type', () => {
    const values = formFromDraft(draft);
    const short = draftUpdateBody(
      { ...values, type: 'SHORT_ANSWER', acceptedAnswers: ' 증발 \n\n기화 ' },
      'v2',
    );
    expect(short).toMatchObject({
      question_type: 'SHORT_ANSWER',
      options: [],
      correct_option_ids: null,
      accepted_answers: ['증발', '기화'],
      rubric: null,
    });
    const essay = draftUpdateBody({ ...values, type: 'ESSAY', rubric: '모범 답안' }, 'v2');
    expect(essay).toMatchObject({ accepted_answers: null, rubric: '모범 답안' });
    expect(draftUpdateBody({ ...values, questionNumber: '' }, 'v2').question_number).toBeNull();
  });
});

describe('approve then publish', () => {
  const drafts: ReviewDraft[] = [
    { ...reviewDraftFromImport(importDraft()), id: 'a', version: 'va', reviewStatus: 'approved' },
    { ...reviewDraftFromImport(importDraft()), id: 'b', version: 'vb', reviewStatus: 'pending' },
    {
      ...reviewDraftFromImport(importDraft()),
      id: 'c',
      version: 'vc',
      reviewStatus: 'approved',
      publishedQuestionId: 'q-c',
    },
    { ...reviewDraftFromImport(importDraft()), id: 'd', version: 'vd', reviewStatus: 'rejected' },
  ];

  it('reviews exactly the version on screen', () => {
    expect(reviewBody(at(drafts, 1), true)).toEqual({
      base_version: 'vb',
      review_status: 'approved',
    });
    expect(reviewBody(at(drafts, 0), false)).toEqual({
      base_version: 'va',
      review_status: 'pending',
    });
  });

  it('publishes only approved, unregistered drafts at their approved version', () => {
    expect(publishSelection(drafts)).toEqual([{ draft_id: 'a', version: 'va' }]);
  });

  it('marks published drafts and reports the count', () => {
    const next = applyPublished(drafts, [{ draft_id: 'a', question_id: 'q-a' }]);
    expect(next.map((d) => d.publishedQuestionId)).toEqual(['q-a', null, 'q-c', null]);
    expect(publishSelection(next)).toEqual([]);
    expect(publishedMessage(2)).toMatch(/2\s*개.*등록/);
  });

  it('replaces and sorts drafts by source position', () => {
    const replaced = replaceDraft(drafts, { ...at(drafts, 1), version: 'vb2' });
    expect(replaced[1]?.version).toBe('vb2');
    const sorted = sortDrafts([
      { ...at(drafts, 0), position: 3 },
      { ...at(drafts, 1), position: 0 },
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe('publish batches (API MAX_PUBLISH = 200)', () => {
  const refs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ draft_id: `d${i}`, version: `v${i}` }));

  it('splits a selection into requests of at most 200 drafts', () => {
    expect(PUBLISH_BATCH_SIZE).toBe(200);
    expect(publishBatches(refs(450)).map((b) => b.length)).toEqual([200, 200, 50]);
    expect(publishBatches(refs(200)).map((b) => b.length)).toEqual([200]);
    expect(publishBatches([])).toEqual([]);
  });

  it('sends batches in order and reports each success', async () => {
    const send = vi.fn(async (batch: readonly { draft_id: string }[]) =>
      batch.map((r) => ({ draft_id: r.draft_id, question_id: `q-${r.draft_id}` })),
    );
    const onBatch = vi.fn();
    const items = await publishInBatches(refs(401), send, onBatch);
    expect(send.mock.calls.map(([b]) => b.length)).toEqual([200, 200, 1]);
    expect(onBatch).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(401);
  });

  it('stops at a failed batch after reporting the earlier ones; the retry sends only the rest', async () => {
    let calls = 0;
    const send = vi.fn(async (batch: readonly { draft_id: string }[]) => {
      calls += 1;
      if (calls === 2) throw new Error('lost');
      return batch.map((r) => ({ draft_id: r.draft_id, question_id: `q-${r.draft_id}` }));
    });
    const done = new Set<string>();
    const onBatch = (items: readonly { draft_id: string }[]) => {
      for (const i of items) done.add(i.draft_id);
    };
    const all = refs(450);
    await expect(publishInBatches(all, send, onBatch)).rejects.toThrow('lost');
    expect(done.size).toBe(200);

    // The screen recomputes the selection from drafts not yet marked published.
    const rest = all.filter((r) => !done.has(r.draft_id));
    await publishInBatches(rest, send, onBatch);
    expect(send.mock.calls.slice(2).map(([b]) => b.length)).toEqual([200, 50]);
    expect(done.size).toBe(450);
  });
});

describe('selection (QIMP-BULK)', () => {
  function rd(id: string, position: number, overrides: Partial<ReviewDraft> = {}): ReviewDraft {
    return {
      ...reviewDraftFromImport(importDraft({ id, position, question_number: position + 1 })),
      version: `v-${id}`,
      publishable: true,
      correctOptionIds: ['o1'],
      answerMissing: false,
      ...overrides,
    };
  }
  const drafts: ReviewDraft[] = [
    rd('a', 0),
    rd('b', 1, { reviewStatus: 'approved' }),
    rd('c', 2, { publishable: false, correctOptionIds: null, answerMissing: true }),
    rd('d', 3, { publishedQuestionId: 'q-d', reviewStatus: 'approved' }),
    rd('e', 4, { reviewStatus: 'rejected' }),
    rd('f', 5, { type: 'SHORT_ANSWER', answerMissing: true, correctOptionIds: null }),
    rd('g', 6, { issues: [{ code: 'provenance_missing', severity: 'warning' }] }),
  ];
  const ids = (set: ReadonlySet<string>) => [...set].sort();

  it('"전체 선택" covers unregistered, confirmable drafts with nothing to check', () => {
    expect(selectAllScope(drafts).map((d) => d.id)).toEqual(['a', 'b']);
    expect(selectionBlocker(at(drafts, 2))).toContain('정답 보기를 지정해야');
    expect(selectionBlocker(at(drafts, 0))).toBeNull();
    expect(selectionBlocker(at(drafts, 3))).toBeNull();
  });

  it('select all / none / indeterminate', () => {
    const none = new Set<string>();
    expect(selectAllState(drafts, none)).toBe(false);
    const all = toggleAll(drafts, none, true);
    expect(ids(all)).toEqual(['a', 'b']);
    expect(selectAllState(drafts, all)).toBe(true);
    const partial = toggleOne(all, 'a', false);
    expect(selectAllState(drafts, partial)).toBe('indeterminate');
    expect(ids(toggleAll(drafts, partial, false))).toEqual([]);
    // An individually selected rejected draft is kept by "select all" and counts as partial alone.
    const rejected = toggleOne(none, 'e', true);
    expect(selectAllState(drafts, rejected)).toBe('indeterminate');
    expect(ids(toggleAll(drafts, rejected, true))).toEqual(['a', 'b', 'e']);
    // Drafts without an answer or with a note are selectable one by one only.
    expect(ids(toggleOne(toggleOne(none, 'f', true), 'g', true))).toEqual(['f', 'g']);
    expect(selectAllState(drafts, toggleAll(drafts, rejected, true))).toBe(true);
  });

  it('registered, blocked or unknown ids are never selected or sent', () => {
    const raw = new Set(['a', 'c', 'd', 'zzz']);
    expect(ids(pruneSelection(drafts, raw))).toEqual(['a']);
    expect(selectAllState(drafts, new Set(['c', 'd']))).toBe(false);
    expect(approvePublishSelection(drafts, new Set(['e', 'a', 'd']))).toEqual([
      { draft_id: 'a', version: 'v-a' },
      { draft_id: 'e', version: 'v-e' },
    ]);
    expect(ids(initialSelection(drafts))).toEqual(['b']);
  });

  it('approves and registers in batches, collecting refusals instead of throwing', async () => {
    const refs = Array.from({ length: 401 }, (_, i) => ({ draft_id: `d${i}`, version: 'v' }));
    const send = vi.fn(async (batch: readonly { draft_id: string }[]) => ({
      items: batch.slice(1).map((r) => ({ draft_id: r.draft_id, question_id: `q-${r.draft_id}` })),
      refused: [{ draft_id: at(batch, 0).draft_id, reason: 'stale-draft' as const }],
    }));
    const progress: number[] = [];
    const out = await approvePublishInBatches(refs, send, (_, done) => progress.push(done));
    expect(send.mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 1]);
    expect(progress).toEqual([200, 400, 401]);
    expect(out.items).toHaveLength(398);
    expect(out.refused.map((r) => r.draft_id)).toEqual(['d0', 'd200', 'd400']);
  });

  it('names refused drafts by number and reason', () => {
    expect(
      refusedMessage(drafts, [
        { draft_id: 'a', reason: 'stale-draft' },
        { draft_id: 'c', reason: 'not-publishable' },
      ]),
    ).toBe(
      '2개는 등록하지 못했습니다: 1번(다른 곳에서 바뀜), 3번(승인 불가 항목 있음). 선택은 그대로 두었으니 확인한 뒤 다시 등록해 주세요.',
    );
  });
});
