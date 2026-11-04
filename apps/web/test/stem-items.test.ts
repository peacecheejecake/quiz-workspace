// STEM-ITEMS (docs/questions.md §4 item 11, QPLAY-01-AC14): labelled items between the question
// sentence and the options are found in the stem (stored on one line or one per line) and shown
// one per line in a 제시 항목 box. Display only; option labels (①, 1.) and inline mentions are not
// items.
import { describe, expect, it } from 'vitest';
import { stemItems } from '../src/lib/questions/stem-items';

const USER_EXAMPLE =
  '수신 업무 내용 중 맞는 것으로만 묶인 것은? ( ) (가) 개인과 법인은 공동명의 계좌개설이 불가하다. ' +
  '(나) 만 14세 미만 미성년자는 법정대리인의 동의를 받아야 한다. (다) 세법상 비거주자의 이자소득은 ' +
  '원천징수한다. (라) 임의단체는 법인과세 처리한다.';

/** `[label, text]` pairs of the layout's items. */
function pairs(stem: string): [string, string][] | null {
  const layout = stemItems(stem);
  return layout ? layout.items.map((i) => [i.label, i.text]) : null;
}

describe('stemItems', () => {
  it('splits the one-line user example into the question sentence and four items', () => {
    expect(stemItems(USER_EXAMPLE)).toEqual({
      lead: ['수신 업무 내용 중 맞는 것으로만 묶인 것은?'],
      items: [
        { label: '(가)', text: '개인과 법인은 공동명의 계좌개설이 불가하다.' },
        { label: '(나)', text: '만 14세 미만 미성년자는 법정대리인의 동의를 받아야 한다.' },
        { label: '(다)', text: '세법상 비거주자의 이자소득은 원천징수한다.' },
        { label: '(라)', text: '임의단체는 법인과세 처리한다.' },
      ],
      trailing: [],
    });
  });

  it.each([
    ['한글 (x)', ['(가)', '(나)', '(다)']],
    ['한글 전각 （x）', ['（가）', '（나）', '（다）']],
    ['한글 x)', ['가)', '나)', '다)']],
    ['한글 x.', ['가.', '나.', '다.']],
    ['자음 x.', ['ㄱ.', 'ㄴ.', 'ㄷ.']],
    ['자음 (x)', ['(ㄱ)', '(ㄴ)', '(ㄷ)']],
    ['영문 대문자 x.', ['A.', 'B.', 'C.']],
    ['영문 대문자 (x)', ['(A)', '(B)', '(C)']],
    ['영문 소문자 x)', ['a)', 'b)', 'c)']],
    ['로마 숫자 Ⅰ.', ['Ⅰ.', 'Ⅱ.', 'Ⅲ.']],
    ['로마 숫자 소문자 (ⅰ)', ['(ⅰ)', '(ⅱ)', '(ⅲ)']],
    ['로마 숫자 ASCII I.', ['I.', 'II.', 'III.']],
    ['아라비아 숫자 (x)', ['(1)', '(2)', '(3)']],
    ['아라비아 숫자 x)', ['1)', '2)', '3)']],
    ['원문자 ㉠', ['㉠', '㉡', '㉢']],
    ['원문자 ㉮', ['㉮', '㉯', '㉰']],
    ['괄호문자 ㈀', ['㈀', '㈁', '㈂']],
    ['괄호문자 ㈎', ['㈎', '㈏', '㈐']],
    ['원문자 ⓐ', ['ⓐ', 'ⓑ', 'ⓒ']],
    ['원문자 Ⓐ', ['Ⓐ', 'Ⓑ', 'Ⓒ']],
    ['괄호 숫자 ⑴', ['⑴', '⑵', '⑶']],
    ['괄호 영문 ⒜', ['⒜', '⒝', '⒞']],
  ])('groups the %s family', (_name, labels) => {
    const stem = `다음 중 옳은 것은? ${labels.map((l, i) => `${l} 내용 ${i + 1}`).join(' ')}`;
    expect(pairs(stem)).toEqual(labels.map((l, i) => [l, `내용 ${i + 1}`]));
    expect(stemItems(stem)?.lead).toEqual(['다음 중 옳은 것은?']);
  });

  it('runs to the twentieth arabic and the twelfth roman label', () => {
    const arabic = Array.from({ length: 20 }, (_, i) => `(${i + 1}) 항목`).join(' ');
    expect(stemItems(`고르시오. ${arabic}`)?.items).toHaveLength(20);
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    expect(stemItems(`고르시오. ${roman.map((r) => `${r}. 항목`).join(' ')}`)?.items).toHaveLength(
      12,
    );
  });

  it('does not group labels of mixed formats or families', () => {
    expect(stemItems('옳은 것은? (가) 하나 나) 둘 다. 셋')).toBeNull();
    expect(stemItems('옳은 것은? (가) 하나 （나） 둘')).toBeNull();
    expect(stemItems('옳은 것은? ㄱ. 하나 나. 둘')).toBeNull();
  });

  it('needs at least two labels in order from the first one', () => {
    expect(stemItems('옳은 것은? (가) 하나')).toBeNull();
    expect(stemItems('옳은 것은? (나) 하나 (다) 둘')).toBeNull();
    expect(stemItems('옳은 것은? (가) 하나 (다) 둘')).toBeNull();
    expect(pairs('옳은 것은? (가) 하나 (나) 둘 (라) 넷')).toEqual([
      ['(가)', '하나'],
      ['(나)', '둘 (라) 넷'],
    ]);
  });

  it('never takes option labels (①, ❶, ➀, 1.) as items', () => {
    expect(stemItems('옳은 것은? ① 하나 ② 둘 ③ 셋')).toBeNull();
    expect(stemItems('옳은 것은? ❶ 하나 ❷ 둘')).toBeNull();
    expect(stemItems('옳은 것은? ➀ 하나 ➁ 둘')).toBeNull();
    expect(stemItems('옳은 것은? 1. 하나 2. 둘 3. 셋')).toBeNull();
    expect(stemItems('옳은 것은?\n1. 하나\n2. 둘')).toBeNull();
  });

  it('leaves labels mentioned inside a sentence alone', () => {
    expect(stemItems('빈칸 (가)와 (나)에 들어갈 말로 옳은 것은?')).toBeNull();
    expect(stemItems('(가)와 (나)에 들어갈 말로 옳은 것은? ( )')).toBeNull();
    expect(stemItems('밑줄 친 ㉠, ㉡에 해당하는 것은?')).toBeNull();
    expect(stemItems('옳은 것은? (가)(나) 하나')).toBeNull();
  });

  it('does not split a list that starts in the middle of a sentence', () => {
    expect(stemItems('다음 중 (가) 사과 (나) 배 가운데 과일인 것은?')).toBeNull();
    expect(stemItems('다음 표의 A 지역 B 지역')).toBeNull();
  });

  it.each([
    ['?', '옳은 것은?'],
    ['.', '다음을 읽고 답하시오.'],
    [':', '다음과 같다:'],
    [')', '다음을 보시오(단, 2024년 기준)'],
    ['」', '「은행법」'],
    ['>', '<보기>'],
  ])('accepts a question sentence ending with %s', (_end, lead) => {
    expect(stemItems(`${lead} (가) 하나 (나) 둘`)?.lead).toEqual([lead]);
  });

  it('removes the empty answer mark that ends the question sentence', () => {
    expect(stemItems('옳은 것은 ( ) (가) 하나 (나) 둘')?.lead).toEqual(['옳은 것은']);
    expect(stemItems('옳은 것은?（ ） ㄱ. 하나 ㄴ. 둘')?.lead).toEqual(['옳은 것은?']);
  });

  it('keeps fill-in blanks of the question sentence', () => {
    expect(stemItems('빈칸 ( )에 알맞은 것은? (가) 하나 (나) 둘')?.lead).toEqual([
      '빈칸 ( )에 알맞은 것은?',
    ]);
  });

  it('takes items without a question sentence', () => {
    expect(stemItems('(가) 하나\n(나) 둘')).toEqual({
      lead: [],
      items: [
        { label: '(가)', text: '하나' },
        { label: '(나)', text: '둘' },
      ],
      trailing: [],
    });
  });

  it('ends the list at a blank line and keeps the next paragraphs below the box', () => {
    const stem =
      '다음은 물의 순환에 대한 설명이다.\n\nㄱ. 증발은 액체가 기체로 바뀌는 현상이다.\n' +
      'ㄴ. 응결은 기체가 액체로 바뀌는 현상이다.\nㄷ. 강수는 물이 스며드는 현상이다.\n\n' +
      '위에서 옳은 것을 모두 고르면? ( )';
    expect(stemItems(stem)).toEqual({
      lead: ['다음은 물의 순환에 대한 설명이다.'],
      items: [
        { label: 'ㄱ.', text: '증발은 액체가 기체로 바뀌는 현상이다.' },
        { label: 'ㄴ.', text: '응결은 기체가 액체로 바뀌는 현상이다.' },
        { label: 'ㄷ.', text: '강수는 물이 스며드는 현상이다.' },
      ],
      trailing: ['위에서 옳은 것을 모두 고르면?'],
    });
  });

  it('keeps earlier paragraphs of the lead as their own paragraphs', () => {
    expect(stemItems('지문 첫 문단.\n\n옳은 것은?\n(가) 하나\n(나) 둘')?.lead).toEqual([
      '지문 첫 문단.',
      '옳은 것은?',
    ]);
  });

  it('keeps a wrapped item line inside its item', () => {
    expect(pairs('옳은 것은?\n(가) 첫 줄\n이어지는 줄\n(나) 둘')).toEqual([
      ['(가)', '첫 줄\n이어지는 줄'],
      ['(나)', '둘'],
    ]);
  });

  it('needs content after the label', () => {
    expect(stemItems('옳은 것은? (가) 하나 (나)')).toBeNull();
    expect(stemItems('옳은 것은? (가) 하나 (나)\n\n다음 문단')).toBeNull();
  });

  it('returns null for a stem without items', () => {
    expect(stemItems('물의 순환에서 응결에 해당하는 것은? ( )')).toBeNull();
    expect(stemItems('')).toBeNull();
    expect(stemItems('첫 문단\n\n둘째 문단')).toBeNull();
  });
});
