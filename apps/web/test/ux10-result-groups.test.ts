import { describe, expect, it } from 'vitest';
import { groupResults } from '../src/components/questions/viewer/result-groups';
import type { RunResultItem } from '../src/lib/questions/practice-runs';

function item(position: number, chapter: string | null): RunResultItem {
  return {
    position,
    question_id: null,
    available: true,
    question_type: 'MCQ',
    chapter_id: chapter,
    chapter_number: chapter ? 1 : null,
    chapter_title: chapter ? '물' : null,
    question_number: position,
    preview: '발문',
    result: null,
  };
}

describe('UX10-PLAY-AC05 result groups', () => {
  it('groups loaded rows by chapter and puts rows without chapters last', () => {
    const groups = groupResults([item(1, null), item(2, 'a'), item(3, 'a')]);
    expect(groups.map((group) => group.title)).toEqual(['1장 물', '장 없음']);
    expect(groups[0]?.items.map((row) => row.position)).toEqual([2, 3]);
    expect(groupResults([item(201, 'a')])[0]?.title).toBe('1장 물');
  });
});
