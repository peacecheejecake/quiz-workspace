'use client';

// `ForkWorkspaceDialog` (WS-FORK-01, docs/screens/workspace-fork.md, docs/workspace-sharing.md
// §3–§6): the Radix modal a signed-in viewer of a Fork-ON link gets at `/share/{id}?panel=fork`.
//
// It explains what is copied (published documents, questions, answers, explanations), that the
// copy is an independent workspace, that nobody's progress is copied, and copyright; asks for the
// new name; starts the fork through the same-origin relay (202 + job id) with an Idempotency-Key
// that is reused for a resend of the same name (lost response, double submit); then polls
// `/api/me/forks/{id}` until the fork is COMPLETED (link to the new workspace), FAILED (alert +
// retry) or CANCELLED (e.g. the link was revoked mid-copy). The fork state lives in this
// component, outside the dialog content, so closing the dialog while a copy runs does not lose it.
// The API stays the authorization boundary: hiding this dialog is never the only check.
import { Button, DialogClose, Input, ModalDialog } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { workspaceHref } from '@/components/workspaces/labels';
import {
  createForkClient,
  forkEndMessage,
  forkFailureMessage,
  ForkRequestError,
  isTerminal,
  pollDelay,
  suggestedForkName,
  validateForkName,
  type Fork,
  type ForkClient,
} from '@/lib/shared/fork';
import { keyForAttempt, type PendingCreate } from '@/lib/workspaces/idempotency';
import styles from './fork-dialog.module.css';

export interface ForkWorkspaceDialogProps {
  readonly shareId: string;
  readonly screenId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Name of the shared workspace (the suggested name of the copy). */
  readonly sourceName: string;
  /** Injected in unit tests. */
  readonly client?: ForkClient;
}

type Phase =
  | { readonly status: 'form'; readonly error: string | null; readonly submitting: boolean }
  | { readonly status: 'tracking'; readonly fork: Fork; readonly pollError: string | null };

const FORM: Phase = { status: 'form', error: null, submitting: false };
/** Consecutive failed status polls after which the dialog says it keeps trying. */
const POLL_WARN_AFTER = 3;

export function ForkWorkspaceDialog({
  shareId,
  screenId,
  open,
  onOpenChange,
  sourceName,
  client: injected,
}: ForkWorkspaceDialogProps) {
  const client = useMemo(() => injected ?? createForkClient(shareId), [injected, shareId]);
  const [name, setName] = useState(() => suggestedForkName(sourceName));
  const [nameError, setNameError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(FORM);
  const [wasOpen, setWasOpen] = useState(open);
  const pendingKey = useRef<PendingCreate | null>(null);
  const inputId = useId();

  // Reopening after a finished fork starts over with the form (a running fork keeps its state).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && phase.status === 'tracking' && isTerminal(phase.fork.status)) {
      setPhase(FORM);
      setNameError(null);
    }
  }

  const trackedId = phase.status === 'tracking' ? phase.fork.id : null;
  const running = phase.status === 'tracking' && !isTerminal(phase.fork.status);

  useEffect(() => {
    if (!running || trackedId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let failures = 0;
    const poll = async () => {
      try {
        const fork = await client.get(trackedId, controller.signal);
        failures = 0;
        if (isTerminal(fork.status)) pendingKey.current = null;
        setPhase({ status: 'tracking', fork, pollError: null });
        if (isTerminal(fork.status)) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        failures += 1;
        if (error instanceof ForkRequestError && error.kind === 'unauthenticated') {
          setPhase((p) =>
            p.status === 'tracking' ? { ...p, pollError: forkFailureMessage(error) } : p,
          );
          return;
        }
        if (failures >= POLL_WARN_AFTER) {
          setPhase((p) =>
            p.status === 'tracking'
              ? { ...p, pollError: '진행 상태를 확인하지 못했습니다. 계속 확인하고 있습니다…' }
              : p,
          );
        }
      }
      timer = setTimeout(() => void poll(), pollDelay(polls++));
    };
    timer = setTimeout(() => void poll(), pollDelay(polls++));
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, running, trackedId]);

  async function start(rawName: string) {
    const checked = validateForkName(rawName);
    if ('error' in checked) {
      setNameError(checked.error);
      document.getElementById(inputId)?.focus();
      return;
    }
    setNameError(null);
    pendingKey.current = keyForAttempt(pendingKey.current, checked.name);
    const key = pendingKey.current.key;
    setPhase({ status: 'form', error: null, submitting: true });
    try {
      const fork = await client.start(checked.name, key);
      if (isTerminal(fork.status)) pendingKey.current = null;
      setPhase({ status: 'tracking', fork, pollError: null });
    } catch (error) {
      if (error instanceof ForkRequestError && error.kind === 'keyReused') {
        pendingKey.current = null;
      }
      if (error instanceof ForkRequestError && error.kind === 'invalidName') {
        setNameError(forkFailureMessage(error));
      }
      setPhase({ status: 'form', error: forkFailureMessage(error), submitting: false });
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.status === 'form' && phase.submitting) return;
    void start(name);
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Workspace Fork"
      description="공유된 Workspace를 내 계정의 새 Workspace로 복제합니다."
      onOpenAutoFocus={(event) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        event.preventDefault();
        input.focus();
      }}
    >
      <div className={styles.body} data-screen-id={screenId}>
        {phase.status === 'form' ? (
          <>
            <ul className={styles.facts}>
              <li>발행된 문서(PDF·본문)와 확정된 문제·정답·해설이 복제됩니다.</li>
              <li>
                복제본은 내가 소유하는 독립된 Workspace입니다. 이후 원본이 바뀌거나 삭제되어도
                영향을 받지 않고, 원본과 동기화되지 않습니다.
              </li>
              <li>
                원본 소유자의 풀이·즐겨찾기·다시 풀기 표시와 초안, 공유 링크는 복제되지 않습니다.
              </li>
              <li>
                저작권 주의: 복제한 자료는 개인 학습 목적으로만 사용하고, 저작권자의 허락 없이 다시
                배포하지 마세요.
              </li>
            </ul>
            <form className={styles.form} onSubmit={onSubmit} noValidate>
              <Input
                id={inputId}
                label="새 Workspace 이름"
                value={name}
                maxLength={400}
                autoComplete="off"
                error={nameError ?? undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
              />
              {phase.error ? (
                <div className={styles.alert} role="alert">
                  <p>{phase.error}</p>
                </div>
              ) : null}
              <div className={styles.actions}>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    취소
                  </Button>
                </DialogClose>
                <Button type="submit" variant="primary" disabled={phase.submitting}>
                  Fork 시작
                </Button>
              </div>
              {phase.submitting ? (
                <p className={styles.note} role="status">
                  Fork를 요청하고 있습니다…
                </p>
              ) : null}
            </form>
          </>
        ) : (
          <ForkProgress
            fork={phase.fork}
            pollError={phase.pollError}
            onRetry={() => {
              pendingKey.current = null;
              void start(phase.fork.name);
            }}
          />
        )}
      </div>
    </ModalDialog>
  );
}

function ForkProgress({
  fork,
  pollError,
  onRetry,
}: {
  readonly fork: Fork;
  readonly pollError: string | null;
  readonly onRetry: () => void;
}) {
  if (fork.status === 'COMPLETED' && fork.target_workspace_id) {
    return (
      <div className={styles.result} role="status">
        <p className={styles.resultTitle}>Fork 완료</p>
        <p className={styles.note}>
          새 Workspace가 만들어졌습니다:{' '}
          <Link href={workspaceHref(fork.target_workspace_id)} className="qz-focus-ring">
            {fork.name}
          </Link>
        </p>
      </div>
    );
  }
  if (fork.status === 'FAILED') {
    return (
      <div className={styles.alert} role="alert">
        <p className={styles.resultTitle}>Fork 실패</p>
        <p>{forkEndMessage(fork)}</p>
        <div className={styles.actions}>
          <Button size="sm" variant="primary" onClick={onRetry}>
            다시 시도
          </Button>
        </div>
      </div>
    );
  }
  if (fork.status === 'CANCELLED') {
    return (
      <div className={styles.alert} role="alert">
        <p className={styles.resultTitle}>Fork 취소됨</p>
        <p>{forkEndMessage(fork)}</p>
      </div>
    );
  }
  const pending = fork.status === 'PENDING';
  const label = pending ? 'Fork를 곧 시작합니다' : 'Workspace를 복사하고 있습니다';
  return (
    <div className={styles.progressBox}>
      <p className={styles.note} role="status">
        {pending ? `${label}…` : `${label} (${fork.progress}%)`}
      </p>
      <div
        role="progressbar"
        aria-label="Fork 진행률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pending ? undefined : fork.progress}
        aria-valuetext={pending ? label : `${label} ${fork.progress}%`}
        className={styles.progress}
        data-indeterminate={pending || undefined}
      >
        <div
          className={styles.progressFill}
          style={pending ? undefined : { width: `${fork.progress}%` }}
        />
      </div>
      <p className={styles.note}>
        창을 닫아도 복제는 계속됩니다. 완료되면 내 Workspace 목록에 나타납니다.
      </p>
      {pollError ? (
        <p className={styles.note} role="alert">
          {pollError}
        </p>
      ) : null}
    </div>
  );
}
