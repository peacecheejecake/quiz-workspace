// ASK-01 AI 질문 panel view model (lib/ask/model.ts) and SSE parsing (lib/ask/client.ts): answer
// versions per question, footnotes vs streaming tags, source lines, the counter, refusals and the
// availability reason. The browser-visible behaviour is in tests/e2e/ask/ask-llm.spec.ts.
import { describe, expect, it } from 'vitest';
import {
  classifyAskFailure,
  splitSse,
  toAnswerEvent,
  type AskMessage,
  type AskSource,
} from '../src/lib/ask/client';
import {
  conversationTurns,
  copyText,
  counterText,
  disclosureText,
  footnoteLabel,
  runningAnswer,
  scopeText,
  searchedLine,
  sourceLine,
  splitFootnotes,
  unavailableReason,
} from '../src/lib/ask/model';

function message(patch: Partial<AskMessage> & Pick<AskMessage, 'id' | 'role'>): AskMessage {
  return {
    conversation_id: 'c',
    status: 'succeeded',
    text: '',
    sources: [],
    searched_sources: [],
    disclosure: 'none',
    error_code: null,
    uncited: false,
    truncated: false,
    degraded: [],
    question_message_id: null,
    retry_of_message_id: null,
    regenerated_from_message_id: null,
    feedback: null,
    created_at: '2026-11-03T00:00:00Z',
    ...patch,
  };
}

const source: AskSource = {
  number: 1,
  document_id: 'd',
  document_title: '물의 순환 교재',
  revision_id: 'r',
  chapter_id: 'ch',
  chapter_title: '1장 물의 순환',
  block_ids: ['b1'],
  page_from: 2,
  page_to: 2,
  document_type: 'book',
  outdated: false,
};

describe('conversation turns', () => {
  it('groups every answer version (retry, regenerate) under its question, in order', () => {
    const q1 = message({ id: 'q1', role: 'user', text: '첫 질문' });
    const a1 = message({
      id: 'a1',
      role: 'assistant',
      question_message_id: 'q1',
      status: 'failed',
    });
    const a2 = message({ id: 'a2', role: 'assistant', question_message_id: 'q1' });
    const q2 = message({ id: 'q2', role: 'user', text: '둘째 질문' });
    const a3 = message({
      id: 'a3',
      role: 'assistant',
      question_message_id: 'q2',
      status: 'streaming',
    });
    const turns = conversationTurns([q1, a1, q2, a2, a3]);
    expect(turns.map((t) => [t.question.id, t.answers.map((a) => a.id)])).toEqual([
      ['q1', ['a1', 'a2']],
      ['q2', ['a3']],
    ]);
    expect(runningAnswer([q1, a1, q2, a2, a3])?.id).toBe('a3');
    expect(runningAnswer([q1, a1, a2])).toBeNull();
  });

  it('places an answer listed before its question (same transaction) under that question', () => {
    const q1 = message({ id: 'q1', role: 'user' });
    const a1 = message({ id: 'a1', role: 'assistant', question_message_id: 'q1' });
    const q2 = message({ id: 'q2', role: 'user' });
    const a2 = message({ id: 'a2', role: 'assistant', question_message_id: 'q2' });
    const turns = conversationTurns([a1, q1, a2, q2]);
    expect(turns.map((t) => [t.question.id, t.answers.map((a) => a.id)])).toEqual([
      ['q1', ['a1']],
      ['q2', ['a2']],
    ]);
  });
});

describe('footnotes', () => {
  it('a finished answer links only its validated [n]; streaming shows [Sn] as number chips', () => {
    expect(splitFootnotes('가나다 [1] 라마 [9]', new Set([1]))).toEqual([
      { kind: 'text', text: '가나다 ' },
      { kind: 'cite', number: 1 },
      { kind: 'text', text: ' 라마 [9]' },
    ]);
    expect(splitFootnotes('가나다 [S1] 라마 [S9]', null)).toEqual([
      { kind: 'text', text: '가나다 ' },
      { kind: 'tag', number: 1 },
      { kind: 'text', text: ' 라마 ' },
      { kind: 'tag', number: 9 },
    ]);
  });

  it('names footnotes, source and searched lines by title, chapter and pages', () => {
    expect(footnoteLabel(source)).toBe('출처 1: 물의 순환 교재 p.2');
    expect(sourceLine({ ...source, page_to: 3 })).toBe(
      '[1] 물의 순환 교재 · 1장 물의 순환 · p.2–3',
    );
    expect(sourceLine({ ...source, chapter_title: null })).toBe('[1] 물의 순환 교재 · p.2');
    expect(searchedLine(source)).toBe('물의 순환 교재 · 1장 물의 순환 · 2쪽');
    expect(copyText({ text: '답 [1]\n', sources: [source] })).toBe(
      '답 [1]\n\n[1] 물의 순환 교재 p.2',
    );
  });
});

describe('input and state texts', () => {
  it('shows the counter from 80% of the limit', () => {
    expect(counterText(799, 1000)).toBeNull();
    expect(counterText(800, 1000)).toBe('800/1,000');
    expect(counterText(1001, 1000)).toBe('1,001/1,000');
  });

  it('says why new questions are off: the server first, the archive while unknown', () => {
    const limits = { max_question_chars: 1000, max_turns: 20, max_regenerations: 5 };
    expect(unavailableReason(null, false)).toBeNull();
    expect(unavailableReason(null, true)).toBe('archived');
    expect(unavailableReason({ available: true, reason: null, limits }, false)).toBeNull();
    expect(unavailableReason({ available: false, reason: 'disabled', limits }, true)).toBe(
      'disabled',
    );
  });

  it('words the chip disclosure and the scope', () => {
    const chip = { kind: 'question', label: '1장 3번 · 발문', available: true } as const;
    expect(disclosureText({ ...chip, view: 'detail', disclosure: 'full' })).toBe('정답·해설 포함');
    expect(disclosureText({ ...chip, view: 'practice', disclosure: 'hint' })).toBe(
      '제출 전 — 정답 없이 힌트만',
    );
    expect(disclosureText({ ...chip, view: 'practice', disclosure: 'full' })).toBe(
      '제출 후 — 정답·해설 포함',
    );
    expect(disclosureText({ ...chip, view: 'manage', disclosure: 'full', available: false })).toBe(
      '더 이상 볼 수 없는 문제',
    );
    expect(scopeText({ document_ids: [], chapter_ids: [] }, null, null)).toBeNull();
    expect(scopeText({ document_ids: ['d'], chapter_ids: ['c'] }, '교재', '2장')).toBe(
      '범위: 교재 · 2장',
    );
  });

  it('classifies refusals by problem type', () => {
    expect(classifyAskFailure(429, {})).toBe('rateLimited');
    expect(classifyAskFailure(429, { type: 'urn:quiz-workspace:problem:ask-daily-limit' })).toBe(
      'dailyLimit',
    );
    expect(classifyAskFailure(403, { type: 'urn:quiz-workspace:problem:workspace-archived' })).toBe(
      'archived',
    );
    expect(
      classifyAskFailure(409, { type: 'urn:quiz-workspace:problem:ask-regenerate-limit' }),
    ).toBe('regenerateLimit');
    expect(classifyAskFailure(404, {})).toBe('notFound');
  });
});

describe('SSE parsing', () => {
  it('splits complete events, keeps the unfinished rest and reads delta / done / error', () => {
    const { events, rest } = splitSse(
      'retry: 1000\n\nid: 1\nevent: delta\ndata: {"seq":1,"text":"가"}\n\nid: 2\nevent: del',
    );
    expect(rest).toBe('id: 2\nevent: del');
    expect(events.map(toAnswerEvent)).toEqual([{ type: 'delta', seq: 1, text: '가' }]);
    const done = splitSse(
      'event: done\ndata: {"message":{"id":"m"}}\n\nevent: error\ndata: {"code":"llm_unavailable"}\n\n',
    );
    expect(done.events.map(toAnswerEvent)).toEqual([
      { type: 'done', message: { id: 'm' } },
      { type: 'error', code: 'llm_unavailable' },
    ]);
  });
});
