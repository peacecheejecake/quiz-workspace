import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup, Select, TOOLTIP_DELAY_MS, TOOLTIP_DESCRIPTION_DELAY_MS } from '../src';
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

describe('Select lazyOptions', () => {
  it('renders no option while closed, shows the selected label and still picks from the list', async () => {
    const user = userEvent.setup();
    const rendered = vi.fn();
    function Label({ text }: { text: string }) {
      rendered(text);
      return <>{text}</>;
    }
    const options = TYPES.map((t) => ({
      value: t.value,
      label: <Label text={t.label} />,
      textValue: t.label,
    }));
    function Harness() {
      const [value, setValue] = useState('MCQ');
      return (
        <Select label="챕터" lazyOptions options={options} value={value} onValueChange={setValue} />
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: '챕터' });
    expect(trigger).toHaveTextContent('객관식');
    // Closed: only the trigger's label renders (Radix would render every option off-screen).
    expect(rendered.mock.calls.map(([t]) => t)).toEqual(['객관식']);

    await user.click(trigger);
    expect(await screen.findAllByRole('option')).toHaveLength(TYPES.length);
    expect(screen.getByRole('option', { name: '객관식' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: '서술형' }));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: '챕터' })).toHaveTextContent('서술형');

    // Keyboard: Enter opens the list on the selected option, Arrow keys move, Enter picks.
    rendered.mockClear();
    screen.getByRole('combobox', { name: '챕터' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('option', { name: '서술형' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(screen.getByRole('combobox', { name: '챕터' })).toHaveTextContent('객관식');
    expect(screen.getByRole('combobox', { name: '챕터' })).toHaveFocus();
  });

  it('follows an uncontrolled value', async () => {
    const user = userEvent.setup();
    render(<Select label="유형" lazyOptions options={TYPES} defaultValue="ALL" />);
    const trigger = screen.getByRole('combobox', { name: '유형' });
    expect(trigger).toHaveTextContent('전체');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: '객관식' }));
    expect(trigger).toHaveTextContent('객관식');
  });
});

/**
 * Models iOS Safari (UX7-SELECT): when a touch `pointerup` is cancelled (`preventDefault`), WebKit
 * on iOS drops the click it would synthesize for that tap. jsdom and desktop browsers still click,
 * so without this a cancelled tap would look fine here and still do nothing on an iPhone.
 */
function modelIosClickSuppression(): () => void {
  let swallowNextClick = false;
  const onPointerUp = (event: PointerEvent) => {
    swallowNextClick = event.pointerType === 'touch' && event.defaultPrevented;
  };
  const onClick = (event: MouseEvent) => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('click', onClick, true);
  return () => {
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('click', onClick, true);
  };
}

describe('Select touch (UX7-SELECT)', () => {
  for (const lazyOptions of [false, true]) {
    it(`a tap on the selected option closes the list${lazyOptions ? ' (lazyOptions)' : ''}`, async () => {
      const restore = modelIosClickSuppression();
      try {
        const user = userEvent.setup();
        const onValueChange = vi.fn();
        function Harness() {
          const [value, setValue] = useState('ALL');
          return (
            <Select
              label="챕터"
              lazyOptions={lazyOptions}
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
        const trigger = screen.getByRole('combobox', { name: '챕터' });
        const cancelled: boolean[] = [];
        const record = (event: PointerEvent) => cancelled.push(event.defaultPrevented);

        // A tap opens the list; the selected option is the first row, right under the finger.
        await user.pointer({ keys: '[TouchA]', target: trigger });
        const selected = await screen.findByRole('option', { name: '전체' });
        window.addEventListener('pointerup', record);
        await user.pointer({ keys: '[TouchA]', target: selected });
        window.removeEventListener('pointerup', record);

        // The tap's pointerup is left alone (Radix cancels the first one after opening, which
        // makes iOS drop the tap), so the list closes on the first tap and the value stays.
        expect(cancelled).toEqual([false]);
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveTextContent('전체');
        expect(onValueChange).not.toHaveBeenCalledWith('MCQ');

        // A tap on another option still picks it.
        await user.pointer({ keys: '[TouchA]', target: trigger });
        await user.pointer({
          keys: '[TouchA]',
          target: await screen.findByRole('option', { name: '객관식' }),
        });
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(trigger).toHaveTextContent('객관식');
      } finally {
        restore();
      }
    });
  }

  it('UX12-POPPERS-AC07 a tap on the open trigger closes the list and its release click does not reopen it', async () => {
    const user = userEvent.setup();
    render(<Select label="유형" options={TYPES} defaultValue="ALL" />);
    const trigger = screen.getByRole('combobox', { name: '유형' });
    await user.pointer({ keys: '[TouchA]', target: trigger });
    await screen.findByRole('listbox');

    // The open list disables the page, so the tap lands on the root element, over the trigger.
    const press = new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 });
    Object.defineProperty(press, 'pointerType', { value: 'touch' });
    document.documentElement.dispatchEvent(press);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();

    // Nothing more is swallowed: a click with no press (a screen reader's activation) opens it.
    fireEvent.click(trigger);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('keeps the mouse and keyboard paths: clicking or pressing Enter on the selected option closes and refocuses the trigger', async () => {
    const user = userEvent.setup();
    render(<Select label="유형" options={TYPES} defaultValue="ALL" />);
    const trigger = screen.getByRole('combobox', { name: '유형' });

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: '전체' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('option', { name: '전체' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent('전체');
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

  it('waits the longer description delay before a hover opens the tooltip (UX3b)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <RadioGroup
          label="검색 방식"
          options={[{ value: 'keyword', label: '키워드', description: '단어가 그대로' }]}
          defaultValue="keyword"
          optionDescriptions="tooltip"
        />,
      );
      expect(TOOLTIP_DESCRIPTION_DELAY_MS).toBeGreaterThan(TOOLTIP_DELAY_MS);
      await user.hover(screen.getByText('키워드'));
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(TOOLTIP_DESCRIPTION_DELAY_MS - TOOLTIP_DELAY_MS));
      expect(screen.getByRole('tooltip')).toHaveTextContent('단어가 그대로');
    } finally {
      vi.useRealTimers();
    }
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
