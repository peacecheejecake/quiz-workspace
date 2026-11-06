// DOCVIEW (DOC-02-AC11): which questions become question cards, where, and what the folded answer
// section says.
import { describe, expect, it } from 'vitest';
import {
  answerLines,
  documentQuestions,
  optionLabel,
  type QuestionLike,
  type DocumentQuestion,
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

describe('selectionHighlights of a draft question (UX12-EXTRACT-AC01)', () => {
  const block = (
    id: string,
    chapter: string,
    type: ContentBlock['type'],
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): ContentBlock =>
    ({
      block_id: id,
      type,
      chapter_id: chapter,
      page: 37,
      locations: [{ page: 37, bbox: { x0, y0, x1, y1 } }],
    }) as unknown as ContentBlock;
  // The stem, then two sub-titles the parser read as headings: three outline sections.
  const page = [
    block('stem', 'a', 'text', 77, 92, 456, 134),
    block('title-1', 'b', 'heading', 108, 152, 185, 161),
    block('body-1', 'b', 'text', 108, 165, 254, 215),
    block('title-2', 'c', 'heading', 108, 227, 222, 236),
    block('option', 'c', 'text', 101, 266, 457, 368),
    block('next', 'd', 'heading', 96, 392, 127, 400),
  ];
  const draft = ['stem', 'title-1', 'body-1', 'title-2', 'option'];
  const whole = [{ page: 37, bbox: { x0: 77, y0: 92, x1: 457, y1: 368 } }];
  const jumpTo = (id: string, heading: string, blockId: string) => ({
    node: { id, block_id: heading },
    blockId,
  });
  const groups = pageGroups(page, []);

  it('marks the whole question from an outline row cut by a heading inside it', () => {
    expect(
      selectionHighlights(page[2], jumpTo('b', 'title-1', 'body-1'), page, groups, [draft]),
    ).toEqual(whole);
    expect(selectionHighlights(page[4], jumpTo('c', 'title-2', 'option'), page, groups, [draft])).toEqual(
      whole,
    );
  });

  it('marks the whole question from a block selected in the text', () => {
    expect(selectionHighlights(page[4], null, page, groups, [draft])).toEqual(whole);
  });

  it('leaves a block outside the draft as it was', () => {
    expect(selectionHighlights(page[5], null, page, groups, [draft])).toEqual(page[5]?.locations);
  });

  it('keeps showing sections without draft data (shared view, failed list)', () => {
    expect(selectionHighlights(page[2], jumpTo('b', 'title-1', 'body-1'), page, groups)).toEqual([
      { page: 37, bbox: { x0: 108, y0: 152, x1: 254, y1: 215 } },
    ]);
  });

  it('does not let page decoration stretch the box, while a figure in the question does', () => {
    const decorated = [
      ...page,
      block('margin', 'c', 'image', 466, 31, 498, 65),
      block('beside', 'c', 'image', 474, 200, 489, 240),
      block('figure', 'c', 'image', 120, 300, 300, 420),
    ];
    const ids = [...draft, 'margin', 'beside', 'figure'];
    expect(selectionHighlights(decorated[4], null, decorated, groups, [ids])).toEqual([
      { page: 37, bbox: { x0: 77, y0: 92, x1: 457, y1: 420 } },
    ]);
  });

  it('keeps a page of the question that holds only an uncaptioned figure', () => {
    const spanning = [
      ...page,
      {
        ...block('figure-page', 'c', 'image', 120, 100, 300, 300),
        page: 38,
        locations: [{ page: 38, bbox: { x0: 120, y0: 100, x1: 300, y1: 300 } }],
      } as ContentBlock,
    ];
    const ids = [...draft, 'figure-page'];
    expect(selectionHighlights(spanning[4], null, spanning, groups, [ids])).toEqual([
      ...whole,
      { page: 38, bbox: { x0: 120, y0: 100, x1: 300, y1: 300 } },
    ]);
    const confirmed = { id: 'q', blockIds: ids } as unknown as DocumentQuestion;
    expect(selectionHighlights(spanning[4], null, spanning, pageGroups(spanning, [confirmed]))).toEqual(
      [...whole, { page: 38, bbox: { x0: 120, y0: 100, x1: 300, y1: 300 } }],
    );
  });

  it('prefers the confirmed question when a block belongs to both', () => {
    const confirmed = { id: 'q', blockIds: ['option'] } as unknown as DocumentQuestion;
    const mixed = pageGroups(page, [confirmed]);
    expect(selectionHighlights(page[4], null, page, mixed, [draft])).toEqual([
      { page: 37, bbox: { x0: 101, y0: 266, x1: 457, y1: 368 } },
    ]);
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
