// DOCVIEW (DOC-02-AC11): which questions become question cards, where, and what the folded answer
// section says.
import { describe, expect, it } from 'vitest';
import {
  answerLines,
  documentQuestions,
  optionLabel,
  type QuestionLike,
} from '../src/lib/documents/document-questions';
import type { ContentBlock } from '../src/lib/documents/editor-api';
import { pageGroups, selectionHighlights } from '../src/lib/documents/text-groups';

const DOC = 'doc-1';
const revision = (overrides: Partial<QuestionLike['revision']> = {}): QuestionLike['revision'] => ({
  id: 'r',
  version: 1,
  stem: '물이 기체로 변하는 과정은?',
  options: [
    { id: 'o1', text: '응결' },
    { id: 'o2', text: '증발' },
  ],
  correct_option_ids: ['o2'],
  accepted_answers: null,
  is_multi_answer: false,
  explanation: null,
  rubric: null,
  created_at: '2026-11-01T00:00:00Z',
  ...overrides,
});
const question = (id: string, sources: QuestionLike['sources'], number = 1): QuestionLike => ({
  id,
  question_number: number,
  question_type: 'MCQ',
  revision: revision(),
  sources,
});

const box = (y: number) => ({ x0: 10, y0: y, x1: 100, y1: y + 10 });
const block = (id: string, page: number, y = 0): ContentBlock => ({
  block_id: id,
  caption_block_id: null,
  chapter_id: null,
  edited: false,
  heading_level: null,
  locations: [{ page, bbox: box(y) }],
  ordinal: 0,
  page,
  table: null,
  text: id,
  type: 'text',
  version: 'v',
});

describe('documentQuestions', () => {
  it('keeps only imported sources of this document that name blocks', () => {
    const items = [
      question('imported', [{ document_id: DOC, imported: true, block_ids: ['s', 'o1', 's'] }]),
      question('cited', [{ document_id: DOC, imported: false, block_ids: ['x'] }]),
      question('elsewhere', [{ document_id: 'other', imported: true, block_ids: ['y'] }]),
      question('pages-only', [{ document_id: DOC, imported: true, block_ids: [] }]),
    ];
    const out = documentQuestions(items, DOC);
    expect(out.map((q) => q.id)).toEqual(['imported']);
    expect(out[0]?.blockIds).toEqual(['s', 'o1']);
  });
});

describe('question items in the page groups', () => {
  const [q1, q2] = documentQuestions(
    [
      question('q1', [{ document_id: DOC, imported: true, block_ids: ['s1', 'o1', 'o2'] }], 1),
      question('q2', [{ document_id: DOC, imported: true, block_ids: ['o2', 's2'] }], 2),
    ],
    DOC,
  );
  const blocks = [
    block('intro', 1),
    block('s1', 1, 20),
    block('o1', 1, 40),
    block('o2', 2, 0),
    block('s2', 2, 30),
    block('key', 3),
  ];

  it('puts each question once where its first block is and leaves other blocks as they are', () => {
    const groups = pageGroups(blocks, q1 && q2 ? [q1, q2] : []);
    expect(groups.map((g) => g.page)).toEqual([1, 2, 3]);
    const [p1, p2] = groups;
    expect(p1?.items.map((i) => (i.kind === 'block' ? i.block.block_id : i.question.id))).toEqual([
      'intro',
      'q1',
    ]);
    // A block claimed twice stays with the first question; q2 starts at its own first block.
    const first = p1?.items[1];
    expect(first?.kind === 'question' && first.blocks.map((b) => b.block_id)).toEqual([
      's1',
      'o1',
      'o2',
    ]);
    expect(p2?.items.map((i) => (i.kind === 'block' ? i.block.block_id : i.question.id))).toEqual([
      'q2',
    ]);
    expect(p1?.blockIds.has('o2')).toBe(true);
  });

  it('highlights the whole question, one box per page, when one of its blocks is selected', () => {
    const groups = pageGroups(blocks, q1 ? [q1] : []);
    expect(selectionHighlights(blocks[2], null, blocks, groups)).toEqual([
      { page: 1, bbox: { x0: 10, y0: 20, x1: 100, y1: 50 } },
      { page: 2, bbox: { x0: 10, y0: 0, x1: 100, y1: 10 } },
    ]);
    expect(selectionHighlights(blocks[0], null, blocks, groups)).toEqual(blocks[0]?.locations);
  });
});

describe('answerLines', () => {
  const [q] = documentQuestions(
    [question('q', [{ document_id: DOC, imported: true, block_ids: ['s'] }])],
    DOC,
  );

  it('names the correct option by its label and text, then the explanation', () => {
    if (!q) throw new Error('fixture');
    expect(answerLines(q)).toEqual(['정답: ② 증발']);
    expect(answerLines({ ...q, explanation: '끓는점' })).toEqual(['정답: ② 증발', '해설: 끓는점']);
  });

  it('covers text answers, model answers and a missing answer', () => {
    if (!q) throw new Error('fixture');
    expect(
      answerLines({ ...q, correctOptionIds: null, acceptedAnswers: ['증발', '기화'] }),
    ).toEqual(['정답: 증발 / 기화']);
    expect(answerLines({ ...q, correctOptionIds: null, rubric: '물의 상태 변화' })).toEqual([
      '모범 답안: 물의 상태 변화',
    ]);
    expect(answerLines({ ...q, correctOptionIds: [] })).toEqual(['등록된 정답이 없습니다.']);
  });

  it('labels options with circled numbers, then numbers in parentheses', () => {
    expect([optionLabel(0), optionLabel(3), optionLabel(19), optionLabel(20)]).toEqual([
      '①',
      '④',
      '⑳',
      '(21)',
    ]);
  });
});
