// UX12-REEXTRACT (docs/screens/ux12-reextract.md): the words of the re-extraction review.
import { describe, expect, it } from 'vitest';
import { classifyImportFailure, IMPORT_PROBLEMS } from '../src/lib/questions/import-client';
import { changedText, reextractSummary, type DraftPrevious } from '../src/lib/questions/reextract';

const previous = (over: Partial<DraftPrevious> = {}): DraftPrevious => ({
  question_id: 'q',
  revision_id: 'r',
  number: 5,
  changed: [],
  ...over,
});

describe('UX12-REEXTRACT review words', () => {
  it('names the earlier question or draft and the fields that differ', () => {
    expect(changedText(previous())).toBeNull();
    expect(changedText(previous({ changed: ['stem', 'answer'] }))).toBe(
      '이전 문제 5번과 달라진 항목: 발문, 정답',
    );
    expect(
      changedText(previous({ question_id: null, revision_id: null, changed: ['options'] })),
    ).toBe('이전 초안 5번과 달라진 항목: 보기');
    expect(changedText(previous({ number: null, changed: ['type'] }))).toBe(
      '이전 문제와 달라진 항목: 유형',
    );
  });

  it('counts changed, new and unchanged drafts and lists what is gone', () => {
    const drafts = [
      { previous: previous({ changed: ['stem'] }) },
      { previous: previous() },
      { previous: previous() },
      { previous: null },
    ];
    expect(reextractSummary(drafts, [])).toBe('다시 추출 결과: 변경 1개 · 새 문제 1개 · 같음 2개');
    expect(reextractSummary(drafts, [8, 12])).toContain('이번에 없는 이전 문제: 8번, 12번');
  });

  it('tells a running import from other conflicts', () => {
    expect(classifyImportFailure(409, { type: IMPORT_PROBLEMS.importRunning })).toBe(
      'importRunning',
    );
  });
});
