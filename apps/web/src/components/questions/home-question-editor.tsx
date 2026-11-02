'use client';

// UX7-BANK: the question editor on the workspace home (QOV-01-AC12 문제 등록, QPLAY-01-AC07 문제
// 편집). The same QuestionEditor the retired QBANK-01 page used; its chapter picker and source
// documents are read when it opens (questionEditorContextAction), not with the home render.
import { useEffect, useState } from 'react';
import { questionEditorContextAction, type QuestionEditorContext } from '@/lib/questions/actions';
import type { Question } from '@/lib/questions/form';
import { QuestionEditor, type EditorTarget } from './question-editor';

const EMPTY: QuestionEditorContext = { chapters: [], documents: [] };

export function HomeQuestionEditor({
  workspaceId,
  target,
  session,
  onClose,
  onSaved,
}: {
  readonly workspaceId: string;
  /** Null while closed. */
  readonly target: EditorTarget | null;
  /** Incremented by the opener on every opening. */
  readonly session: number;
  readonly onClose: () => void;
  readonly onSaved?: (question: Question, mode: 'create' | 'edit') => void;
}) {
  // Re-read on every opening (a book may have become ready meanwhile); the last one shows until then.
  const [context, setContext] = useState<QuestionEditorContext>(EMPTY);
  const open = target !== null;
  useEffect(() => {
    if (!open) return;
    let live = true;
    questionEditorContextAction(workspaceId).then(
      (value) => {
        if (live) setContext(value);
      },
      () => undefined, // The editor still works without chapters or source documents.
    );
    return () => {
      live = false;
    };
  }, [open, session, workspaceId]);

  return (
    <QuestionEditor
      workspaceId={workspaceId}
      target={target}
      session={session}
      onClose={onClose}
      chapters={context.chapters}
      documents={context.documents}
      onSaved={(question, mode) => onSaved?.(question, mode)}
    />
  );
}
