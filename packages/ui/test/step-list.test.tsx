import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepList } from '../src';

const STEPS = [
  { id: 'options', label: '옵션' },
  { id: 'range', label: '범위' },
] as const;

describe('StepList (UX12-MOCKFORM)', () => {
  it('is a named list with the current step and no progress bar', () => {
    render(<StepList label="모의고사 단계" steps={STEPS} current={0} />);
    const items = within(screen.getByRole('list', { name: '모의고사 단계' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes only done steps buttons, by label and keyboard', async () => {
    const onStepSelect = vi.fn();
    render(
      <StepList
        label="모의고사 단계"
        steps={STEPS}
        current={1}
        onStepSelect={onStepSelect}
        stepActionLabel={(step) => `${step.label} 단계로 돌아가기`}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    const back = screen.getByRole('button', { name: '옵션 단계로 돌아가기' });
    back.focus();
    await userEvent.keyboard('{Enter}');
    expect(onStepSelect).toHaveBeenCalledWith(0);
  });

  it('keeps a done step unpressable while the form works', () => {
    render(
      <StepList
        label="모의고사 단계"
        steps={STEPS}
        current={1}
        disabled
        onStepSelect={vi.fn()}
        stepActionLabel={(step) => `${step.label} 단계로 돌아가기`}
      />,
    );
    expect(screen.getByRole('button', { name: '옵션 단계로 돌아가기' })).toBeDisabled();
  });
});
