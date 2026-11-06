'use client';

// `새 챕터` of a question's chapter dropdown (UX12-CHAPTERADD): the server places the chapter by the
// one chosen now. A retry of the same name keeps its Idempotency-Key, so it adds one chapter.
import type { ChapterCreateResult } from '@quiz/ui';
import { useCallback, useMemo, useRef } from 'react';
import { CHAPTER_FAILURE_MESSAGES, createChapterApi } from '@/lib/chapters/tree';
import { chapterGroupId, type PickableChapter } from '@/lib/questions/chapter-picker';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';

export type CreatedChapter = PickableChapter;

export type ChapterCreator = (
  title: string,
  nearChapterId: string | null,
) => Promise<ChapterCreateResult>;

export function useChapterCreator(
  workspaceId: string,
  onCreated: (chapter: CreatedChapter) => void,
): ChapterCreator {
  const api = useMemo(() => createChapterApi(workspaceId), [workspaceId]);
  const pending = useRef<{ readonly fingerprint: string; readonly key: string } | null>(null);
  return useCallback(
    async (title, nearChapterId) => {
      const fingerprint = JSON.stringify([title, nearChapterId]);
      if (pending.current?.fingerprint !== fingerprint) {
        pending.current = { fingerprint, key: newIdempotencyKey() };
      }
      const result = await api.createNear(nearChapterId, title, pending.current.key);
      if (!result.ok) return { error: CHAPTER_FAILURE_MESSAGES[result.kind] };
      pending.current = null;
      const { chapter, document_id: documentId, document_title: documentTitle } = result.data;
      onCreated({
        id: chapter.id,
        title: chapter.title,
        level: chapter.level,
        documentId: chapterGroupId(documentId),
        documentTitle,
      });
      return { value: chapter.id };
    },
    [api, onCreated],
  );
}
