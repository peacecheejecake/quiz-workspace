import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChapterPicker, type ChapterPickerNode } from '../src';
import { buildChapterTree, initialExpanded, visibleRows } from '../src/primitives/chapter-tree';
import { axeViolations } from './axe';

const OUTLINE: ChapterPickerNode[] = [
  { value: 'c1', label: '1장 물의 순환', level: 1 },
  { value: 's11', label: '1.1 증발', level: 2 },
  { value: 's12', label: '1.2 강수', level: 2 },
  { value: 'c2', label: '2장 정수', level: 1 },
  { value: 's21', label: '2.1 응집', level: 2 },
  { value: 'x', label: '2.1.1 세부', level: 3 },
];
const LEADING = [{ value: 'none', label: '챕터 없음' }];

function Harness({
  initial = 'none',
  nodes = OUTLINE,
  onChange,
}: {
  readonly initial?: string;
  readonly nodes?: readonly ChapterPickerNode[];
  readonly onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChapterPicker
      label="챕터"
      leading={LEADING}
      nodes={nodes}
      value={value}
      onValueChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const row = (name: string) => screen.findByRole('treeitem', { name });
const names = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'));
const trigger = () => screen.getByRole('combobox', { name: '챕터' });

describe('chapter tree', () => {
  it('nests by level with a stack: a gap indents once and a shallower level closes the branch', () => {
    const rows = buildChapterTree(
      [
        { value: 'a', label: 'a', level: 1 },
        { value: 'gap', label: 'gap', level: 3 },
        { value: 'sibling', label: 'sibling', level: 3 },
        { value: 'mid', label: 'mid', level: 2 },
        { value: 'b', label: 'b', level: 1 },
      ],
      LEADING,
    );
    expect(rows.map((r) => [r.node.value, r.parent, r.depth, r.hasChildren])).toEqual([
      ['none', -1, 1, false],
      ['a', -1, 1, true],
      ['gap', 1, 2, false],
      ['sibling', 1, 2, false],
      ['mid', 1, 2, false],
      ['b', -1, 1, false],
    ]);
  });

  it('never nests the chapters under a fixed choice, even when the outline starts deep', () => {
    const rows = buildChapterTree([{ value: 'deep', label: 'deep', level: 2 }], LEADING);
    expect(rows[1]).toMatchObject({ parent: -1, depth: 1 });
  });

  it('starts with groups and the path of the chosen row open', () => {
    const rows = buildChapterTree(
      [{ value: 'doc', label: 'doc', level: 0, group: true }, ...OUTLINE],
      LEADING,
    );
    expect([...initialExpanded(rows, 'x')].sort()).toEqual(['c2', 'doc', 's21']);
  });

  it('counts position and set size among the rows on screen', () => {
    const rows = buildChapterTree(OUTLINE, LEADING);
    const shown = visibleRows(rows, new Set(), '2.1');
    expect(shown.map((v) => [v.row.node.value, v.position, v.setSize, v.expanded])).toEqual([
      ['c2', 1, 1, true],
      ['s21', 1, 1, true],
      ['x', 1, 1, false],
    ]);
  });

  it('does not match a group by its own title', () => {
    const rows = buildChapterTree([
      { value: 'doc', label: '교재', level: 0, group: true },
      { value: 'a', label: '1장', level: 1 },
    ]);
    expect(visibleRows(rows, new Set(), '교재')).toEqual([]);
  });
});

describe('ChapterPicker', () => {
  it('is a combobox showing the choice; the tree exists only while open', async () => {
    const user = userEvent.setup();
    render(<Harness initial="s12" />);
    expect(trigger()).toHaveTextContent('1.2 강수');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('tree')).toBeNull();

    await user.click(trigger());
    expect(await row('1.2 강수')).toHaveAttribute('aria-selected', 'true');
    expect(names()).toEqual(['챕터 없음', '1장 물의 순환', '1.1 증발', '1.2 강수', '2장 정수']);
    expect(await axeViolations()).toEqual([]);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tree')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('expands and collapses without choosing; a row chooses and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: '1장 물의 순환 펼치기' }));
    expect(await row('1.1 증발')).toHaveAttribute('aria-level', '2');
    await user.click(screen.getByRole('button', { name: '1장 물의 순환 접기' }));
    expect(screen.queryByRole('treeitem', { name: '1.1 증발' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(await row('2장 정수'));
    expect(onChange).toHaveBeenCalledWith('c2');
    expect(screen.queryByRole('tree')).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveTextContent('2장 정수');
  });

  it('walks the tree from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    const filter = await screen.findByRole('searchbox', { name: '챕터 찾기' });
    expect(filter).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(await row('챕터 없음')).toHaveFocus();
    await user.keyboard('{End}');
    expect(await row('2장 정수')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(await row('2장 정수')).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowRight}');
    expect(await row('2.1 응집')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(await row('2장 정수')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(await row('2장 정수')).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Home}');
    expect(await row('챕터 없음')).toHaveFocus();
    expect(document.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
    await user.keyboard('{ArrowUp}');
    expect(filter).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.queryByRole('tree')).toBeNull();
    expect(trigger()).toHaveTextContent('1장 물의 순환');
  });

  it('carries typing from the tree into the filter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await screen.findByRole('tree');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('2');
    expect(screen.getByRole('searchbox', { name: '챕터 찾기' })).toHaveFocus();
  });

  it('filters to matches and their parents, and restores the tree', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    const filter = await screen.findByRole('searchbox', { name: '챕터 찾기' });
    await user.type(filter, '세부');
    expect(names()).toEqual(['2장 정수', '2.1 응집', '2.1.1 세부']);
    expect(screen.queryByRole('button', { name: /접기|펼치기/ })).toBeNull();

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('찾는 챕터가 없습니다');
    expect(screen.queryByRole('tree')).toBeNull();

    await user.clear(filter);
    expect(names()).toEqual(['챕터 없음', '1장 물의 순환', '2장 정수']);
  });

  it('never chooses a group, which starts open and toggles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const nodes: ChapterPickerNode[] = [
      { value: 'doc:a', label: '교재 A', level: 0, group: true },
      { value: 'a1', label: '1장', level: 1, triggerLabel: '1장 (교재 A)' },
    ];
    render(<Harness nodes={nodes} onChange={onChange} />);
    await user.click(trigger());
    const group = await row('교재 A');
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(group).not.toHaveAttribute('aria-selected');
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
    await user.click(group);
    await user.click(await row('1장'));
    expect(trigger()).toHaveTextContent('1장 (교재 A)');
  });

  it('opens the groups of an outline that arrives while open', async () => {
    const user = userEvent.setup();
    const nodes: ChapterPickerNode[] = [
      { value: 'doc:a', label: '교재 A', level: 0, group: true },
      { value: 'a1', label: '1장', level: 1 },
    ];
    const { rerender } = render(<Harness nodes={[]} />);
    await user.click(trigger());
    await row('챕터 없음');
    rerender(<Harness nodes={nodes} />);
    expect(await row('교재 A')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the placeholder, and stays closed when disabled', async () => {
    const user = userEvent.setup();
    render(
      <ChapterPicker
        label="장"
        nodes={[]}
        value=""
        placeholder="문서를 먼저 선택하세요"
        disabled
      />,
    );
    const button = screen.getByRole('combobox', { name: '장' });
    expect(button).toHaveTextContent('문서를 먼저 선택하세요');
    expect(button).toHaveAttribute('data-placeholder');
    await user.click(button);
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('keeps 1000 closed pickers over 300 chapters at one button each (QIMP-REVIEW-SCALE)', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({
      value: `c${i}`,
      label: `제${i}장`,
      level: 1,
    }));
    const { container } = render(
      <>
        {Array.from({ length: 1000 }, (_, i) => (
          <ChapterPicker
            key={i}
            label={`${i}번 문제 챕터`}
            hideLabel
            leading={LEADING}
            nodes={nodes}
            value="c299"
          />
        ))}
      </>,
    );
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    expect(document.querySelectorAll('[role="tree"]')).toHaveLength(0);
    // Label + trigger + value + icon: nothing grows with the 300 chapters.
    expect(container.querySelectorAll('*').length).toBeLessThan(1000 * 12);
    expect(within(container).getAllByRole('combobox')[999]).toHaveTextContent('제299장');
  }, 60_000);
});
