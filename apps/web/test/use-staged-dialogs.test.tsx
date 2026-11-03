// @vitest-environment jsdom
// HOMEDLG-01 (UX9-MODAL): the home's modal dialogs mount one per commit in opening order, so a
// deep link listing several stacks them in URL order with the last on top (each modal layer takes
// its place — focus trap, hidden background, Escape rank — when it mounts).
import './dom-setup';
import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useStagedDialogs } from '../src/components/workspaces/use-staged-dialogs';

function Probe({ wanted, commits }: { wanted: readonly string[]; commits: string[][] }) {
  const shown = useStagedDialogs(wanted);
  useEffect(() => {
    commits.push([...shown]);
  });
  return null;
}

describe('useStagedDialogs', () => {
  it('adds a deep link’s dialogs one commit at a time, in URL order', () => {
    const commits: string[][] = [];
    render(<Probe wanted={['documents', 'mock-exams', 'practice']} commits={commits} />);
    expect(commits).toEqual([
      [],
      ['documents'],
      ['documents', 'mock-exams'],
      ['documents', 'mock-exams', 'practice'],
    ]);
  });

  it('drops a closed dialog at once and appends a newly opened one on top', () => {
    const commits: string[][] = [];
    const view = render(<Probe wanted={['documents', 'history']} commits={commits} />);
    commits.length = 0;
    view.rerender(<Probe wanted={['documents']} commits={commits} />);
    expect(commits[0]).toEqual(['documents']);
    commits.length = 0;
    view.rerender(<Probe wanted={['documents', 'document-summary']} commits={commits} />);
    expect(commits.at(-1)).toEqual(['documents', 'document-summary']);
  });
});
