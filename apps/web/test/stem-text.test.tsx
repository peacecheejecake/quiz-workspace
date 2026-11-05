// @vitest-environment jsdom
// STEM-ITEMS (QPLAY-01-AC14): the shared stem rendering puts labelled items in a list named
// 제시 항목 between the question paragraph and what follows; a stem without items renders as before.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StemBlocks, StemText } from '../src/components/questions/stem/stem-text';

const STEM = '옳은 것은? ( ) (가) 하나 둘 (나) 셋\n\n위에서 고르면?';

describe('StemText', () => {
  it('renders the question paragraph, the 제시 항목 list and the paragraph after it', () => {
    const { container } = render(<StemText stem={STEM} className="host" />);
    const list = screen.getByRole('list', { name: '제시 항목' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['(가) 하나 둘', '(나) 셋']);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('host')).toBe(true);
    expect([...root.children].map((el) => el.tagName)).toEqual(['P', 'UL', 'P']);
    expect(root.children[0]?.textContent).toBe('옳은 것은?');
    expect(root.children[2]?.textContent).toBe('위에서 고르면?');
  });

  it('keeps a stem without items as one paragraph in the host class', () => {
    const { container } = render(
      <StemText stem={'빈칸 (가)와 (나)에 알맞은 것은? ( )'} className="host" />,
    );
    const p = container.firstElementChild as HTMLElement;
    expect(p.tagName).toBe('P');
    expect(p.className).toBe('host');
    expect(p.textContent).toBe('빈칸 (가)와 (나)에 알맞은 것은?');
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('StemBlocks', () => {
  it('splits a stem without items into paragraphs as before', () => {
    const { container } = render(
      <div>
        <StemBlocks stem={'첫 문단\n\n둘째 문단 ( )'} />
      </div>,
    );
    expect(
      [...(container.firstElementChild as HTMLElement).children].map((p) => p.textContent),
    ).toEqual(['첫 문단', '둘째 문단']);
  });

  it('renders the item list among the paragraphs', () => {
    render(<StemBlocks stem={STEM} />);
    expect(screen.getByRole('list', { name: '제시 항목' })).toBeTruthy();
  });
});

it('renders the three UX11 examples without losing their text', async () => {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(readFileSync('../../tests/fixtures/ux11-stem.json', 'utf8')) as {
    stem: string;
    options: string[];
  }[];
  for (const [index, example] of cases.entries()) {
    const { container, unmount } = render(<StemText stem={example.stem} />);
    const root = container.firstElementChild as HTMLElement;
    if (index < 2) {
      expect(within(root).getAllByRole('listitem')).toHaveLength(4);
    } else {
      expect(root.querySelectorAll('p')).toHaveLength(2);
    }
    const visible = root.textContent?.replace(/\s/g, '') ?? '';
    const original = example.stem.replace(/\s/g, '');
    expect(original.replace('?()', '?')).toBe(visible);
    unmount();
  }
});

it('keeps the paragraph following a bullet list outside the list', () => {
  const { container } = render(
    <StemText stem={'다음은? ( ) - 갑이다. - 을이다.\n\n위 내용을 참고하시오.'} />,
  );
  const root = container.firstElementChild as HTMLElement;
  expect([...root.children].map((element) => element.tagName)).toEqual(['P', 'UL', 'P']);
  expect(
    within(root)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['- 갑이다.', '- 을이다.']);
  expect(root.lastElementChild?.textContent).toBe('위 내용을 참고하시오.');
});

it('renders the shared bullet boundary matrix', async () => {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(readFileSync('../../tests/fixtures/ux11-bullets.json', 'utf8')) as {
    stem: string;
    items: number;
    texts?: string[];
    lead: string[];
    trailing: string[];
  }[];
  for (const example of cases) {
    const { container, unmount } = render(<StemText stem={example.stem} />);
    const list = within(container).queryByRole('list', { name: '제시 항목' });
    expect(list ? within(list).getAllByRole('listitem').length : 0).toBe(example.items);
    if (list) {
      if (example.texts)
        expect(
          within(list)
            .getAllByRole('listitem')
            .map((item) => item.textContent),
        ).toEqual(example.texts.map((text) => `- ${text}`));
      const root = container.firstElementChild as HTMLElement;
      const paragraphs = [...root.querySelectorAll(':scope > p')].map((p) => p.textContent);
      expect(paragraphs).toEqual([...example.lead, ...example.trailing]);
    }
    unmount();
  }
});

it('preserves shared range and passage boundaries in rendered blocks', async () => {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(readFileSync('../../tests/fixtures/ux11-boundaries.json', 'utf8')) as {
    stem: string;
    kind: string;
    items?: number;
    paragraphs?: string[];
  }[];
  for (const example of cases) {
    const { container, unmount } = render(<StemText stem={example.stem} />);
    if (example.kind === 'range') {
      expect(within(container).getAllByRole('listitem').length).toBe(example.items);
    } else {
      expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual(
        example.paragraphs,
      );
    }
    unmount();
  }
});
