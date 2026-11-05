// @vitest-environment jsdom
// SEARCH-01-AC09/AC11 (UX7-SEARCH): the home's two search forms (each with its own "설정" popover
// and stated reason when there is nothing to search) and the result list's item click.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  replace: vi.fn(),
});

describe('QuestionSearch', () => {
  it('UX10-HOME-AC02 shows filters below the search and preserves them when collapsed', async () => {
    const user = userEvent.setup();
    const query = liveQuery('염소');
    render(<QuestionSearch query={query} max={200} searchable settings={<p>챕터 필터</p>} />);
    expect(screen.getByRole('search', { name: '문제 검색' })).toBeVisible();
    const box = screen.getByRole('searchbox', { name: '문제 검색' });
    expect(box).toBeEnabled();
    expect(box).toHaveValue('염소');
    expect(screen.queryByRole('button', { name: '검색' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    const settings = screen.getByRole('button', { name: '검색 설정' });
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('챕터 필터')).toBeVisible();
    await user.click(settings);
    expect(settings).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('챕터 필터')).not.toBeVisible();
    await user.click(settings);
    expect(screen.getByText('챕터 필터')).toBeVisible();

    // Enter is not needed, but commits at once.
    await user.type(box, '{Enter}');
    expect(query.flush).toHaveBeenCalledTimes(1);
  });

  it('is disabled with a stated reason without questions', () => {
    render(<QuestionSearch query={liveQuery()} max={200} searchable={false} settings={null} />);
    const box = screen.getByRole('searchbox', { name: '문제 검색' });
    expect(box).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(QUESTION_SEARCH_BLOCKED);
    expect(box).toHaveAccessibleDescription(QUESTION_SEARCH_BLOCKED);
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
    const user = userEvent.setup();
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
    await user.type(screen.getByRole('searchbox', { name: '본문 검색어' }), '{Enter}');
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
