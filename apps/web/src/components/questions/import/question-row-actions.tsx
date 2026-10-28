'use client';

// The question actions of a PDF row (QIMP-AUTO; UX6-UPLOAD: in 문서 관리 as well as 문제 PDF 관리).
// A ready PDF with an extraction (the list's `latest_import_id`, read for every listed PDF) links
// "문제 검토" to its import page for every member; a ready 문제지 / 교재+문제 without one offers
// editors "문제 추출", which starts it and opens that page. A plain 교재 without an extraction,
// and any row still processing or failed, gets neither.
import { Button } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { DocumentLibrary } from '@/components/documents/use-document-library';
import type { DocumentRow } from '@/lib/documents/upload-machine';
import { createImportClient, ImportApiError, importPath } from '@/lib/questions/import-client';

export function questionPdfAction(
  row: Pick<DocumentRow, 'documentId' | 'status' | 'kind' | 'latestImportId'>,
  canEdit: boolean,
): 'review' | 'extract' | null {
  if (!row.documentId || row.status !== 'ready' || row.latestImportId === undefined) return null;
  if (row.latestImportId) return 'review';
  if (row.kind !== 'question_paper' && row.kind !== 'mixed') return null;
  return canEdit ? 'extract' : null;
}

export interface QuestionRowActions {
  readonly rowActions: (row: DocumentRow) => ReactNode;
  /** Why the last 문제 추출 could not start (an alert in the dialog), or null. */
  readonly startFailure: string | null;
}

export function useQuestionRowActions(
  workspaceId: string,
  library: DocumentLibrary,
  canEdit: boolean,
): QuestionRowActions {
  const router = useRouter();
  const client = useMemo(() => createImportClient(), []);
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
      void library.refresh();
    } finally {
      setStarting(null);
    }
  }

  function rowActions(row: DocumentRow) {
    const documentId = row.documentId;
    const action = questionPdfAction(row, canEdit);
    if (!documentId || action === null) return null;
    if (action === 'review') {
      return (
        <Button size="sm" asChild>
          <Link href={importPath(workspaceId, documentId)} aria-label={`${row.title} 문제 검토`}>
            문제 검토
          </Link>
        </Button>
      );
    }
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

  return { rowActions, startFailure };
}
