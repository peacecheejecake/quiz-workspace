// UX12-ASKMD: the AI answer's allow-listed Markdown (lib/ask/markdown.ts) and its React rendering
// (components/ask/answer-markdown.tsx), syntax by syntax and with half-written streaming input.
// The browser-visible behaviour is in tests/e2e/ask/ux12-ask-markdown.spec.ts.
import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AnswerMarkdown } from '../src/components/ask/answer-markdown';
import { parseAnswerInline, parseAnswerMarkdown, safeHref } from '../src/lib/ask/markdown';

const cite = (n: number): ReactNode => <button type="button">{`출처 ${n}`}</button>;

function show(text: string, sources: readonly number[] | null = [1, 2]) {
  return render(
    <AnswerMarkdown
      text={text}
      sourceNumbers={sources ? new Set(sources) : null}
      renderCite={cite}
    />,
  ).container;
}

const stream = (text: string) => show(text, null);

describe('blocks', () => {
  it('turns headings into levels that keep the page order', () => {
    const levels = (text: string, headingBase?: number) =>
      parseAnswerMarkdown(text, { headingBase }).flatMap((b) =>
        b.kind === 'heading' ? [b.level] : [],
      );
    expect(levels('# 가\n## 나\n### 다')).toEqual([3, 4, 5]);
    expect(levels('### 가\n\n# 나')).toEqual([3, 3]);
    expect(levels('# 가\n#### 나')).toEqual([3, 4]);
    expect(levels('# 가\n## 나\n### 다\n#### 라\n##### 마', 3)).toEqual([3, 4, 5, 6, 6]);
    expect(levels('## 가\n### 나', 5)).toEqual([5, 6]);
    expect(levels('제목 줄\n===\n\n## 제목 ##')).toEqual([3, 3]);
    expect(levels('#태그는 제목이 아니다')).toEqual([]);
    const container = show('## 제목 [1]\n\n본문');
    expect(within(container).getByRole('heading', { level: 3 })).toHaveTextContent('제목');
    expect(within(container).getByRole('button', { name: '출처 1' })).toBeInTheDocument();
  });

  it('joins soft lines, and keeps hard breaks', () => {
    expect(parseAnswerMarkdown('첫 줄\n둘째 줄')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: '첫 줄 둘째 줄' }] },
    ]);
    for (const text of ['첫 줄  \n둘째 줄', '첫 줄\\\n둘째 줄']) {
      const container = show(text);
      expect(container.querySelectorAll('br')).toHaveLength(1);
      expect(container.textContent).toBe('첫 줄둘째 줄');
    }
  });

  it('shows a fence as code, whatever it holds', () => {
    const container = show('~~~\n**글자** [1]\n<b>x</b>\n    들여쓰기\n~~~\n\n```py\n```\n뒤');
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('**글자** [1]\n<b>x</b>\n    들여쓰기');
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(within(container).queryByRole('button')).toBeNull();
    const scroller = within(container).getByRole('group', { name: '코드' });
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(container.querySelector('b')).toBeNull();
    expect(show('```\n열린 채로 끝난 코드').querySelector('pre')?.textContent).toBe(
      '열린 채로 끝난 코드',
    );
  });

  it('nests quotes, and quotes hold other blocks', () => {
    const container = show('> 인용 [1]\n>\n> - 목록\n>\n> > 안쪽\n\n밖');
    const quote = container.querySelector('blockquote');
    expect(quote?.querySelector('li')?.textContent).toBe('목록');
    expect(quote?.querySelector('blockquote')?.textContent).toBe('안쪽');
    expect(quote?.textContent).not.toContain('밖');
    expect(within(quote as HTMLElement).getByRole('button')).toBeInTheDocument();
  });

  it('stops nesting at a depth limit', () => {
    expect(() => parseAnswerMarkdown(`${'> '.repeat(5000)}글`)).not.toThrow();
    expect(() => parseAnswerMarkdown(`${'- '.repeat(5000)}글`)).not.toThrow();
  });

  it('nests lists by indentation', () => {
    const container = show('- 가\n  - 나\n    - 다\n- 라\n\n1. 하나\n  - 둘째 단\n2. 둘');
    const top = container.querySelector('ul');
    expect(top?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(top?.querySelector('li ul li ul li')?.textContent).toBe('다');
    const numbered = container.querySelector('ol');
    expect(numbered?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(numbered?.querySelector('li ul li')?.textContent).toBe('둘째 단');
  });

  it('keeps a loose list one list, and its numbers', () => {
    const container = show('1. 가\n\n2. 나\n\n   이어지는 문단\n\n설명\n\n3. 다\n\n* 별표\n+ 더하기');
    const lists = container.querySelectorAll('ol');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(lists[0]?.querySelector('p')?.textContent).toBe('이어지는 문단');
    expect(lists[0]?.hasAttribute('start')).toBe(false);
    expect(lists[1]).toHaveAttribute('start', '3');
    expect(container.querySelector('ul')?.querySelectorAll('li')).toHaveLength(2);
  });

  it('continues an item on an unindented line', () => {
    expect(show('- 가\n이어짐\n- 나').querySelector('li')?.textContent).toBe('가 이어짐');
  });

  it('marks task items with read-only checkboxes', () => {
    const container = show('- [x] 끝 [1]\n- [ ] 남음\n- [X] 대문자\n- 그냥');
    const boxes = within(container).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, true]);
    expect(boxes[0]).toBeDisabled();
    expect(boxes[0]).toHaveAccessibleName('완료');
    expect(boxes[1]).toHaveAccessibleName('미완료');
    expect(within(container).getByRole('button', { name: '출처 1' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('[x]');
  });

  it('draws rules, not lists or emphasis', () => {
    for (const line of ['---', '***', '___', '- - -', '* * *']) {
      const container = show(`위\n\n${line}\n\n아래`);
      expect(container.querySelectorAll('hr')).toHaveLength(1);
      expect(container.querySelector('li')).toBeNull();
    }
    expect(show('문단 뒤 가로줄\n---\n다음').querySelector('hr')).not.toBeNull();
  });
});

describe('tables', () => {
  const TABLE =
    '| 왼쪽 | 가운데 | 오른쪽 | 기본 |\n| :-- | :-: | --: | --- |\n| 가 [1] | **나** | `a\\|b` | 라 |';

  it('renders a semantic table with header cells and alignment', () => {
    const container = show(TABLE);
    const table = within(container).getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['왼쪽', '가운데', '오른쪽', '기본']);
    expect(headers[0]).toHaveAttribute('scope', 'col');
    const cells = within(table).getAllByRole('cell');
    expect(within(cells[0] as HTMLElement).getByRole('button')).toHaveTextContent('출처 1');
    expect(cells[1]?.querySelector('strong')?.textContent).toBe('나');
    expect(cells[2]?.querySelector('code')?.textContent).toBe('a|b');
    expect(parseAnswerMarkdown(TABLE)[0]).toMatchObject({
      kind: 'table',
      align: ['left', 'center', 'right', null],
    });
    expect(cells[1]?.className).toMatch(/alignCenter/);
    expect(cells[2]?.className).toMatch(/alignRight/);
    expect(headers[1]?.className).toMatch(/alignCenter/);
  });

  it('scrolls inside a focusable group', () => {
    const scroller = within(show(TABLE)).getByRole('group', { name: '표' });
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(within(scroller).getByRole('table')).toBeInTheDocument();
  });

  it('pads short rows, cuts long ones, and ends at a line without pipes', () => {
    const blocks = parseAnswerMarkdown('| 가 | 나 |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n설명');
    expect(blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [[{ kind: 'text', text: '1' }], []],
        [[{ kind: 'text', text: '1' }], [{ kind: 'text', text: '2' }]],
      ],
    });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
  });

  it('reads tables without outer pipes, and after a paragraph', () => {
    const blocks = parseAnswerMarkdown('앞 문단\n가 | 나\n--- | ---\n1 | 2');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'table']);
  });

  it('keeps a broken table as text', () => {
    const text = '| 가 | 나 |\n| --- |\n| 1 | 2 |';
    expect(parseAnswerMarkdown(text).map((b) => b.kind)).toEqual(['paragraph']);
    expect(within(show(text)).queryByRole('table')).toBeNull();
  });

  it('breaks a cell at <br> without rendering HTML', () => {
    const container = show('| 가 |\n| --- |\n| 첫째<br>둘째<br/>셋째 |\n| <b>x</b> |');
    expect(container.querySelectorAll('td br')).toHaveLength(2);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
  });

  it('holds a table inside a list and a quote', () => {
    const container = show('- 항목\n\n  | 가 |\n  | --- |\n  | 1 [1] |\n\n> | 나 |\n> | --- |');
    expect(within(container).getAllByRole('table')).toHaveLength(2);
    expect(container.querySelector('li table')).not.toBeNull();
    expect(container.querySelector('blockquote table')).not.toBeNull();
    expect(within(container).getByRole('button', { name: '출처 1' })).toBeInTheDocument();
  });
});

describe('inline', () => {
  it('reads strong, em, both, strikethrough and code', () => {
    const container = show('**굵게** *기울임* __밑줄 굵게__ _밑줄_ ***둘 다*** ~~취소~~ `코드`');
    expect(container.querySelectorAll('strong')).toHaveLength(3);
    expect(container.querySelector('strong em')?.textContent).toBe('둘 다');
    expect(container.querySelector('del')?.textContent).toBe('취소');
    expect(container.querySelector('code')?.textContent).toBe('코드');
  });

  it('keeps Korean emphasis next to punctuation and particles', () => {
    expect(parseAnswerInline('**"정답"**은')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: '"정답"' }] },
      { kind: 'text', text: '은' },
    ]);
  });

  it('leaves identifiers, ranges and arithmetic alone', () => {
    for (const text of ['snake_case_name', '10~20', '2 * 3 * 4', 'a~~b']) {
      expect(parseAnswerInline(text)).toEqual([{ kind: 'text', text }]);
    }
  });

  it('keeps code literal, with the longer fence around backticks', () => {
    expect(parseAnswerInline('`` a`b `` `**x**`')).toEqual([
      { kind: 'code', text: 'a`b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: '**x**' },
    ]);
    expect(parseAnswerInline('`열림')).toEqual([{ kind: 'text', text: '`열림' }]);
  });

  it('honours backslash escapes, also for footnotes', () => {
    const container = show('\\*별\\* \\[1\\] \\`코드\\` [1]');
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    expect(container.textContent).toBe('*별* [1] `코드` 출처 1');
    expect(within(container).getAllByRole('button')).toHaveLength(1);
    expect(parseAnswerInline('C:\\폴더')).toEqual([{ kind: 'text', text: 'C:\\폴더' }]);
  });
});

describe('links', () => {
  it('allows only plain http(s) URLs', () => {
    expect(safeHref('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeHref('HTTP://EXAMPLE.com')).toBe('http://example.com/');
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      'mailto:a@example.com',
      '//example.com',
      '/relative',
      'https://user:pw@example.com',
      'https://user@example.com',
      'https://',
    ]) {
      expect(safeHref(url), url).toBeNull();
    }
  });

  it('opens a safe link in a new tab, with that in its name', () => {
    const link = within(show('[**문서** 안내](https://example.com/a_b "제목")')).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/a_b');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveAccessibleName('문서 안내 (새 탭에서 열림)');
    expect(link.querySelector('strong')?.textContent).toBe('문서');
  });

  it('leaves unsafe links whole as text', () => {
    for (const text of [
      '[글](javascript:alert(1))',
      '[글](data:text/html,x)',
      '[글](/relative)',
      '[글](https://user:pw@example.com)',
    ]) {
      const container = show(text);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(text);
    }
  });

  it('links written URLs, stopping at Korean and punctuation', () => {
    const href = (text: string) => show(text).querySelector('a')?.getAttribute('href');
    expect(href('주소는 https://example.com/a을 보세요')).toBe('https://example.com/a');
    expect(href('(https://example.com/a).')).toBe('https://example.com/a');
    expect(href('<https://example.com/b>')).toBe('https://example.com/b');
    expect(href('https://example.com/c[1]')).toBe('https://example.com/c');
  });

  it('prefers a footnote to a link, and never nests a button in a link', () => {
    const footnote = show('[1](https://example.com)');
    expect(within(footnote).getByRole('button', { name: '출처 1' })).toBeInTheDocument();
    const inside = show('[글 [1]](https://example.com/x)');
    const link = within(inside).getByRole('link');
    expect(within(link).queryByRole('button')).toBeNull();
    expect(link).toHaveTextContent('글 [1]');
  });

  it('keeps images, HTML, references and footnote syntax as text', () => {
    const text =
      '![그림](https://example.com/a.png) <img src=x onerror=alert(1)> <script>alert(1)</script> [참조][a] [^1]';
    const container = show(text);
    for (const tag of ['img', 'script', 'a']) expect(container.querySelector(tag)).toBeNull();
    expect(container.textContent).toBe(text);
  });
});

describe('footnotes', () => {
  it('finds them in every container', () => {
    const container = show(
      '# 제목 [1]\n\n**굵게 [1]**\n\n- 목록 [2]\n\n> 인용 [1]\n\n| 표 |\n| --- |\n| 칸 [2] |',
    );
    expect(within(container).getAllByRole('button')).toHaveLength(5);
  });

  it('shows only known numbers as footnotes', () => {
    const container = show('[1] [3] [S1]');
    expect(within(container).getAllByRole('button')).toHaveLength(1);
    expect(container.textContent).toBe('출처 1 [3] [S1]');
  });

  it('shows [Sn] tags as chips while streaming, in a table too', () => {
    const container = stream('| 가 |\n| --- |\n| 칸 [S2] |\n| 더');
    expect(within(container).queryByRole('button')).toBeNull();
    expect(container.querySelector('td span')?.textContent).toBe('[2]');
  });
});

describe('half-written answers', () => {
  it('never throws or shows raw bold marks, at any cut of a full answer', () => {
    const answer = readFileSync(
      new URL('../../../packages/core/src/book_core/ask/fake.py', import.meta.url),
      'utf8',
    ).match(/MARKDOWN_ANSWER = """([\s\S]*?)"""/)?.[1];
    expect(answer).toBeTruthy();
    const text = answer as string;
    for (let end = 0; end <= text.length; end += 1) {
      const { container, unmount } = render(
        <AnswerMarkdown text={text.slice(0, end)} sourceNumbers={null} renderCite={cite} />,
      );
      expect(container.textContent).not.toContain('**');
      unmount();
    }
  });

  it('closes open emphasis, code and strikethrough at the end', () => {
    expect(stream('앞 **굵').querySelector('strong')?.textContent).toBe('굵');
    expect(stream('앞 *기').querySelector('em')?.textContent).toBe('기');
    expect(stream('앞 ~~취').querySelector('del')?.textContent).toBe('취');
    expect(stream('앞 `코').querySelector('code')?.textContent).toBe('코');
    expect(stream('**굵고 *기').querySelector('strong em')?.textContent).toBe('기');
  });

  it('hides a marker that has no text yet', () => {
    for (const text of ['글 **', '글 *', '글 ~~', '글 ~', '글 `', '글 \\', '글 [S', '글 [S1']) {
      expect(stream(text).textContent, text).toBe('글 ');
    }
  });

  it('hides a line that is only the start of a block', () => {
    const tails = [
      '-',
      '- ',
      '*',
      '1',
      '1.',
      '##',
      '#',
      '>',
      '`',
      '``',
      '```',
      '--',
      '- [',
      '- [x',
      '- [x]',
      '|',
      '| ---',
    ];
    for (const tail of tails) {
      const container = stream(`글\n\n${tail}`);
      expect(container.textContent, tail).toBe('글');
      expect(container.querySelector('li, h3, hr, blockquote, pre, table'), tail).toBeNull();
    }
  });

  it('keeps those lines once the answer is finished', () => {
    expect(show('글\n\n1').textContent).toBe('글1');
    expect(show('글 **').textContent).toBe('글 **');
    expect(show('글 [S').textContent).toBe('글 [S');
  });

  it('keeps an open fence as code without the closing marks', () => {
    const open = stream('```py\nif a:\n    b');
    expect(open.querySelector('pre code')?.textContent).toBe('if a:\n    b');
    expect(stream('```py\nif a:\n``').querySelector('pre code')?.textContent).toBe('if a:');
    expect(stream('```').querySelector('pre')).toBeNull();
    expect(stream('```py\n').querySelector('pre')).toBeNull();
  });

  it('holds a table until its delimiter row, then grows it', () => {
    const cuts: [string, number][] = [
      ['앞\n\n| 가 | 나', 0],
      ['앞\n\n| 가 | 나 |', 0],
      ['앞\n\n| 가 | 나 |\n', 0],
      ['앞\n\n| 가 | 나 |\n| --', 0],
      ['앞\n\n| 가 | 나 |\n| --- | -', 0],
      ['앞\n\n| 가 | 나 |\n| --- | --- |', 1],
      ['앞\n\n| 가 | 나 |\n| --- | --- |\n| 1', 1],
      ['앞\n\n| 가 | 나 |\n| --- | --- |\n| 1 | **2', 1],
    ];
    for (const [text, tables] of cuts) {
      const container = stream(text);
      expect(container.querySelectorAll('table'), text).toHaveLength(tables);
      expect(container.textContent, text).not.toContain('|');
      expect(container.textContent, text).not.toContain('--');
    }
    const row = stream('| 가 | 나 |\n| --- | --- |\n| 1 | **2').querySelectorAll('td');
    expect(row).toHaveLength(2);
    expect(row[1]?.querySelector('strong')?.textContent).toBe('2');
  });

  it('holds only the tail: an earlier pipe line stays text', () => {
    expect(stream('- | 가 |\n- 나').textContent).toContain('| 가 |');
    expect(stream('| 가 |\n\n다음 문단').textContent).toContain('| 가 |');
  });

  it('shows the text of a link until its URL ends', () => {
    const open = stream('앞 [문서](https://exam');
    expect(open.textContent).toBe('앞 문서');
    expect(open.querySelector('a')).toBeNull();
    expect(stream('앞 [문서](https://example.com)').querySelector('a')).not.toBeNull();
  });

  it('holds a task box until its text', () => {
    const container = stream('- 가\n- [ ');
    expect(container.textContent).toBe('가');
    expect(within(container).queryByRole('checkbox')).toBeNull();
  });

  it('replaces the partial render with the validated answer', () => {
    const { container, rerender } = render(
      <AnswerMarkdown
        text={'| 가 |\n| --- |\n| 칸 [S1] |\n| **더'}
        sourceNumbers={null}
        renderCite={cite}
      />,
    );
    const table = container.querySelector('table');
    rerender(
      <AnswerMarkdown
        text={'| 가 |\n| --- |\n| 칸 [1] |\n| **더** |'}
        sourceNumbers={new Set([1])}
        renderCite={cite}
      />,
    );
    expect(container.querySelector('table')).toBe(table);
    expect(screen.getByRole('button', { name: '출처 1' })).toBeInTheDocument();
  });
});
