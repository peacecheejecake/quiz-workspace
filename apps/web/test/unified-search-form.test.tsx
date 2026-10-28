// @vitest-environment jsdom
// SEARCH-01-AC07 (UX6): the unified search form's scope checkboxes, per-scope settings popovers
// and the disabled search button with its stated reason.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSearchForm } from '../src/components/search/unified-search-form';
import { searchReadiness, type ScopeFlags } from '../src/lib/search/scope';

function setup(checked: ScopeFlags, available: ScopeFlags) {
  const onSearch = vi.fn();
  const onQuestions = vi.fn();
  const onBody = vi.fn();
  render(
    <UnifiedSearchForm
      draft="chlorine"
      onDraftChange={vi.fn()}
      onSearch={onSearch}
      readiness={searchReadiness(checked, available)}
      questions={{
        checked: checked.questions,
        onCheckedChange: onQuestions,
        settings: <p>챕터 필터</p>,
      }}
      body={{ checked: checked.body, onCheckedChange: onBody, settings: <p>검색 방식 설정</p> }}
    />,
  );
  return { onSearch, onQuestions, onBody, user: userEvent.setup() };
}

const both = { questions: true, body: true };

describe('UnifiedSearchForm', () => {
  it('shows both scope checkboxes and searches when there is content', async () => {
    const { onSearch, user } = setup(both, both);
    expect(screen.getByRole('checkbox', { name: '문제' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '본문' })).toBeChecked();
    const submit = screen.getByRole('button', { name: '검색' });
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute('aria-describedby');
    await user.click(submit);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('reports checkbox changes, including turning the last one off', async () => {
    const { onQuestions, onBody, user } = setup({ questions: true, body: false }, both);
    await user.click(screen.getByRole('checkbox', { name: '문제' }));
    expect(onQuestions).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole('checkbox', { name: '본문' }));
    expect(onBody).toHaveBeenCalledWith(true);
  });

  it('opens each scope settings popover by click and by keyboard', async () => {
    const { user } = setup(both, both);
    const questionSettings = screen.getByRole('button', { name: '문제 설정' });
    expect(questionSettings).toHaveAttribute('aria-expanded', 'false');
    await user.click(questionSettings);
    const popover = await screen.findByRole('dialog', { name: '문제 검색 설정' });
    expect(popover).toHaveTextContent('챕터 필터');
    expect(screen.queryByText('검색 방식 설정')).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '문제 검색 설정' })).toBeNull();

    screen.getByRole('button', { name: '본문 설정' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: '본문 검색 설정' })).toHaveTextContent(
      '검색 방식 설정',
    );
  });

  it.each([
    [{ questions: false, body: false }, both, '검색 범위를 하나 이상 선택하세요.'],
    [both, { questions: false, body: false }, /검색할 문제와 본문이 없습니다/],
    [{ questions: true, body: false }, { questions: false, body: true }, /검색할 문제가 없습니다/],
    [{ questions: false, body: true }, { questions: true, body: false }, /검색할 본문이 없습니다/],
  ])('disables the search with a described reason (%o, %o)', async (checked, available, text) => {
    const { onSearch, user } = setup(checked, available);
    const submit = screen.getByRole('button', { name: '검색' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(text);
    expect(screen.getByRole('status')).toHaveTextContent(text);
    await user.type(screen.getByRole('searchbox', { name: '검색어' }), '{Enter}');
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('says which side runs when both are checked and one is empty', () => {
    setup(both, { questions: false, body: true });
    const submit = screen.getByRole('button', { name: '검색' });
    expect(submit).toBeEnabled();
    expect(submit).toHaveAccessibleDescription('등록된 문제가 없어 본문만 검색합니다.');
  });
});
