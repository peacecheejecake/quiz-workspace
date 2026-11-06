// @vitest-environment jsdom
// UX12-SOURCE: the compare panel starts at the page a draft's page link asked for and keeps a way
// to the whole document.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceComparePanel } from '../src/components/questions/import/source-compare-panel';
import type { ReviewDraft } from '../src/lib/questions/drafts';

vi.mock('@/components/documents/editor/pdf-viewer', () => ({
  PdfViewer: ({ page }: { page: number }) => <p>viewer at {page}</p>,
}));

const DRAFT = {
  id: 'd1',
  questionNumber: 3,
  type: 'MULTIPLE_CHOICE',
  stem: '발문',
  options: [],
  pages: [2, 3],
  locations: [],
  sourceDocumentId: null,
  issues: [],
} as unknown as ReviewDraft;

const renderPanel = (initialPage?: number) =>
  render(
    <SourceComparePanel
      draft={DRAFT}
      initialPage={initialPage}
      sourceDocumentId="doc-1"
      workspaceId="ws-1"
      onClose={() => undefined}
    />,
  );

describe('UX12-SOURCE SourceComparePanel', () => {
  it('starts at the page that was asked for, on the run document of a draft without its own', () => {
    renderPanel(3);
    const panel = screen.getByRole('dialog', { name: '원본 PDF' });
    expect(within(panel).getByText('viewer at 3')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: '전체 문서 보기' })).toHaveAttribute(
      'href',
      '/workspaces/ws-1/documents/doc-1?page=3',
    );
  });

  it('starts at the first page without one', () => {
    renderPanel();
    expect(screen.getByText('viewer at 2')).toBeTruthy();
  });
});
