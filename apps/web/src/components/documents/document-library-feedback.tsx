'use client';

import { ConfirmDialog } from '@quiz/ui';
import type { DocumentLibrary } from './use-document-library';

/** The delete confirmation and the live region of a document library (rows ask, this confirms). */
export function DocumentLibraryFeedback({ library }: { readonly library: DocumentLibrary }) {
  return (
    <>
      <p role="status" className="qz-visually-hidden">
        {library.announcement}
      </p>
      <ConfirmDialog
        open={library.pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) library.cancelDelete();
        }}
        title="문서를 삭제할까요?"
        description={
          library.pendingDelete
            ? `‘${library.pendingDelete.title}’ 문서가 목록과 검색에서 사라집니다. 이 작업은 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        loading={library.deleting}
        onConfirm={() => void library.confirmDelete()}
      />
    </>
  );
}
