// @vitest-environment jsdom
// UX3b: the header workspace switcher separates the user's workspaces (a labelled group) from the
// "모든 Workspace 보기" entry with a separator; every entry is a link menu item.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkspaceSwitcher } from '../src/components/workspaces/workspace-switcher';

const A = { id: '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b', name: '운영체제' };
const B = { id: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', name: '자료구조' };

describe('WorkspaceSwitcher', () => {
  it('groups the workspaces under a label, then a separator, then the home link', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher current={{ ...A, status: 'active' }} workspaces={[A, B]} />);
    await user.click(screen.getByRole('button', { name: /Workspace 전환/ }));
    const menu = await screen.findByRole('menu');

    const group = within(menu).getByRole('group', { name: '내 Workspace' });
    const entries = within(group).getAllByRole('menuitem');
    expect(entries.map((e) => e.textContent)).toEqual(['운영체제', '자료구조']);
    expect(entries[0]).toHaveAttribute('aria-current', 'true');
    expect(entries[0]?.tagName).toBe('A');

    const all = within(menu).getByRole('menuitem', { name: '모든 Workspace 보기' });
    expect(group).not.toContainElement(all);
    expect(all).toHaveAttribute('href', '/workspaces');
    const separator = within(menu).getByRole('separator');
    // DOM order: group, separator, home link.
    expect(
      group.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(separator.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows only the home link when there are no other workspaces', async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher current={{ ...A, status: 'archived' }} workspaces={[]} />);
    await user.click(screen.getByRole('button', { name: /Workspace 전환/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('group')).toBeNull();
    expect(within(menu).queryByRole('separator')).toBeNull();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
  });
});
