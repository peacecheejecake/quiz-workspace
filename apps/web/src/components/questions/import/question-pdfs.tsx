'use client';

// QIMPORT-01-AC05 "문제 PDF 관리" dialog (UX3c, UX4): the workspace's question PDFs only (book
// documents live in 문서 관리) and a dashed Dropzone whose "PDF 선택" button (or a dropped PDF)
// hands the file to the import page, which starts uploading it on arrival (the extraction review
// stays a page). No separate "PDF 가져오기" button since UX4. Editors only for the Dropzone;
// everyone sees the list. The same dialog opens from the home's 문제 › PDF 관리 and from the
// question bank's "PDF 가져오기" (QBANK-01-AC06), each with its own document library state.
import { ConfirmDialog, Dropzone, FloatingSidePanel } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { DocumentRows, PDF_ACCEPT } from '@/components/documents/documents-library';
import docStyles from '@/components/documents/documents.module.css';
import type { DocumentLibrary } from '@/components/documents/use-document-library';
import { importPath } from '@/lib/questions/import-client';
import { setPendingImportFile } from '@/lib/questions/import-handoff';
import type { DocumentRow } from '@/lib/documents/upload-machine';

export const NO_QUESTION_PDFS = '등록된 문제 pdf가 없습니다.';

export function questionPaperRows(rows: readonly DocumentRow[]): DocumentRow[] {
  return rows.filter((row) => row.documentType === 'question_paper');
}

export interface QuestionPdfsLibraryProps {
  readonly workspaceId: string;
  readonly library: DocumentLibrary;
  readonly canEdit: boolean;
}

export function QuestionPdfsLibrary({ workspaceId, library, canEdit }: QuestionPdfsLibraryProps) {
  const router = useRouter();
  const rows = questionPaperRows(library.rows);
  return (
    <div className={docStyles.library}>
      {canEdit ? (
        <Dropzone
          title="문제 PDF를 여기에 끌어다 놓으세요"
          description="놓은 PDF로 문제 가져오기를 시작합니다. 최대 50MB."
          buttonLabel="PDF 선택"
          accept={PDF_ACCEPT}
          onFiles={(files) => {
            const [file] = files;
            if (!file) return;
            setPendingImportFile(workspaceId, file);
            router.push(importPath(workspaceId));
          }}
          onReject={library.rejectFiles}
        />
      ) : null}
      {library.alert ? (
        <p role="alert" className={docStyles.alert}>
          {library.alert}
        </p>
      ) : null}
      <DocumentRows
        label="문제 PDF 목록"
        rows={rows}
        workspaceId={workspaceId}
        library={library}
        canEdit={canEdit}
        emptyText={NO_QUESTION_PDFS}
      />
    </div>
  );
}

export interface QuestionPdfsDialogProps extends QuestionPdfsLibraryProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Raises the (non-modal) dialog above others when it changes (FloatingSidePanel). */
  readonly raiseKey?: number;
  /** Where the dialog is portalled (the home keeps it inside its main landmark). */
  readonly container?: HTMLElement | null;
}

/** The non-modal "문제 PDF 관리" floating dialog. */
export function QuestionPdfsDialog({
  open,
  onOpenChange,
  raiseKey,
  container,
  ...library
}: QuestionPdfsDialogProps) {
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={onOpenChange}
      raiseKey={raiseKey}
      modal={false}
      container={container}
      title="문제 PDF 관리"
      closeLabel="문제 PDF 관리 닫기"
      mobileLayout="full"
    >
      <QuestionPdfsLibrary {...library} />
    </FloatingSidePanel>
  );
}

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
