'use client';

// The AI 질문 panel's `질문 범위` filter button and popover (ASK-01 "질문 범위 popover", UX12-ASK):
// `전체 교재` (default) or one document and optionally one of its chapters — the same published-book
// list and chapter outline as the 본문 search's 본문 설정 (question papers are never offered; FastAPI
// intersects the ids with the workspace's published books anyway). The choice applies from the next
// message on.
import { FilterIcon, IconButton, Popover, PopoverContent, PopoverTrigger, Select } from '@quiz/ui';
import { useId, useState } from 'react';
import type { AskScope } from '@/lib/ask/client';
import { EMPTY_SCOPE, isEmptyScope } from '@/lib/ask/model';
import type { OutlineItem } from '@/lib/search/client';
import styles from './ask.module.css';

const ALL = '__all__';

export interface ScopeDocument {
  readonly id: string;
  readonly title: string;
}

export function AskScopePopover({
  scope,
  documents,
  chapters,
  describedBy,
  onChange,
}: {
  readonly scope: AskScope;
  readonly documents: readonly ScopeDocument[];
  /** The chosen document's chapters (null while loading or without a document). */
  readonly chapters: readonly OutlineItem[] | null;
  /** The element that names a narrowed scope. */
  readonly describedBy?: string | undefined;
  readonly onChange: (scope: AskScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const documentId = scope.document_ids[0] ?? null;
  const chapterId = scope.chapter_ids[0] ?? null;
  const narrowed = !isEmptyScope(scope);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label="질문 범위"
          icon={<FilterIcon />}
          className={styles.scopeButton}
          data-narrowed={narrowed || undefined}
          aria-describedby={describedBy}
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={16}
        aria-labelledby={titleId}
        closeLabel="질문 범위 닫기"
        className={styles.scope}
      >
        <p id={titleId} className={styles.scopeTitle}>
          질문 범위
        </p>
        <Select
          label="문서"
          options={[
            { value: ALL, label: '전체 교재' },
            ...documents.map((d) => ({ value: d.id, label: d.title, textValue: d.title })),
          ]}
          value={documentId ?? ALL}
          onValueChange={(value) => {
            if (!value) return;
            onChange(value === ALL ? EMPTY_SCOPE : { document_ids: [value], chapter_ids: [] });
          }}
        />
        <Select
          label="장"
          options={[
            { value: ALL, label: '전체 장' },
            ...(chapters ?? []).map((c) => ({ value: c.id, label: c.title, textValue: c.title })),
          ]}
          value={chapters ? (chapterId ?? ALL) : ''}
          placeholder={documentId ? '장 목록을 불러오는 중…' : '문서를 먼저 선택하세요'}
          disabled={!documentId || chapters === null}
          onValueChange={(value) => {
            if (!value || !documentId) return;
            onChange({ document_ids: [documentId], chapter_ids: value === ALL ? [] : [value] });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
