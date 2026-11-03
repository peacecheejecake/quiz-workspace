// UX7-QDISPLAY (docs/questions.md §4 item 10, QPLAY-01-AC13): a stem is shown without the empty
// answer mark exam papers put at its end; fill-in blanks inside the sentence stay. Display only.
import { describe, expect, it } from 'vitest';
import { displayStem, stemParagraphs } from '../src/lib/questions/display-stem';

describe('displayStem', () => {
  it.each([
    ['옳은 것은? ( )', '옳은 것은?'],
    ['옳은 것은? ()', '옳은 것은?'],
    ['옳은 것은? (  )', '옳은 것은?'],
    ['옳은 것은? (   )   ', '옳은 것은?'],
    ['옳은 것은?( )', '옳은 것은?'],
    ['옳은 것은?  (  )', '옳은 것은?'],
    ['옳은 것은? (　)', '옳은 것은?'],
    ['옳은 것은? (​)', '옳은 것은?'],
  ])('removes a trailing half-width mark: %j', (stem, shown) => {
    expect(displayStem(stem)).toBe(shown);
  });

  it.each([
    ['옳은 것은? （ ）', '옳은 것은?'],
    ['옳은 것은? （　　）', '옳은 것은?'],
    ['옳은 것은? （）', '옳은 것은?'],
    ['옳은 것은? ( ）', '옳은 것은?'],
  ])('removes a trailing full-width (or mixed) mark: %j', (stem, shown) => {
    expect(displayStem(stem)).toBe(shown);
  });

  it('removes a mark on its own last line', () => {
    expect(displayStem('다음 중 옳은 것은?\n( )\n')).toBe('다음 중 옳은 것은?');
    expect(displayStem('다음 중 옳은 것은?\r\n\t（ ）')).toBe('다음 중 옳은 것은?');
  });

  it('removes several trailing marks', () => {
    expect(displayStem('옳은 것은? ( ) ( )')).toBe('옳은 것은?');
    expect(displayStem('옳은 것은? ( )（ ）()')).toBe('옳은 것은?');
  });

  it('keeps empty parentheses inside the sentence (fill-in blanks)', () => {
    expect(displayStem('빈칸 ( )에 들어갈 말은?')).toBe('빈칸 ( )에 들어갈 말은?');
    expect(displayStem('( )에 알맞은 것은?')).toBe('( )에 알맞은 것은?');
    expect(displayStem('빈칸 ( )에 들어갈 말은? ( )')).toBe('빈칸 ( )에 들어갈 말은?');
    expect(displayStem('물은 ( ).')).toBe('물은 ( ).');
  });

  it('keeps non-empty trailing parentheses', () => {
    expect(displayStem('옳은 것은? (2점)')).toBe('옳은 것은? (2점)');
    expect(displayStem('옳은 것은? ( 가 )')).toBe('옳은 것은? ( 가 )');
    expect(displayStem('옳은 것은? )')).toBe('옳은 것은? )');
    expect(displayStem('옳은 것은? (')).toBe('옳은 것은? (');
  });

  it('returns a stem without a trailing mark unchanged (whitespace included)', () => {
    for (const stem of ['옳은 것은?', '  옳은 것은?  ', '첫 줄\n둘째 줄', '', '   ']) {
      expect(displayStem(stem)).toBe(stem);
    }
  });

  // Proposal (UX7-QDISPLAY): a stem that is only marks is shown as stored, never as nothing.
  it('keeps a stem that is only empty parentheses', () => {
    expect(displayStem('( )')).toBe('( )');
    expect(displayStem(' （ ） ( ) ')).toBe(' （ ） ( ) ');
  });

  it('stays linear on long whitespace runs', () => {
    const stem = `옳은 것은?${' '.repeat(200_000)}x`;
    const started = performance.now();
    expect(displayStem(stem)).toBe(stem);
    expect(displayStem(`${' ( '.repeat(50_000)}`)).toBe(`${' ( '.repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('stemParagraphs (UX9-QTYPE)', () => {
  it('keeps a one-paragraph stem whole, single line breaks included', () => {
    expect(stemParagraphs('다음 중\n옳은 것은?')).toEqual(['다음 중\n옳은 것은?']);
  });

  it('splits at blank lines, whitespace-only and CRLF blank lines included', () => {
    expect(stemParagraphs('지문 1\n\n지문 2')).toEqual(['지문 1', '지문 2']);
    expect(stemParagraphs('지문 1\n  \n\n지문 2\r\n\r\n물음')).toEqual([
      '지문 1',
      '지문 2',
      '물음',
    ]);
  });

  it('drops empty leading and trailing paragraphs', () => {
    expect(stemParagraphs('\n\n지문\n\n')).toEqual(['지문']);
  });

  it('returns a stem without text as itself', () => {
    expect(stemParagraphs('')).toEqual(['']);
    expect(stemParagraphs('\n\n')).toEqual(['\n\n']);
  });

  it('stays fast on long whitespace runs', () => {
    const stem = `지문${'\n '.repeat(100_000)}x`;
    const started = performance.now();
    expect(stemParagraphs(stem)).toEqual(['지문', ' x']);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
