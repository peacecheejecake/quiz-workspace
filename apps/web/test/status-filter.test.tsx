// UX12-HOMEFILTER: the home's status chips, 즐겨찾기만 and the 미열람 rule.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QUESTION_DOT_STATUSES, type QuestionDotStatus } from '@quiz/ui';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StatusFilter } from '@/components/questions/overview/status-filter';
import type { OverviewFilters } from '@/lib/questions/overview-filters';

function Filter({
  status = QUESTION_DOT_STATUSES,
  favorite = null,
  onChange,
}: {
  status?: readonly QuestionDotStatus[];
  favorite?: boolean | null;
  onChange?: (patch: Partial<OverviewFilters>) => void;
}) {
  const [state, setState] = useState({ status, favorite });
  return (
    <StatusFilter
      status={state.status}
      favorite={state.favorite}
      onFiltersChange={(patch) => {
        onChange?.(patch);
        setState((old) => ({ ...old, ...patch }));
      }}
    />
  );
}

const group = () => screen.getByRole('group', { name: '상태 필터' });
const chip = (name: string) => within(group()).getByRole('button', { name });
const REASON = /이미 열어 본 문제/;

describe('StatusFilter', () => {
  it('UX12-FILTER-AC01 shows every status and 즐겨찾기만, without 다시 풀기만', async () => {
    const onChange = vi.fn();
    render(<Filter onChange={onChange} />);
    expect(within(group()).queryByRole('button', { name: '다시 풀기만' })).toBeNull();
    expect(within(group()).queryByRole('button', { name: '필터 초기화' })).toBeNull();
    const retry = chip('다시 풀기');
    expect(retry).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(retry);
    expect(onChange).toHaveBeenCalledWith({ status: ['unseen', 'viewed', 'incorrect', 'correct'] });
  });

  it('UX12-HOMEFILTER-AC04 즐겨찾기만 turns 미열람 off, says why and gives it back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Filter onChange={onChange} />);
    expect(chip('미열람')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(REASON)).toBeNull();

    await user.click(chip('즐겨찾기만'));
    expect(onChange).toHaveBeenLastCalledWith({ favorite: true });
    const unseen = chip('미열람');
    expect(unseen).toHaveAttribute('aria-disabled', 'true');
    expect(unseen).toHaveAttribute('aria-pressed', 'false');
    expect(unseen).toBeEnabled(); // aria-disabled only: it stays focusable for its reason
    expect(unseen).toHaveAccessibleDescription(REASON);
    expect(screen.getByRole('status')).toHaveTextContent(REASON);

    onChange.mockClear();
    await user.click(unseen);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(chip('즐겨찾기만'));
    expect(onChange).toHaveBeenLastCalledWith({ favorite: null });
    expect(chip('미열람')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('미열람')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('UX12-HOMEFILTER-AC04 leaves 미열람 off if it was off', async () => {
    const user = userEvent.setup();
    render(<Filter status={['correct']} />);
    await user.click(chip('즐겨찾기만'));
    await user.click(chip('즐겨찾기만'));
    expect(chip('미열람')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('미열람')).not.toHaveAttribute('aria-disabled');
  });

  it('UX12-HOMEFILTER-AC05 applies the rule to a favorite=true address, not favorite=false', () => {
    const { unmount } = render(<Filter favorite />);
    expect(chip('미열람')).toHaveAttribute('aria-disabled', 'true');
    unmount();
    render(<Filter favorite={false} />);
    expect(chip('미열람')).not.toHaveAttribute('aria-disabled');
    expect(chip('미열람')).toHaveAttribute('aria-pressed', 'true');
  });

  it('UX12-HOMEFILTER-AC06 shows 즐겨찾기만 on by a check icon as well as its colour', async () => {
    const user = userEvent.setup();
    render(<Filter />);
    const favorite = chip('즐겨찾기만');
    expect(favorite.querySelector('svg')).toBeNull();
    await user.click(favorite);
    expect(favorite).toHaveAttribute('aria-pressed', 'true');
    expect(favorite.querySelector('svg')).not.toBeNull();
  });
});
