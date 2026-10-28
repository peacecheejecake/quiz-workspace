'use client';

// DOC-01 "문서 관리" dialog body (docs/screens/documents-library.md, UX3c, UX6-UPLOAD): the dashed
// Dropzone (editors only; several PDFs at once, no type choice — the server classifies each; its
// "PDF 업로드" button is the keyboard/touch path and the one upload place of the workspace), every
// PDF with its kind badge, live status, `종류 변경` (editors) and the question actions (문제 검토 /
// 문제 추출), and the empty/failure states. The state itself lives in the home
// (useDocumentLibrary) so closing the dialog never aborts an upload.
import { Button, Dropzone, EmptyState } from '@quiz/ui';
import type { ReactNode } from 'react';
import { useQuestionRowActions } from '@/components/questions/import/question-row-actions';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { PDF_CONTENT_TYPE } from '@/lib/documents/validation';
import { DocumentRowItem } from './document-row';
import styles from './documents.module.css';
import type { DocumentLibrary } from './use-document-library';

export const PDF_ACCEPT = `.pdf,${PDF_CONTENT_TYPE}`;

export interface DocumentsLibraryProps {
  readonly workspaceId: string;
  readonly library: DocumentLibrary;
  /** Editor+ in an active workspace; otherwise the library is read-only. */
  readonly canEdit: boolean;
  /** Why the library is read-only (shown as a note), when it is. */
  readonly readOnlyReason?: string;
}

export function DocumentsLibrary({
  workspaceId,
  library,
  canEdit,
  readOnlyReason,
}: DocumentsLibraryProps) {
  const questions = useQuestionRowActions(workspaceId, library, canEdit);
  return (
    <div className={styles.library}>
      {readOnlyReason ? (
        <p role="note" className={styles.note}>
          {readOnlyReason}
        </p>
      ) : null}
      {canEdit ? (
        <Dropzone
          title="PDF 파일을 여기에 끌어다 놓으세요"
          description="PDF 여러 개를 함께 올릴 수 있습니다. 교재·문제지는 자동으로 나누고 문제가 있으면 추출합니다. 파일마다 최대 50MB."
          buttonLabel="PDF 업로드"
          accept={PDF_ACCEPT}
          multiple
          onFiles={library.addFiles}
          onReject={library.rejectFiles}
        />
      ) : null}
      {library.alert ? (
        <p role="alert" className={styles.alert}>
          {library.alert}
        </p>
      ) : null}
      {questions.startFailure ? (
        <p role="alert" className={styles.alert}>
          {questions.startFailure}
        </p>
      ) : null}
      <DocumentRows
        label="문서 목록"
        rows={library.rows}
        workspaceId={workspaceId}
        library={library}
        canEdit={canEdit}
        emptyText="아직 문서가 없습니다"
        rowActions={questions.rowActions}
        kindMenu
      />
    </div>
  );
}

/** A labelled document list (book or question PDFs) with its failure and empty states. */
export function DocumentRows({
  label,
  rows,
  workspaceId,
  library,
  canEdit,
  emptyText,
  rowActions,
  kindMenu = false,
}: {
  readonly label: string;
  readonly rows: readonly DocumentRow[];
  readonly workspaceId: string;
  readonly library: DocumentLibrary;
  readonly canEdit: boolean;
  readonly emptyText: string;
  /** Extra per-row actions (문제 추출 / 문제 검토). */
  readonly rowActions?: (row: DocumentRow) => ReactNode;
  /** Offer editors `종류 변경` on ready rows (문서 관리). */
  readonly kindMenu?: boolean;
}) {
  return (
    <>
      {library.listFailed ? (
        <div role="alert" className={styles.alert}>
          <p>문서 목록을 불러오지 못했습니다.</p>
          <Button size="sm" onClick={() => void library.refresh()}>
            목록 새로고침
          </Button>
        </div>
      ) : null}
      {rows.length === 0 && !library.listFailed ? (
        <EmptyState headingLevel={3} title={emptyText} className={styles.empty} />
      ) : rows.length > 0 ? (
        <ul aria-label={label} className={styles.list}>
          {rows.map((row) => (
            <DocumentRowItem
              key={row.key}
              row={row}
              workspaceId={workspaceId}
              canEdit={canEdit}
              onCancel={library.cancel}
              onRetry={library.retry}
              onDelete={library.requestDelete}
              actions={rowActions?.(row)}
              kindChange={
                kindMenu && canEdit && row.documentId
                  ? {
                      onChange: (target, kind) => void library.changeKind(target, kind),
                      busy: library.changingKind === row.documentId,
                      failure: library.kindFailures[row.documentId],
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
