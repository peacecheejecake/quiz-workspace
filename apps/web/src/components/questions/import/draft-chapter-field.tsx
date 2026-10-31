'use client';

// The chapter an import draft is registered under (CHAPTER-MAP, QIMPORT-01-AC08): the server's
// suggestion (the question's chapter in the question PDF matched to a book chapter by title) or
// the reviewer's choice, with why. Editors change it with a picker over the workspace's book
// chapters ("챕터 없음" allowed); the change is saved at once (PATCH chapter_id) and kept for the
// registration. Read-only users (and registered drafts) see the text only.
//
// Every draft has one, and a real import has hundreds of drafts over a book outline of hundreds
// of chapters: the picker renders its options only while open (`lazyOptions`, QIMP-REVIEW-SCALE —
// a closed Radix Select renders all of them, which took the review page to >3 GB and crashed it).
import { Select } from '@quiz/ui';
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
  readonly readOnly: boolean;
  readonly disabled?: boolean;
  readonly onChange: (chapterId: string | null) => void;
}

function optionLabel(option: BookChapterOption, withDocument: boolean): string {
  const indent = option.level > 1 ? '  '.repeat(option.level - 1) : '';
  return withDocument
    ? `${indent}${option.title} (${option.document_title})`
    : `${indent}${option.title}`;
}

export function DraftChapterField({
  number,
  info,
  options,
  readOnly,
  disabled = false,
  onChange,
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
  const multiDocs = new Set(options.map((o) => o.document_id)).size > 1;
  const choices = [
    { value: NO_DRAFT_CHAPTER, label: '챕터 없음' },
    ...options.map((o) => ({
      value: o.id,
      label: optionLabel(o, multiDocs),
      textValue: o.title,
    })),
  ];
  if (info.chapter && !options.some((o) => o.id === info.chapter?.id)) {
    choices.push({
      value: info.chapter.id,
      label: info.chapter.title,
      textValue: info.chapter.title,
    });
  }
  return (
    <div className={styles.chapterField}>
      <Select
        label={`${number}번 문제 챕터`}
        options={choices}
        value={info.chapter?.id ?? NO_DRAFT_CHAPTER}
        lazyOptions
        disabled={disabled}
        onValueChange={(value) => onChange(value === NO_DRAFT_CHAPTER ? null : value)}
        {...(hint ? { description: hint } : {})}
      />
    </div>
  );
}
