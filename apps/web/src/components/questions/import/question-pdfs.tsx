'use client';

// QIMPORT-01-AC05 "문제 PDF 관리" dialog body (UX3c): the workspace's question PDFs only (book
// documents live in 문서 관리), a "PDF 가져오기" button to the import page and a dashed Dropzone
// whose PDF is handed to that page, which starts uploading it on arrival (the extraction review
// stays a page). Editors only for both; everyone sees the list.
import { Button, Dropzone } from '@quiz/ui';
import Link from 'next/link';
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
        <>
          <div className={docStyles.toolbar}>
            <Button asChild variant="primary">
              <Link href={importPath(workspaceId)}>PDF 가져오기</Link>
            </Button>
          </div>
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
        </>
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
