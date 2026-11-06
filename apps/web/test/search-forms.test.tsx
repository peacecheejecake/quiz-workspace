// @vitest-environment jsdom
// UX12-FILTER and SEARCH-01-AC09/AC11 (UX7-SEARCH): the home's search and filter line, the 본문
// search form (a stated reason when there is nothing to search) and the result list's item click.
import './dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SEARCH_BLOCKED,
  ContentSearchForm,
} from '../src/components/search/content-search-form';
import { QUESTION_SEARCH_BLOCKED, QuestionSearch } from '../src/components/search/question-search';
import { SearchResultList } from '../src/components/search/search-result-list';
import type { LiveQuery } from '../src/components/search/use-live-query';
import type { SearchItem } from '../src/lib/search/client';

const liveQuery = (value = ''): LiveQuery => ({
  value,
  inputProps: {
    value,
    onChange: vi.fn(),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
  },
  flush: vi.fn(),
  clear: vi.fn(),
  replace: vi.fn(),
});

function Search({
  initial = '',
  searchable = true,
  filterActive = false,
}: {
  readonly initial?: string;
  readonly searchable?: boolean;
  readonly filterActive?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const query = {
    ...liveQuery(value),
    clear: () => {
      clear();
      setValue('');
    },
    flush,
  };
  return (
    <>
      <button type="button" onClick={() => setValue('외부')}>
        URL 변경
      </button>
      <QuestionSearch
        query={query}
        max={200}
        searchable={searchable}
        filterActive={filterActive}
        filters={<p>챕터 필터</p>}
      />
    </>
  );
}

const clear = vi.fn();
const flush = vi.fn();
const line = () => screen.getByRole('search', { name: '문제 검색' });
const box = () => line().querySelector('input') as HTMLInputElement;

describe('QuestionSearch', () => {
  it('UX12-FILTER-AC02 opens beside the filter button and moves focus to the box', async () => {
    const user = userEvent.setup();
    render(<Search />);
    expect(box().closest('[inert]')).not.toBeNull();
    const button = screen.getByRole('button', { name: '검색' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(box()).toHaveFocus();
    expect(box().closest('[inert]')).toBeNull();
    const close = screen.getByRole('button', { name: '검색 닫기' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(close).toHaveAttribute('data-variant', 'ghost');

    // Enter is not needed, but commits at once.
    flush.mockClear();
    await user.type(box(), '{Enter}');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('UX12-FILTER-AC03 closing clears the query and returns focus to the button', async () => {
    const user = userEvent.setup();
    clear.mockClear();
    render(<Search initial="염소" />);
    expect(box()).toHaveValue('염소');
    const close = screen.getByRole('button', { name: '검색 닫기' });
    await user.click(close);
    expect(clear).toHaveBeenCalledTimes(1);
    const button = screen.getByRole('button', { name: '검색' });
    expect(button).toHaveFocus();
    expect(box().closest('[inert]')).not.toBeNull();
  });

  it('UX12-FILTER-AC04 opens when a query arrives while closed, without taking focus', async () => {
    const user = userEvent.setup();
    render(<Search />);
    const external = screen.getByRole('button', { name: 'URL 변경' });
    await user.click(external);
    expect(screen.getByRole('searchbox', { name: '문제 검색' })).toHaveValue('외부');
    expect(external).toHaveFocus();
  });

  it('UX12-FILTER-AC05 is disabled with a stated reason without questions', () => {
    render(<Search searchable={false} />);
    const button = screen.getByRole('button', { name: '검색' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(QUESTION_SEARCH_BLOCKED);
    expect(button).toHaveAccessibleDescription(QUESTION_SEARCH_BLOCKED);
    expect(box()).toBeDisabled();
  });

  it('keeps a way out when the last question goes while the search is open', () => {
    render(<Search initial="염소" searchable={false} />);
    expect(screen.getByRole('button', { name: '검색 닫기' })).toBeEnabled();
    expect(box()).toBeDisabled();
  });

  it('UX12-FILTER-AC06 holds the filters in a popover and says when one is set', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Search />);
    const filter = screen.getByRole('button', { name: '필터' });
    expect(filter).not.toHaveAttribute('data-active');
    expect(filter).not.toHaveAccessibleDescription('필터 적용 중');
    expect(screen.queryByText('챕터 필터')).toBeNull();
    await user.click(filter);
    expect(await screen.findByRole('dialog', { name: '필터' })).toHaveTextContent('챕터 필터');

    rerender(<Search filterActive />);
    expect(filter).toHaveAttribute('data-active', 'true');
    expect(filter).toHaveAccessibleDescription('필터 적용 중');
  });
});

describe('ContentSearchForm', () => {
  it('searches on Enter and the icon button; its 설정 popover holds the 본문 options', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ContentSearchForm
        draft="chlorine"
        onDraftChange={vi.fn()}
        onSearch={onSearch}
        searchable
        settings={<p>검색 방식 설정</p>}
      />,
    );
    expect(screen.getByRole('search', { name: '본문 검색' })).toBeVisible();
    const submit = screen.getByRole('button', { name: '검색' });
    expect(submit).toHaveTextContent('');
    await user.click(submit);
    await user.type(screen.getByRole('searchbox', { name: '본문 검색어' }), '{Enter}');
    expect(onSearch).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '본문 설정' }));
    expect(screen.getByRole('dialog', { name: '본문 검색 설정' })).toHaveTextContent(
      '검색 방식 설정',
    );
  });

  it('disables the button with a stated reason without a published document', async () => {
    const onSearch = vi.fn();
    render(
      <ContentSearchForm
        draft="chlorine"
        onDraftChange={vi.fn()}
        onSearch={onSearch}
        searchable={false}
        settings={null}
      />,
    );
    const submit = screen.getByRole('button', { name: '검색' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(CONTENT_SEARCH_BLOCKED);
    expect(screen.getByRole('status')).toHaveTextContent(CONTENT_SEARCH_BLOCKED);
    const box = screen.getByRole('searchbox', { name: '본문 검색어' });
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription(CONTENT_SEARCH_BLOCKED);
    fireEvent.submit(screen.getByRole('search', { name: '본문 검색' }));
    expect(onSearch).not.toHaveBeenCalled();
  });
});

const hit = (rank: number, text: string): SearchItem =>
  ({
    document_id: 'd',
    document_title: `Book ${rank}`,
    revision_id: 'r',
    chunk_id: `c${rank}`,
    breadcrumb: ['Book', 'Chapter'],
    block_id: 'p1',
    block_ids: ['p1'],
    page: rank,
    text,
    highlights: [],
    term_highlights: [{ start: 0, end: 5 }],
    truncated_start: false,
    truncated_end: false,
    language: 'en',
    rank,
  }) as unknown as SearchItem;

describe('SearchResultList (SEARCH-01-AC11)', () => {
  it('opens a hit from anywhere on its item, or from its title button by keyboard', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const items = [hit(1, 'water first'), hit(2, 'water second')];
    render(<SearchResultList items={items} selectedKey={null} onOpen={onOpen} />);
    const [first, second] = screen.getAllByRole('listitem');
    if (!first || !second) throw new Error('two items');

    await user.click(second.querySelector('blockquote') as HTMLElement);
    expect(onOpen).toHaveBeenLastCalledWith(items[1]);
    await user.click(second.querySelector('p, span') ?? second);
    expect(onOpen).toHaveBeenCalledTimes(2);

    const title = screen.getByRole('button', { name: 'Book 1' });
    title.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith(items[0]);
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(4);
  });

  it('marks the selected hit and does not open while text is being selected', async () => {
    const onOpen = vi.fn();
    const items = [hit(1, 'water first')];
    const key = 'd:c1:1';
    render(<SearchResultList items={items} selectedKey={key} onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: 'Book 1' })).toHaveAttribute('aria-current', 'true');
    const quote = screen.getByRole('listitem').querySelector('blockquote') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(quote);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    quote.click();
    expect(onOpen).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    quote.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
