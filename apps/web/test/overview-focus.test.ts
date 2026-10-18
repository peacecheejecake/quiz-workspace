// @vitest-environment jsdom
// Focus return after the practice panel closes when the opening dot may be gone.
import './dom-setup';
import { describe, expect, it } from 'vitest';
import { focusAfterPanel } from '../src/components/questions/overview/questions-overview';

function heatmap(ids: string[], tabStop?: string): { root: HTMLElement; search: HTMLElement } {
  const root = document.createElement('div');
  for (const id of ids) {
    const b = document.createElement('button');
    b.dataset['questionId'] = id;
    b.tabIndex = id === tabStop ? 0 : -1;
    root.append(b);
  }
  const search = document.createElement('input');
  search.type = 'search';
  root.append(search);
  document.body.replaceChildren(root);
  return { root, search };
}

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset['questionId'];

describe('focusAfterPanel', () => {
  it('returns to the opening dot when it is still there', () => {
    const { root, search } = heatmap(['a', 'b', 'c']);
    focusAfterPanel(root, 'b', ORDER, search);
    expect(focusedId()).toBe('b');
  });

  it('falls back to the nearest surviving dot in the order the panel was opened on', () => {
    let h = heatmap(['a', 'd']);
    focusAfterPanel(h.root, 'c', ORDER, h.search);
    expect(focusedId()).toBe('d');
    h = heatmap(['a', 'e']);
    // Same distance on both sides: the following dot wins.
    focusAfterPanel(h.root, 'c', ORDER, h.search);
    expect(focusedId()).toBe('e');
    h = heatmap(['a']);
    focusAfterPanel(h.root, 'c', ORDER, h.search);
    expect(focusedId()).toBe('a');
  });

  it('uses the heatmap tab stop for a question that was never in the list', () => {
    const { root, search } = heatmap(['a', 'b'], 'b');
    focusAfterPanel(root, 'zz', ORDER, search);
    expect(focusedId()).toBe('b');
  });

  it('uses the stable fallback control when the heatmap is empty', () => {
    const { root, search } = heatmap([]);
    expect(focusAfterPanel(root, 'c', ORDER, search)).toBe(search);
    expect(document.activeElement).toBe(search);
  });
});
