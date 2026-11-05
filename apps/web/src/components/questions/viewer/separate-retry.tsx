'use client';

import { Button, FloatingSidePanel } from '@quiz/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createMockPracticeApi } from '@/components/questions/mock-exams/mock-exam-client';
import {
  selfGradePracticeAction,
  submitPracticeAction,
  type PracticeSession,
  type SubmitResult,
} from '@/lib/questions/practice-actions';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import {
  practiceResetVersion,
  subscribePracticeResets,
} from '@/lib/questions/practice-reset-events';
import {
  canSubmit,
  EMPTY_ANSWER,
  submitBody,
  type GradeResult,
  type PracticeAnswer,
} from './practice-model';
import { SelfGradeButtons } from './practice-viewer';
import { QuestionBody } from './question-body';

export function SeparateRetry({
  workspaceId,
  questionId,
  source,
  runId,
  position,
  resetEpoch,
  onClose,
  onGraded,
}: {
  readonly workspaceId: string;
  readonly questionId: string;
  readonly source: 'bank' | 'mock';
  readonly runId: string;
  readonly position: number;
  readonly resetEpoch: number | null;
  readonly onClose: () => void;
  readonly onGraded?: (questionId: string, result: SubmitResult['result']) => void;
}) {
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [answer, setAnswer] = useState<PracticeAnswer>(EMPTY_ANSWER);
  const [outcome, setOutcome] = useState<SubmitResult | null>(null);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useId();
  const key = useRef(crypto.randomUUID());
  const current = useRef(true);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (source !== 'bank') return;
    return subscribePracticeResets(workspaceId, (resetQuestionId) => {
      if (resetQuestionId.toLowerCase() !== questionId.toLowerCase()) return;
      current.current = false;
      setSession(null);
      setOutcome(null);
      setAnswer(EMPTY_ANSWER);
      setGrade(null);
      setError(null);
      closeRef.current();
    });
  }, [workspaceId, questionId, source]);
  useEffect(() => {
    current.current = true;
    let active = true;
    const version = practiceResetVersion(workspaceId, questionId);
    void (async () => {
      const result = await createPracticeRunApi(workspaceId).openRetrySession(
        runId,
        position,
        key.current,
        resetEpoch,
      );
      if (!active || !current.current || practiceResetVersion(workspaceId, questionId) !== version)
        return;
      if (result.ok) setSession(result.data);
      else setError(result.message);
    })().catch(() => {
      if (active && current.current) setError('문제를 불러오지 못했습니다.');
    });
    return () => {
      active = false;
      current.current = false;
    };
  }, [workspaceId, questionId, source, runId, position, resetEpoch]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || busy || outcome || !canSubmit(session, answer)) return;
    const version = practiceResetVersion(workspaceId, questionId);
    setBusy(true);
    setError(null);
    try {
      const result =
        source === 'mock'
          ? await createMockPracticeApi(workspaceId).submit(session.id, submitBody(session, answer))
          : await submitPracticeAction(workspaceId, session.id, submitBody(session, answer));
      if (!current.current || practiceResetVersion(workspaceId, questionId) !== version) return;
      if (result.ok) {
        setOutcome(result.data);
        if (source === 'bank') onGraded?.(questionId, result.data.result);
      } else setError(result.message);
    } catch {
      if (current.current) setError('제출하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  async function selfGrade(value: GradeResult) {
    if (!session || busy) return;
    const version = practiceResetVersion(workspaceId, questionId);
    setBusy(true);
    setError(null);
    try {
      const result =
        source === 'mock'
          ? await createMockPracticeApi(workspaceId).selfGrade(session.id, value)
          : await selfGradePracticeAction(workspaceId, session.id, value);
      if (!current.current || practiceResetVersion(workspaceId, questionId) !== version) return;
      if (result.ok) {
        setGrade(value);
        if (source === 'bank') onGraded?.(questionId, value);
      } else setError(result.message);
    } catch {
      if (current.current) setError('채점하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  return (
    <FloatingSidePanel
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="문제 다시 풀기"
      modal
      footer={
        session && !outcome ? (
          <Button
            type="submit"
            form={form}
            disabled={!canSubmit(session, answer) || busy}
            loading={busy}
          >
            제출
          </Button>
        ) : outcome?.result === 'pending' && !grade ? (
          <SelfGradeButtons busy={busy} onGrade={(value) => void selfGrade(value)} />
        ) : null
      }
    >
      {error ? <p role="alert">{error}</p> : null}
      {!session && !error ? <p role="status">문제를 불러오는 중입니다.</p> : null}
      {session ? (
        <form id={form} onSubmit={(event) => void submit(event)}>
          <QuestionBody
            kind="answer"
            stem={session.stem}
            question={session}
            answer={answer}
            disabled={busy || !!outcome}
            onAnswerChange={setAnswer}
            outcome={outcome}
            selfGrade={grade}
          />
        </form>
      ) : null}
    </FloatingSidePanel>
  );
}
