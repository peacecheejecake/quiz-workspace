// @vitest-environment jsdom
// UX6-UPLOAD (DOC-01-AC06–AC08): the kind badge text, what `문서 n` counts, which rows have
// questions, the `종류 변경` client call and its refusals, and the row's kind menu (Radix menu
// with radio items, the current kind checked, a refusal as an alert in the row).
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  bodyDocumentCount,
  hasQuestions,
  kindBadgeLabel,
} from '../src/components/documents/labels';
import { createDocumentsClient, type DocumentSummary } from '../src/lib/documents/client-api';
import { DocumentApiError } from '../src/lib/documents/errors';
import { buildRows } from '../src/lib/documents/upload-machine';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { DocumentRowItem } = await import('../src/components/documents/document-row');

const AT = '2026-10-28T00:00:00Z';

function doc(id: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    workspace_id: 'ws',
    document_type: 'book',
    kind: 'book',
    title: `문서 ${id}`,
    filename: `${id}.pdf`,
    size_bytes: 100,
    sha256: 'a'.repeat(64),
    status: 'ready',
    active_revision_id: `rev-${id}`,
    last_error: null,
    created_at: AT,
    updated_at: AT,
    processing_job: null,
    ...extra,
  };
}

describe('kind labels and counts', () => {
  it('names the kind as text, "분석 중" while it is not known yet, nothing for a failed PDF', () => {
    expect(kindBadgeLabel({ kind: 'book', status: 'ready' })).toBe('교재');
    expect(kindBadgeLabel({ kind: 'question_paper', status: 'ready' })).toBe('문제지');
    expect(kindBadgeLabel({ kind: 'mixed', status: 'processing' })).toBe('교재+문제');
    expect(kindBadgeLabel({ kind: null, status: 'uploading' })).toBe('분석 중');
    expect(kindBadgeLabel({ kind: null, status: 'processing' })).toBe('분석 중');
    expect(kindBadgeLabel({ kind: null, status: 'failed' })).toBeNull();
  });

  it('counts the PDFs with body text: 교재 and 교재+문제, not 문제지 or unclassified ones', () => {
    expect(
      bodyDocumentCount([
        doc('b'),
        doc('m', { kind: 'mixed' }),
        doc('q', { kind: 'question_paper', document_type: 'question_paper' }),
        doc('n', { kind: null, status: 'processing' }),
        // From before UX6-UPLOAD-B: no kind in the list, its type decides.
        doc('old', { kind: undefined }),
        doc('oldq', { kind: undefined, document_type: 'question_paper' }),
      ]),
    ).toBe(3);
  });

  it('says which rows have questions: a 문제지, a 교재+문제 or an extracted PDF', () => {
    expect(hasQuestions({ kind: 'question_paper', latestImportId: null })).toBe(true);
    expect(hasQuestions({ kind: 'mixed', latestImportId: null })).toBe(true);
    expect(hasQuestions({ kind: 'book', latestImportId: null })).toBe(false);
    expect(hasQuestions({ kind: 'book', latestImportId: 'run' })).toBe(true);
    expect(hasQuestions({ kind: null, latestImportId: undefined })).toBe(false);
  });
});

describe('updateDocumentKind', () => {
  it('PATCHes the kind through the same-origin relay and returns the document', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ...doc('d1'), kind: 'mixed', kind_source: 'user' }),
    );
    const client = createDocumentsClient(fetchMock);
    const updated = await client.updateDocumentKind('d1', 'mixed');
    expect(updated.kind).toBe('mixed');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/documents/d1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'mixed', extract: true });
  });

  it('turns 409 document-in-use / document-not-ready into their reasons', async () => {
    const problem = (type: string) =>
      vi.fn(async () =>
        Response.json(
          { type: `urn:quiz-workspace:problem:${type}`, status: 409, title: 'Conflict' },
          { status: 409 },
        ),
      );
    const inUse = createDocumentsClient(problem('document-in-use'));
    const error = await inUse.updateDocumentKind('d1', 'question_paper').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentApiError);
    expect((error as DocumentApiError).kind).toBe('inUse');
    expect((error as DocumentApiError).message).toBe(
      '이 교재의 챕터나 출처를 쓰는 문제가 있어 문제지로 바꿀 수 없습니다.',
    );
    const notReady = createDocumentsClient(problem('document-not-ready'));
    const other = await notReady.updateDocumentKind('d1', 'book').catch((e: unknown) => e);
    expect((other as DocumentApiError).kind).toBe('notReady');
  });
});

describe('DocumentRowItem kind badge and 종류 변경', () => {
  const rowOf = (extra: Partial<DocumentSummary> = {}) => {
    const [row] = buildRows([doc('d1', { title: '모의고사', ...extra })], []);
    if (!row) throw new Error('no row');
    return row;
  };
  const noop = () => undefined;

  it('shows the kind badge before the status badge and a menu with the current kind checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ul>
        <DocumentRowItem
          row={rowOf({ kind: 'question_paper', document_type: 'question_paper' })}
          workspaceId="ws"
          canEdit
          onCancel={noop}
          onRetry={noop}
          onDelete={noop}
          kindChange={{ onChange, busy: false }}
        />
      </ul>,
    );
    const kind = screen.getByText('문제지');
    const status = screen.getByText('준비 완료');
    expect(kind.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    screen.getByRole('button', { name: '모의고사 종류 변경' }).focus();
    await user.keyboard('{Enter}'); // opens with the first item focused
    const menu = await screen.findByRole('menu', { name: '모의고사 종류 변경' });
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['교재', 'false'],
      ['문제지', 'true'],
      ['교재+문제', 'false'],
    ]);
    expect(menu).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'd1' }), 'mixed');
  });

  it('shows a refusal as an alert in the row', () => {
    render(
      <ul>
        <DocumentRowItem
          row={rowOf()}
          workspaceId="ws"
          canEdit
          onCancel={noop}
          onRetry={noop}
          onDelete={noop}
          kindChange={{ onChange: noop, busy: false, failure: '바꿀 수 없습니다.' }}
        />
      </ul>,
    );
    expect(screen.getByRole('alert').textContent).toBe('바꿀 수 없습니다.');
  });

  it('has no menu while processing ("분석 중") or without kindChange (viewers)', () => {
    const { unmount } = render(
      <ul>
        <DocumentRowItem
          row={rowOf({ kind: null, status: 'processing' })}
          workspaceId="ws"
          canEdit
          onCancel={noop}
          onRetry={noop}
          onDelete={noop}
          kindChange={{ onChange: noop, busy: false }}
        />
      </ul>,
    );
    expect(screen.getByText('분석 중')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /종류 변경/ })).toBeNull();
    unmount();
    render(
      <ul>
        <DocumentRowItem
          row={rowOf()}
          workspaceId="ws"
          canEdit={false}
          onCancel={noop}
          onRetry={noop}
          onDelete={noop}
        />
      </ul>,
    );
    expect(screen.getByText('교재')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /종류 변경/ })).toBeNull();
  });
});
