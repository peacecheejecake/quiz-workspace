'use client';

// UX12-CHAPTERRUN (docs/screens/ux12-chapter-run.md): a Heatmap chapter's `풀기`. No range step: the
// dialog asks only for the two options, then creates a bank run of the whole chapter and hands it
// to the home, which opens the usual run panel (`?practice=<run>&i=1`). Nothing is created before
// `시작`, and while the request runs the dialog stays open, so a closed dialog never leaves a run.
import { Button, Checkbox, ModalDialog } from '@quiz/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import { RUN_FAILURE_MESSAGES, type RunActionResult } from '@/lib/questions/practice-run-problems';
import type { PracticeRun } from '@/lib/questions/practice-runs';
import styles from './chapter-run-dialog.module.css';

export interface ChapterRunTarget {
  /** A chapter id, or the Heatmap's `none` group (the API's `none` chapter reference). */
  readonly id: string;
  readonly title: string;
}

export interface ChapterRunDialogProps {
  readonly workspaceId: string;
  /** null: closed. */
  readonly target: ChapterRunTarget | null;
  readonly container?: HTMLElement | null;
  readonly onClose: () => void;
  readonly onStarted: (runId: string) => void;
}

export function ChapterRunDialog({
  workspaceId,
  target,
  container,
  onClose,
  onStarted,
}: ChapterRunDialogProps) {
  const [api] = useState(() => createPracticeRunApi(workspaceId));
  // Each opening starts over: both options off. The title stays while the dialog animates closed.
  const [seen, setSeen] = useState(target);
  const [shown, setShown] = useState(target);
  const [shuffle, setShuffle] = useState(false);
  const [random, setRandom] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (target !== seen) {
    setSeen(target);
    if (target) {
      setShown(target);
      setShuffle(false);
      setRandom(false);
      setStarting(false);
      setError(null);
    }
  }

  // A retry of the same payload keeps its key: a failure may be a lost response (QVIEW-01-C01).
  const requestKey = useRef<{ readonly payload: string; readonly key: string } | null>(null);
  const started = useRef(false);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = target !== null;
    return () => {
      live.current = false;
    };
  }, [target]);

  async function start() {
    if (!target || starting) return;
    const payload = JSON.stringify([target.id, shuffle, random]);
    const key = requestKey.current?.payload === payload ? requestKey.current.key : newKey();
    requestKey.current = { payload, key };
    setStarting(true);
    setError(null);
    let result: RunActionResult<PracticeRun>;
    try {
      result = await api.create({ chapter_ids: [target.id] }, random, key, null, shuffle);
    } catch {
      result = { ok: false, kind: 'unavailable', message: RUN_FAILURE_MESSAGES.unavailable };
    }
    if (!live.current) return;
    setStarting(false);
    if (result.ok) {
      requestKey.current = null;
      started.current = true;
      onStarted(result.data.id);
    } else {
      setError(result.message);
    }
  }

  return (
    <ModalDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !starting) onClose();
      }}
      title={`${shown?.title ?? ''} 풀기`}
      description="이 챕터의 확정 문제를 모두 풉니다."
      size="sm"
      {...(container ? { container } : {})}
      onCloseAutoFocus={(event) => {
        // The run panel takes focus; a cancel returns it to the chapter's `풀기`.
        if (started.current) event.preventDefault();
        started.current = false;
      }}
      footer={
        <>
          <Button disabled={starting} onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" loading={starting} onClick={() => void start()}>
            시작
          </Button>
        </>
      }
    >
      <div className={styles.options}>
        <Checkbox
          label="보기 섞기"
          checked={shuffle}
          onCheckedChange={(checked) => setShuffle(checked === true)}
        />
        <Checkbox
          label="문제 순서 무작위"
          checked={random}
          onCheckedChange={(checked) => setRandom(checked === true)}
        />
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function newKey(): string {
  return crypto.randomUUID();
}
