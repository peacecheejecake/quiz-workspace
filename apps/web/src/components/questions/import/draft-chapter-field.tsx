'use client';

// The chapter an import draft is registered under (CHAPTER-MAP, QIMPORT-01-AC08): the server's
// suggestion (the question's chapter in the question PDF matched to a book chapter by title) or
// the reviewer's choice, with why. Editors change it with a picker over the workspace's book
// chapters ("챕터 없음" allowed); the change is saved at once (PATCH chapter_id) and kept for the
// registration. Read-only users (and registered drafts) see the text only.
//
// Every draft has one, and a real import has hundreds of drafts over a book outline of hundreds
// of chapters: `ChapterPicker` renders the tree only while open, and all drafts share one `nodes`
// array (QIMP-REVIEW-SCALE: a closed Radix Select with every option took the review page to >3 GB).
import { ChapterPicker, type ChapterCreateResult, type ChapterPickerNode } from '@quiz/ui';
import {
  chapterHint,
  NO_DRAFT_CHAPTER,
  type BookChapterOption,
  type DraftChapterInfo,
} from '@/lib/questions/drafts';
import styles from './question-import.module.css';

export interface DraftChapterFieldProps {
  /** "N" of "N번 문제" (names the picker). */
  readonly number: number;
  readonly info: DraftChapterInfo;
  readonly options: readonly BookChapterOption[];
  /** `options` as the tree (shared by every draft). */
  readonly nodes: readonly ChapterPickerNode[];
  readonly readOnly: boolean;
  readonly disabled?: boolean;
  readonly onChange: (chapterId: string | null) => void;
  /** `새 챕터`, near the chapter chosen now (editors only: `readOnly` hides the picker). */
  readonly onCreate: (title: string, nearChapterId: string | null) => Promise<ChapterCreateResult>;
}

export function DraftChapterField({
  number,
  info,
  options,
  nodes,
  readOnly,
  disabled = false,
  onChange,
  onCreate,
}: DraftChapterFieldProps) {
  const hint = chapterHint(info, options.length);
  if (readOnly) {
    return (
      <p className={styles.chapterText}>
        <span className={styles.chapterLabel}>챕터</span> {info.chapter?.title ?? '챕터 없음'}
        {hint ? <span className={styles.chapterHint}> · {hint}</span> : null}
      </p>
    );
  }
  const leading = [{ value: NO_DRAFT_CHAPTER, label: '챕터 없음' }];
  if (info.chapter && !options.some((o) => o.id === info.chapter?.id)) {
    leading.push({ value: info.chapter.id, label: info.chapter.title });
  }
  return (
    <div className={styles.chapterField}>
      <ChapterPicker
        label={`${number}번 문제 챕터`}
        leading={leading}
        nodes={nodes}
        value={info.chapter?.id ?? NO_DRAFT_CHAPTER}
        disabled={disabled}
        onValueChange={(value) => onChange(value === NO_DRAFT_CHAPTER ? null : value)}
        onCreate={(title) => onCreate(title, info.chapter?.id ?? null)}
        {...(hint ? { description: hint } : {})}
      />
    </div>
  );
}
