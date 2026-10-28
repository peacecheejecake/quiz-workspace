'use client';

// QIMPORT-01-AC05 "문제 PDF 관리" dialog (UX3c, UX4, UX6-UPLOAD): the workspace's PDFs with
// questions — a 문제지 or 교재+문제, or any PDF with an extraction — with their kind badge (a plain
// 교재 lives in 문서 관리 only). Nothing is uploaded here since UX6-UPLOAD: 문서 관리 is the one
// upload place (the server classifies each PDF and extracts the ones with questions), so instead of
// a Dropzone the dialog says so and offers editors "문서 관리 열기". The same dialog opens from the
// home's 문제 › PDF 관리 and from the question bank's "PDF 가져오기" (QBANK-01-AC06).
//
// QIMPORT-01-AC06: a processed PDF with an extraction offers "문제 검토" (its import page); one
// without (processed before the server started them, or a low-confidence 교재+문제) offers editors
// "문제 추출", which starts it and opens the import page for review.
import { Button, ConfirmDialog, FloatingSidePanel } from '@quiz/ui';
import { DocumentRows } from '@/components/documents/documents-library';
import docStyles from '@/components/documents/documents.module.css';
import { hasQuestions } from '@/components/documents/labels';
import type { DocumentLibrary } from '@/components/documents/use-document-library';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { useQuestionRowActions } from './question-row-actions';

export { questionPdfAction } from './question-row-actions';

export const NO_QUESTION_PDFS = '등록된 문제 pdf가 없습니다.';
export const UPLOAD_IN_DOCUMENTS =
  'PDF는 문서 관리에서 올립니다. 문제가 있는 PDF는 자동으로 추출됩니다.';

/** The rows of PDFs with questions (UX6-UPLOAD): 문제지, 교재+문제, or extracted. */
export function questionPdfRows(rows: readonly DocumentRow[]): DocumentRow[] {
  return rows.filter(hasQuestions);
}

export interface QuestionPdfsLibraryProps {
  readonly workspaceId: string;
  readonly library: DocumentLibrary;
  readonly canEdit: boolean;
  /** Opens the "문서 관리" dialog (the home) or goes to it (the bank). */
  readonly onOpenDocuments: () => void;
}

export function QuestionPdfsLibrary({
  workspaceId,
  library,
  canEdit,
  onOpenDocuments,
}: QuestionPdfsLibraryProps) {
  const rows = questionPdfRows(library.rows);
  const questions = useQuestionRowActions(workspaceId, library, canEdit);
  return (
    <div className={docStyles.library}>
      {canEdit ? (
        <div className={docStyles.uploadNote}>
          <p className={docStyles.note}>{UPLOAD_IN_DOCUMENTS}</p>
          <Button size="sm" onClick={onOpenDocuments}>
            문서 관리 열기
          </Button>
        </div>
      ) : null}
      {questions.startFailure ? (
        <p role="alert" className={docStyles.alert}>
          {questions.startFailure}
        </p>
      ) : null}
      <DocumentRows
        label="문제 PDF 목록"
        rows={rows}
        workspaceId={workspaceId}
        library={library}
        canEdit={canEdit}
        emptyText={NO_QUESTION_PDFS}
        rowActions={questions.rowActions}
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
