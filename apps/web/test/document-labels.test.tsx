// @vitest-environment jsdom
// UX12-DOCS-1: a processing row names its stage alone, never twice next to the kind badge, keeps
// a percent slot of constant width and cancels an upload with the delete button's icon button.
import './dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentRowItem } from '@/components/documents/document-row';
import { KIND_PENDING_LABEL, processingLabel } from '@/components/documents/labels';
import type { DocumentRow } from '@/lib/documents/upload-machine';

function processing(stage: string | null): DocumentRow {
  return {
    status: 'processing',
    title: '합성 교재',
    filename: 'book.pdf',
    size: 100,
    kind: null,
    job: { status: 'running', stage, progress: null },
  } as unknown as DocumentRow;
}

const uploading = {
  localId: 'l1',
  title: '합성 교재',
  filename: 'book.pdf',
  size: 200,
  status: 'uploading',
  kind: null,
  cancellable: true,
  upload: { phase: 'uploading', loaded: 50, total: 200 },
} as unknown as DocumentRow;

describe('DOC-01-AC05 processing stage labels', () => {
  it.each([
    ['loading', '파일 읽는 중'],
    ['downloading', '파일 읽는 중'],
    ['parsing', '파싱 중'],
    ['structuring', '구조 분석 중'],
    ['chunking', '색인 준비 중'],
    ['indexing', '색인 중'],
    ['publishing', '게시 중'],
  ])('DOC-01-AC05 %s is the bare stage name %s', (stage, label) => {
    expect(processingLabel(processing(stage))).toBe(label);
    expect(label).not.toBe(KIND_PENDING_LABEL);
  });

  it('DOC-01-AC05 a running job without a known stage is 처리 중', () => {
    expect(processingLabel(processing(null))).toBe('처리 중');
    expect(processingLabel(processing('mystery'))).toBe('처리 중');
  });
});

describe('DOC-01 row progress and cancel', () => {
  it('DOC-01-AC05 keeps the percent slot while the percent is unknown', () => {
    render(
      <ul>
        <DocumentRowItem row={processing('parsing')} workspaceId="ws" canEdit={false} />
      </ul>,
    );
    const slot = screen.getByRole('list', { name: '진행 단계' }).parentElement?.nextElementSibling;
    expect(slot?.tagName).toBe('SPAN');
    expect(slot).toBeEmptyDOMElement();
  });

  it('DOC-01-AC02 cancels an upload with an icon button named after the document', () => {
    const onCancel = vi.fn();
    render(
      <ul>
        <DocumentRowItem
          row={uploading}
          workspaceId="ws"
          canEdit
          onCancel={onCancel}
          onDelete={vi.fn()}
        />
      </ul>,
    );
    const button = screen.getByRole('button', { name: '업로드 취소: 합성 교재' });
    expect(button).toHaveAttribute('title', '업로드 취소');
    expect(button).toHaveAttribute('data-size', 'sm');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button).toHaveTextContent('');
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledWith('l1');
  });
});
