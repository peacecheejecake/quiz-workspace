// CHNOTE-02-C04 — the note search (docs/screens/chapter-note-tools.md): findInNote folds NFKC and
// case, returns non-overlapping results in document order, finds text across highlight marks,
// hidden labels and footnote numbers (it runs on the blocks' text), finds nothing for an empty
// query and stops at 1,000 results ("1000+"). Also the SearchField row that drives it.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FIND_IN_NOTE_LIMIT,
  HighlightableText,
  SearchField,
  findInNote,
  matchCountLabel,
  type FindResult,
  type TextBlock,
} from '../src';

const BLOCKS: TextBlock[] = [
  { id: 's0.i0', text: '주의: 증발 주의 사항', suffix: <a href="#fn">[1]</a> },
  { id: 's0.i1', text: 'ＡＴＴＥＮＴＩＯＮ과 attention, Attention' },
  { id: 'h:h1', text: '해설 인용 주의' },
];

describe('CHNOTE-02-C04 findInNote', () => {
  it('CHNOTE-02-C04 folds case and width (NFKC) and returns results in document order', () => {
    const { matches, capped } = findInNote(BLOCKS, 'attention');
    expect(capped).toBe(false);
    expect(matches).toEqual([
      { block: 's0.i1', start: 0, end: 9 },
      { block: 's0.i1', start: 11, end: 20 },
      { block: 's0.i1', start: 22, end: 31 },
    ]);
    // Full-width input finds half-width text too.
    expect(findInNote(BLOCKS, 'ＡＴＴＥＮＴＩＯＮ').matches).toHaveLength(3);
    expect(findInNote(BLOCKS, '주의').matches.map((m) => [m.block, m.start])).toEqual([
      ['s0.i0', 0],
      ['s0.i0', 7],
      ['h:h1', 6],
    ]);
  });

  it('CHNOTE-02-C04 keeps spacing, never overlaps and never crosses blocks', () => {
    expect(findInNote([{ id: 'a', text: 'aaaa' }], 'aa').matches).toEqual([
      { block: 'a', start: 0, end: 2 },
      { block: 'a', start: 2, end: 4 },
    ]);
    expect(findInNote([{ id: 'a', text: '증발 주의' }], '증발주의').matches).toEqual([]);
    expect(findInNote([{ id: 'a', text: '증발  주의' }], '증발 주의').matches).toEqual([]);
    expect(
      findInNote(
        [
          { id: 'a', text: '끝에 주' },
          { id: 'b', text: '의 시작' },
        ],
        '주의',
      ).matches,
    ).toEqual([]);
  });

  it('CHNOTE-02-C04 maps folded offsets back to the original text', () => {
    // "ﬁ" folds to "fi" (two units from one); "㈜" to "(주)".
    const blocks = [{ id: 'a', text: 'ﬁle ㈜회사 file' }];
    expect(findInNote(blocks, 'file').matches).toEqual([
      { block: 'a', start: 0, end: 3 },
      { block: 'a', start: 8, end: 12 },
    ]);
    expect(findInNote(blocks, '(주)회사').matches).toEqual([{ block: 'a', start: 4, end: 7 }]);
    // Decomposed Hangul (NFD) is found by the composed query.
    expect(findInNote([{ id: 'b', text: '주의'.normalize('NFD') }], '주의').matches).toHaveLength(
      1,
    );
  });

  it('CHNOTE-02-C04 folds the text and the query the same way (context-sensitive casing, NFKC)', () => {
    // Whole-string lower case turns a word-final Σ into ς, per character into σ: both sides
    // must match whichever form either uses.
    const greek = [{ id: 'g', text: 'ΟΣ και ος' }];
    expect(findInNote(greek, 'ΟΣ').matches).toEqual([
      { block: 'g', start: 0, end: 2 },
      { block: 'g', start: 7, end: 9 },
    ]);
    expect(findInNote(greek, 'ος').matches).toHaveLength(2);
    expect(findInNote(greek, 'οσ').matches).toHaveLength(2);
    // Korean with full-width punctuation and digits (NFKC) on either side.
    const korean = [{ id: 'k', text: '（주의）１장 정리, (주의)1장' }];
    expect(findInNote(korean, '(주의)1장').matches).toEqual([
      { block: 'k', start: 0, end: 6 },
      { block: 'k', start: 11, end: 17 },
    ]);
    expect(findInNote(korean, '（주의）１장').matches).toHaveLength(2);
  });

  it('CHNOTE-02-C04 finds nothing for an empty query', () => {
    expect(findInNote(BLOCKS, '')).toEqual({ matches: [], capped: false });
  });

  it('CHNOTE-02-C04 finds a result across highlight marks, hidden labels and footnote numbers', () => {
    // The highlight ends inside "증발 주의"; the rendered DOM has its hidden labels in between.
    const highlights = [{ id: 'h', block: 's0.i0', start: 4, end: 6, color: 'yellow' as const }];
    const { matches } = findInNote(BLOCKS, '증발 주의');
    expect(matches).toEqual([{ block: 's0.i0', start: 4, end: 9 }]);
    const { container } = render(
      <HighlightableText
        label="정리 노트 본문"
        blocks={BLOCKS}
        highlights={highlights}
        matches={matches.map((m) => ({ ...m, current: true }))}
      />,
    );
    const parts = [...container.querySelectorAll('mark[data-search-result]')];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.closest('mark[data-highlight-color]')).not.toBeNull();
    const text = parts.map((p) => {
      const clone = p.cloneNode(true) as Element;
      for (const skip of clone.querySelectorAll('[data-hl-skip]')) skip.remove();
      return clone.textContent;
    });
    expect(text.join('')).toBe('증발 주의');
    // The footnote number is not text: "사항[1]" is not "사항1".
    expect(findInNote(BLOCKS, '사항[1]').matches).toEqual([]);
  });

  it('CHNOTE-02-C04 stops at 1,000 results and reports "1000+"', () => {
    const many = [{ id: 'a', text: '주'.repeat(1500) }];
    const result: FindResult = findInNote(many, '주');
    expect(result.matches).toHaveLength(FIND_IN_NOTE_LIMIT);
    expect(result.capped).toBe(true);
    expect(matchCountLabel(result.matches.length, result.capped)).toBe('1000+');
    const exact = findInNote([{ id: 'a', text: '주'.repeat(1000) }], '주');
    expect(exact.capped).toBe(false);
    expect(matchCountLabel(exact.matches.length, exact.capped)).toBe('1000');
  });
});

function SearchHarness({ onSearch }: { onSearch?: (q: string) => void }) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<FindResult>({ matches: [], capped: false });
  const [current, setCurrent] = useState(0);
  const total = result.matches.length;
  // Stands in for the dialog around the field: an Escape that bubbles up "closes" it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSearch?.('<closed>');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onSearch]);
  return (
    <div>
      <SearchField
        label="노트에서 찾기"
        value={value}
        onValueChange={setValue}
        onSearch={(q) => {
          onSearch?.(q);
          const next = findInNote(BLOCKS, q);
          setResult(next);
          setCurrent(next.matches.length > 0 ? 1 : 0);
        }}
        total={total}
        current={current}
        capped={result.capped}
        onNext={() => setCurrent((c) => (c >= total ? 1 : c + 1))}
        onPrevious={() => setCurrent((c) => (c <= 1 ? total : c - 1))}
      />
    </div>
  );
}

describe('CHNOTE-02 SearchField', () => {
  it('debounces typing, steps with Enter / Shift+Enter (wrapping) and clears on Escape', async () => {
    vi.useFakeTimers();
    try {
      const onSearch = vi.fn();
      render(<SearchHarness onSearch={onSearch} />);
      const box = screen.getByRole('searchbox', { name: '노트에서 찾기' });
      expect(box).toHaveAttribute('placeholder', '노트에서 찾기');
      expect(screen.getByRole('button', { name: '이전 결과' })).toBeDisabled();
      fireEvent.change(box, { target: { value: '주의' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(onSearch).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(onSearch).toHaveBeenLastCalledWith('주의');
      expect(screen.getByText('1/3')).toBeInTheDocument();
      expect(screen.getByText('3개 중 1번째')).toBeInTheDocument();

      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.getByText('3/3')).toBeInTheDocument();
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.getByText('1/3')).toBeInTheDocument();
      expect(screen.getByText('처음부터 다시')).toBeInTheDocument();
      fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
      expect(screen.getByText('3/3')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '이전 결과' }));
      expect(screen.getByText('2/3')).toBeInTheDocument();

      // A non-empty field owns its Escape (the dialog stays open)...
      expect(box).toHaveAttribute('data-own-escape');
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(box).toHaveValue('');
      expect(onSearch).toHaveBeenLastCalledWith('');
      expect(onSearch).not.toHaveBeenCalledWith('<closed>');
      // ...an empty one lets it through.
      expect(box).not.toHaveAttribute('data-own-escape');
      fireEvent.keyDown(box, { key: 'Escape' });
      expect(onSearch).toHaveBeenLastCalledWith('<closed>');

      fireEvent.change(box, { target: { value: '없는말' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.getByText('결과 없음')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '다음 결과' })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is reachable and labelled for keyboard users', async () => {
    const user = userEvent.setup();
    render(<SearchHarness />);
    await user.tab();
    expect(screen.getByRole('searchbox', { name: '노트에서 찾기' })).toHaveFocus();
  });
});
