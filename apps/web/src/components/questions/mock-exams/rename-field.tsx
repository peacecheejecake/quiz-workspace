'use client';

// MOCK-01 이름 바꾸기: the inline name field of a list row and of the detail header (Enter saves,
// Escape cancels, 1–100 characters; the same name may repeat in a workspace).
import { Button, Input } from '@quiz/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TITLE_MAX } from './mock-exam-model';
import styles from './mock-exams.module.css';

export function RenameField({
  initial,
  onSave,
  onCancel,
}: {
  readonly initial: string;
  /** Saves the name; returns why it failed, or null. */
  readonly onSave: (title: string) => Promise<string | null>;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const title = value.trim();
    if (title === '') {
      setError('이름을 입력하세요.');
      return;
    }
    if (title.length > TITLE_MAX) {
      setError(`이름은 ${TITLE_MAX}자까지 쓸 수 있습니다.`);
      return;
    }
    if (title === initial) {
      onCancel();
      return;
    }
    setSaving(true);
    const failed = await onSave(title);
    setSaving(false);
    if (failed) setError(failed);
  }

  return (
    <form className={styles.renameForm} onSubmit={submit} noValidate>
      <Input
        ref={input}
        label="모의고사 이름"
        hideLabel
        value={value}
        maxLength={TITLE_MAX}
        error={error ?? undefined}
        disabled={saving}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button size="sm" type="submit" loading={saving}>
        저장
      </Button>
      <Button size="sm" type="button" onClick={onCancel} disabled={saving}>
        취소
      </Button>
    </form>
  );
}
