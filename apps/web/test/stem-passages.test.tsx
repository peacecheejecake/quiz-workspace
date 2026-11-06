// @vitest-environment jsdom
// UX12-PASSAGE (docs/questions.md §4 12): <제목> passages in a stem. The Python side reads the same
// tests/fixtures/stem-passages.json (packages/core/tests/test_stem_passages.py).
import './dom-setup';
import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StemBlocks, StemText } from '../src/components/questions/stem/stem-text';
import { stemPassageLayout, type StemPassageLayout } from '../src/lib/questions/stem-passages';

const cases = JSON.parse(readFileSync('../../tests/fixtures/stem-passages.json', 'utf8')) as {
  name: string;
  stem: string;
  normalized: string;
  layout: StemPassageLayout | null;
}[];

const TABLE = '| 단계 | 작용 |\n| --- | --- |\n| 응집 | 결합 |';
const FULL = (cases[0] as { stem: string }).stem;

describe('stemPassageLayout', () => {
  it.each(cases)('matches the shared matrix: $name', ({ stem, layout }) => {
    expect(stemPassageLayout(stem)).toEqual(layout);
  });

  it.each(cases.filter(({ layout }) => layout))(
    'reads the extractor shape the same: $name',
    ({ normalized, layout }) => {
      const read = stemPassageLayout(normalized);
      expect(read?.lead).toEqual(layout?.lead);
      expect(read?.passages).toEqual(layout?.passages);
      expect(read?.rest.replace(/\s+/gu, ' ')).toEqual(layout?.rest);
    },
  );
});

describe('StemBlocks with passages', () => {
  it('keeps an item list between two passages a list', () => {
    const { container } = render(
      <div>
        <StemBlocks stem="옳은 것은? <자료> ∙갑 : 하나 (가) 갑이다. (나) 을이다. <추가> ∙병 : 셋" />
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect([...root.children].map((el) => el.tagName)).toEqual(['P', 'SECTION', 'UL', 'SECTION']);
    expect(root.children[2]?.children).toHaveLength(2);
  });

  it('boxes each passage under its heading, with the item list after them', () => {
    const { container } = render(
      <div>
        <StemBlocks stem={FULL} />
      </div>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect([...root.children].map((el) => el.tagName)).toEqual(['P', 'SECTION', 'SECTION', 'UL']);
    expect(root.children[0]?.textContent).toBe('다음 자료를 보고 옳은 것만 고른 것은?');

    const first = screen.getByRole('region', { name: '<물건 현황>' });
    expect(within(first).getByRole('heading', { name: '<물건 현황>' })).toBeTruthy();
    expect(first.firstElementChild?.textContent).toBe('<물건 현황>');
    expect(
      within(first)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '∙ 소재지 : 가람시 나무동 12',
      '∙ 보증금 : 3억원',
      '∙ 임대 기간 : 2026.6.10. ~ 2028.6.9.',
    ]);

    const second = screen.getByRole('region', { name: '<보유 자산>' });
    const parent = within(second)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('∙ 가람아파트')) as HTMLElement;
    expect(
      within(within(parent).getByRole('list'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['- 취득 정보 : 2020년 4억원', '- 현재 시세 : 5억원']);

    expect(
      within(screen.getByRole('list', { name: '제시 항목' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '(가) 갑은 보증금을 돌려받는다.',
      '(나) 을은 취득세를 낸다.',
      '(다) 병은 시세를 신고한다.',
    ]);
  });

  it('reads passages on each side of a table', () => {
    const { container } = render(
      <div>
        <StemBlocks stem={`옳은 것은? <자료 A> ∙갑 : 하나\n\n${TABLE}\n\n<자료 B> ∙을 : 둘`} />
      </div>,
    );
    expect(
      [...(container.firstElementChild as HTMLElement).children].map((el) => el.tagName),
    ).toEqual(['P', 'SECTION', 'DIV', 'SECTION']);
    expect(screen.getByRole('region', { name: '<자료 B>' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('keeps a stem whose bracket is only a mention as one paragraph', () => {
    const { container } = render(<StemText stem="다음 <보기>에서 옳은 것은?" className="host" />);
    const p = container.firstElementChild as HTMLElement;
    expect(p.tagName).toBe('P');
    expect(p.className).toBe('host');
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('StemText with passages', () => {
  it('uses the block container in the host class', () => {
    const { container } = render(<StemText stem={FULL} className="host" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('DIV');
    expect(root.classList.contains('host')).toBe(true);
    expect(screen.getAllByRole('heading')).toHaveLength(2);
  });

  it('shows a passage without an item list, then its trailing paragraph', () => {
    const { container } = render(<StemText stem={'옳은 것은? <사례> ∙갑\n\n위에서 고르면?'} />);
    const root = container.firstElementChild as HTMLElement;
    expect([...root.children].map((el) => el.tagName)).toEqual(['P', 'SECTION', 'P']);
  });
});
