'use client';

// QIMPORT-01-AC05 "문제 PDF 관리" dialog (UX3c, UX4): the workspace's question PDFs only (book
// documents live in 문서 관리) and a dashed Dropzone whose "PDF 선택" button (or a dropped PDF)
// hands the file to the import page, which starts uploading it on arrival (the extraction review
// stays a page). No separate "PDF 가져오기" button since UX4. Editors only for the Dropzone;
// everyone sees the list. The same dialog opens from the home's 문제 › PDF 관리 and from the
// question bank's "PDF 가져오기" (QBANK-01-AC06), each with its own document library state.
//
// QIMPORT-01-AC06: the server extracts a question PDF's questions once it is processed. A
// processed PDF whose import already exists offers "문제 검토" (its import page); one without an
// import (processed before the server started them) offers editors "문제 추출", which starts it
// and opens the import page for review.
import { Button, ConfirmDialog, Dropzone, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DocumentRows, PDF_ACCEPT } from '@/components/documents/documents-library';
import docStyles from '@/components/documents/documents.module.css';
import type { DocumentLibrary } from '@/components/documents/use-document-library';
import type { ImportRun } from '@/lib/questions/drafts';
import { createImportClient, ImportApiError, importPath } from '@/lib/questions/import-client';
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

/** The newest import run per question paper (the list API returns runs newest first). */
export function runsByDocument(runs: readonly ImportRun[]): Map<string, ImportRun> {
  const out = new Map<string, ImportRun>();
  for (const run of runs) {
    if (run.source_document_id && !out.has(run.source_document_id)) {
      out.set(run.source_document_id, run);
    }
  }
  return out;
}

/** The workspace's import runs by question paper, reloaded whenever a paper becomes ready
 * (its server-started import exists from that moment). null until loaded or after a failure. */
function useImportRuns(
  workspaceId: string,
  readyIds: string,
): [Map<string, ImportRun> | null, () => void] {
  const client = useMemo(() => createImportClient(), []);
  const [runs, setRuns] = useState<Map<string, ImportRun> | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!readyIds) return;
    const controller = new AbortController();
    client
      .listRuns(workspaceId, controller.signal)
      .then((items) => setRuns(runsByDocument(items)))
      .catch(() => {
        if (!controller.signal.aborted) setRuns(null);
      });
    return () => controller.abort();
  }, [client, workspaceId, readyIds, generation]);
  return [runs, useCallback(() => setGeneration((g) => g + 1), [])];
}

export function QuestionPdfsLibrary({ workspaceId, library, canEdit }: QuestionPdfsLibraryProps) {
  const router = useRouter();
  const client = useMemo(() => createImportClient(), []);
  const rows = questionPaperRows(library.rows);
  const readyIds = rows
    .filter((row) => row.status === 'ready' && row.documentId)
    .map((row) => row.documentId)
    .join(',');
  const [runs, reloadRuns] = useImportRuns(workspaceId, readyIds);
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<string | null>(null);

  async function extract(row: DocumentRow) {
    const documentId = row.documentId;
    if (!documentId || starting) return;
    setStarting(documentId);
    setStartFailure(null);
    try {
      await client.startImport(workspaceId, documentId, crypto.randomUUID());
      router.push(importPath(workspaceId, documentId));
    } catch (error) {
      const message = error instanceof ImportApiError ? error.message : String(error);
      setStartFailure(`‘${row.title}’ 문제 추출을 시작하지 못했습니다. ${message}`);
      reloadRuns();
    } finally {
      setStarting(null);
    }
  }

  function rowActions(row: DocumentRow) {
    const documentId = row.documentId;
    if (!documentId || row.status !== 'ready' || runs === null) return null;
    if (runs.has(documentId)) {
      return (
        <Button size="sm" asChild>
          <Link href={importPath(workspaceId, documentId)} aria-label={`${row.title} 문제 검토`}>
            문제 검토
          </Link>
        </Button>
      );
    }
    if (!canEdit) return null;
    return (
      <Button
        size="sm"
        variant="primary"
        aria-label={`${row.title} 문제 추출`}
        loading={starting === documentId}
        disabled={starting !== null && starting !== documentId}
        onClick={() => void extract(row)}
      >
        문제 추출
      </Button>
    );
  }

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
      {startFailure ? (
        <p role="alert" className={docStyles.alert}>
          {startFailure}
        </p>
      ) : null}
      <DocumentRows
        label="문제 PDF 목록"
        rows={rows}
        workspaceId={workspaceId}
        library={library}
        canEdit={canEdit}
        emptyText={NO_QUESTION_PDFS}
        rowActions={rowActions}
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
