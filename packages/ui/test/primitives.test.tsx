import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Checkbox,
  CloseIcon,
  FocusRing,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Switch,
  Textarea,
  focusRingClassName,
} from '../src';
import { axeViolations } from './axe';

describe('axe helper', () => {
  it('reports real violations (guards against a false GREEN)', async () => {
    render(
      <button type="button">
        <svg aria-hidden="true" />
      </button>,
    );
    expect((await axeViolations()).join('\n')).toMatch(/^button-name/);
  });
});

describe('IconButton', () => {
  it('uses the required label as its accessible name', () => {
    render(<IconButton label="닫기" icon={<CloseIcon />} />);
    expect(screen.getByRole('button', { name: '닫기' })).toBeInTheDocument();
  });

  it('rejects a missing label at compile time and an empty label at runtime', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // @ts-expect-error `label` is required.
    expect(() => render(<IconButton icon={<CloseIcon />} />)).toThrow(/label/);
    expect(() => render(<IconButton label="  " icon={<CloseIcon />} />)).toThrow(/label/);
  });

  it('does not accept aria-label as a substitute for label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // @ts-expect-error aria-label is derived from `label`.
    expect(() => render(<IconButton aria-label="닫기" icon={<CloseIcon />} />)).toThrow();
  });
});

describe('Button', () => {
  it('defaults to type=button and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>저장</Button>);
    const button = screen.getByRole('button', { name: '저장' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is busy and not clickable while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        저장
      </Button>,
    );
    const button = screen.getByRole('button', { name: '저장' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders a link with button styles via asChild', () => {
    render(
      <Button asChild variant="primary">
        <a href="/workspaces">Workspace</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Workspace' });
    expect(link).toHaveClass('qz-button', focusRingClassName);
    expect(link).toHaveAttribute('data-variant', 'primary');
  });
});

describe('Input / Textarea', () => {
  it('wires label, description and error for assistive technology', () => {
    render(
      <Input
        label="이메일"
        description="로그인에 사용합니다."
        error="이메일 형식이 올바르지 않습니다."
      />,
    );
    const input = screen.getByRole('textbox', { name: '이메일' });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(
      '로그인에 사용합니다. 이메일 형식이 올바르지 않습니다.',
    );
    expect(input).toHaveAccessibleErrorMessage('이메일 형식이 올바르지 않습니다.');
  });

  it('is valid without an error and supports a visually hidden label', () => {
    render(<Textarea label="메모" hideLabel />);
    const textarea = screen.getByRole('textbox', { name: '메모' });
    expect(textarea).toBeValid();
    expect(screen.getByText('메모')).toHaveClass('qz-visually-hidden');
  });
});

describe('Checkbox', () => {
  it('toggles with the label and keyboard', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="기억하기" onCheckedChange={onCheckedChange} />);
    const checkbox = screen.getByRole('checkbox', { name: '기억하기' });
    await user.click(screen.getByText('기억하기'));
    expect(checkbox).toBeChecked();
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
  });

  it('exposes the indeterminate state', () => {
    render(<Checkbox label="전체 선택" checked="indeterminate" />);
    expect(screen.getByRole('checkbox', { name: '전체 선택' })).toBePartiallyChecked();
  });
});

describe('Switch', () => {
  it('is a labelled switch with visible state text, toggled by click and keyboard', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [on, setOn] = useState(false);
      return <Switch label="Fork 허용" checked={on} onCheckedChange={setOn} />;
    }
    render(<Controlled />);
    const control = screen.getByRole('switch', { name: 'Fork 허용' });
    expect(control).not.toBeChecked();
    expect(screen.getByText('꺼짐')).toBeInTheDocument();
    await user.click(screen.getByText('Fork 허용'));
    expect(control).toBeChecked();
    expect(screen.getByText('켜짐')).toBeInTheDocument();
    control.focus();
    await user.keyboard(' ');
    expect(control).not.toBeChecked();
  });
});

describe('Badge / Skeleton / FocusRing', () => {
  it('Badge conveys tone through text, the dot is decorative', () => {
    render(<Badge tone="danger">오답</Badge>);
    const badge = screen.getByText('오답');
    expect(badge).toHaveAttribute('data-tone', 'danger');
    expect(badge.querySelector(':scope > .dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('Skeleton is hidden from assistive technology', () => {
    const { container } = render(<Skeleton width="10rem" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('FocusRing adds the shared focus class to its child', () => {
    render(
      <FocusRing className="extra">
        <a href="#x">링크</a>
      </FocusRing>,
    );
    expect(screen.getByRole('link')).toHaveClass(focusRingClassName, 'extra');
  });
});

describe('Popover', () => {
  it('opens from the trigger, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>미리보기</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="문제 미리보기" closeLabel="닫기">
          내용
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: '미리보기' });
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: '문제 미리보기' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
