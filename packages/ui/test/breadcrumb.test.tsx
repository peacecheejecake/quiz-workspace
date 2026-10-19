import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BackLink, Breadcrumb, PageHeader } from '../src';
import { axeViolations } from './axe';

/** Stand-in for next/link: marks the anchors it renders. */
function FakeLink({
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a data-router-link="" {...props}>
      {children}
    </a>
  );
}

const ITEMS = [
  { label: '운영체제', href: '/workspaces/ws' },
  { label: '문서', href: '/workspaces/ws/documents' },
  { label: '3장 프로세스' },
];

describe('Breadcrumb', () => {
  it('is a labelled nav with an ordered list; the last item is the current page', async () => {
    render(<Breadcrumb items={ITEMS} />);
    const nav = screen.getByRole('navigation', { name: '위치' });
    const list = within(nav).getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(nav).getByRole('link', { name: '운영체제' })).toHaveAttribute(
      'href',
      '/workspaces/ws',
    );
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
    expect(within(nav).getByText('3장 프로세스')).toHaveAttribute('aria-current', 'page');
    // Separators are decorative.
    expect(nav.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);
  });

  it('renders links with the given link component (e.g. next/link)', () => {
    render(<Breadcrumb items={ITEMS} linkComponent={FakeLink} label="문서 위치" />);
    const nav = screen.getByRole('navigation', { name: '문서 위치' });
    for (const link of within(nav).getAllByRole('link')) {
      expect(link).toHaveAttribute('data-router-link');
    }
  });
});

describe('BackLink', () => {
  it('is a link named by its label when given href', async () => {
    render(<BackLink href="/workspaces/ws/documents" label="문서 목록" linkComponent={FakeLink} />);
    const link = screen.getByRole('link', { name: '문서 목록' });
    expect(link).toHaveAttribute('href', '/workspaces/ws/documents');
    expect(link).toHaveAttribute('data-router-link');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(await axeViolations()).toEqual([]);
  });

  it('is a button that runs onClick without href, and keeps its name when icon-only', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<BackLink label="뒤로" hideLabel onClick={onClick} />);
    const button = screen.getByRole('button', { name: '뒤로' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-icon-only');
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('PageHeader navigation slots', () => {
  it('renders the back link and breadcrumb above the h1', () => {
    render(
      <PageHeader
        title="3장 프로세스"
        back={<BackLink href="/docs" label="문서 목록" />}
        breadcrumb={<Breadcrumb items={ITEMS} />}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: '3장 프로세스' });
    const nav = screen.getByRole('navigation', { name: '위치' });
    const back = screen.getByRole('link', { name: '문서 목록' });
    expect(back.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
