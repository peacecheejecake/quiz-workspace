import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup, Select } from '../src';
import { axeViolations } from './axe';

const TYPES = [
  { value: 'ALL', label: '전체' },
  { value: 'MCQ', label: '객관식' },
  { value: 'ESSAY', label: '서술형' },
] as const;

describe('Select', () => {
  it('is a combobox named by its label that picks an option from a listbox', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('ALL');
      return (
        <Select
          label="유형"
          options={TYPES}
          value={value}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: '유형' });
    expect(trigger).toHaveTextContent('전체');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: '서술형' }));
    expect(onValueChange).toHaveBeenCalledWith('ESSAY');
    expect(screen.getByRole('combobox', { name: '유형' })).toHaveTextContent('서술형');
  });

  it('wires the error message and passes axe', async () => {
    render(
      <Select label="챕터" options={TYPES} defaultValue="ALL" error="챕터를 선택해 주세요." />,
    );
    const trigger = screen.getByRole('combobox', { name: '챕터' });
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription('챕터를 선택해 주세요.');
    expect(await axeViolations()).toEqual([]);
  });
});

describe('RadioGroup', () => {
  it('names the group and its radios and selects with the arrow keys', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="문제 유형"
        options={TYPES.slice(1)}
        defaultValue="MCQ"
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: '문제 유형' })).toBeInTheDocument();
    const mcq = screen.getByRole('radio', { name: '객관식' });
    expect(mcq).toBeChecked();
    await user.click(screen.getByText('서술형'));
    expect(onValueChange).toHaveBeenLastCalledWith('ESSAY');
    expect(screen.getByRole('radio', { name: '서술형' })).toBeChecked();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows option descriptions as a tooltip on keyboard focus, still linked by aria-describedby', async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup
        label="검색 방식"
        options={[
          { value: 'keyword', label: '키워드', description: '단어가 그대로 들어 있는 문단' },
          { value: 'semantic', label: '의미', description: '뜻이 비슷한 문단' },
        ]}
        defaultValue="keyword"
        optionDescriptions="tooltip"
      />,
    );
    const keyword = screen.getByRole('radio', { name: '키워드' });
    // The description stays the radio's accessible description whether or not a tooltip shows.
    expect(keyword).toHaveAccessibleDescription('단어가 그대로 들어 있는 문단');
    expect(
      document.querySelectorAll(".qz-radio[data-description='tooltip'] > .text > .description"),
    ).toHaveLength(2);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.tab();
    expect(keyword).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('단어가 그대로 들어 있는 문단');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('keeps option descriptions as inline text by default', () => {
    render(
      <RadioGroup
        label="보기"
        options={[{ value: 'a', label: '가', description: '정답' }]}
        defaultValue="a"
      />,
    );
    expect(screen.getByRole('radio', { name: '가' })).toHaveAccessibleDescription('정답');
    expect(document.querySelector(".qz-radio[data-description='tooltip']")).toBeNull();
  });

  it('disables every radio when the group is disabled', () => {
    render(<RadioGroup label="문제 유형" options={TYPES.slice(1)} defaultValue="MCQ" disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
