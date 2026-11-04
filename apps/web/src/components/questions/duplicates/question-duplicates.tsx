'use client';

// UX7-DEDUP 중복 문제 정리 (docs/screens/questions-overview.md "중복 문제 정리 dialog",
// QOV-01-AC16/AC17; rules docs/questions.md §10): the body of the home's floating dialog
// (`?panel=question-duplicates`, editors of an active workspace only — the home does not render
// it otherwise and FastAPI refuses everyone else). It scans the workspace's confirmed questions
// when it opens and lists the groups of identical questions: per group a `이 묶음 정리` checkbox
// and a radio group choosing the question to keep (the oldest by default). `선택한 묶음 정리 (k)`
// asks once, then the server archives the others and merges their study history into the kept
// question; the action revalidates the home, so the heatmap follows, and the list is scanned
// again. Nothing here shows answers: the scan has none. The merge goes in requests within the
// API's limits (mergeBatches, Codex P2); if one fails, the rest of the plan (same keeps) stays
// and `이어서 정리` resumes it — every request is idempotent — or `다시 검사` starts over.
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  RadioGroup,
  useToast,
  useUnsavedChanges,
} from '@quiz/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { mergeDuplicatesAction, scanDuplicatesAction } from '@/lib/questions/actions';
import {
  archivedCount,
  duplicateQuestionName,
  initialChoices,
  mergeBatches,
  mergeRequest,
  type Choices,
  type DuplicateGroup,
  type DuplicateQuestion,
  type MergeGroup,
} from '@/lib/questions/duplicates';
import { QUESTION_TYPE_LABELS } from '@/lib/questions/form';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import { NO_CHAPTER_TITLE } from '../labels';
import styles from './question-duplicates.module.css';

/** A merge that stopped part-way: what is left (in order) and what was archived before. */
interface Resume {
  readonly batches: readonly (readonly MergeGroup[])[];
  readonly archived: number;
  readonly message: string;
}

/** Shown with the group choices while a stopped merge waits: its saved plan would ignore edits. */
const FROZEN_REASON = '이어서 정리하거나 다시 검사한 뒤 바꿀 수 있습니다';

type ScanState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly groups: readonly DuplicateGroup[] };

const DATE = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' });

function registered(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? `${DATE.format(time)} 등록` : '';
}

function optionLabel(question: DuplicateQuestion): string {
  return `${duplicateQuestionName(question)} · ${QUESTION_TYPE_LABELS[question.question_type]} · ${
    question.chapter_title ?? NO_CHAPTER_TITLE
  } · ${registered(question.created_at)}`;
}

function QuestionContent({ question }: { readonly question: DuplicateQuestion }) {
  return (
    <span className={styles.content}>
      <span className={styles.stem}>{question.stem}</span>
      {question.options.length > 0 ? (
        <span className={styles.options}>
          {question.options.map((o) => (
            <span key={o.id} className={styles.option}>
              {o.text}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function Group({
  group,
  index,
  keep,
  include,
  disabled,
  frozen,
  onKeep,
  onInclude,
}: {
  readonly group: DuplicateGroup;
  readonly index: number;
  readonly keep: string;
  readonly include: boolean;
  readonly disabled: boolean;
  /** Why the choices cannot change now (a merge awaits 이어서 정리), or null. */
  readonly frozen: string | null;
  readonly onKeep: (questionId: string) => void;
  readonly onInclude: (on: boolean) => void;
}) {
  const headingId = useId();
  const title = `중복 묶음 ${index + 1}`;
  return (
    <section role="group" aria-labelledby={headingId} className={styles.group}>
      <div className={styles.groupHeader}>
        <h3 id={headingId} className={styles.groupTitle}>
          {title} · 문제 {group.questions.length}개
        </h3>
        <Checkbox
          label="이 묶음 정리"
          checked={include}
          disabled={disabled || frozen !== null}
          {...(frozen ? { description: frozen } : {})}
          onCheckedChange={(checked) => onInclude(checked === true)}
        />
      </div>
      {group.answers_differ ? (
        <p className={styles.warning}>
          <Badge tone="warning">확인</Badge> 정답이 서로 다릅니다 — 남길 문제를 확인하세요
        </p>
      ) : null}
      <RadioGroup
        label={`${title} 남길 문제`}
        orientation="vertical"
        value={keep}
        onValueChange={onKeep}
        disabled={disabled || frozen !== null || !include}
        {...(frozen ? { description: frozen } : {})}
        options={group.questions.map((q) => ({
          value: q.question_id,
          label: optionLabel(q),
          description: <QuestionContent question={q} />,
        }))}
      />
    </section>
  );
}

export function QuestionDuplicates({
  workspaceId,
  onMerged,
}: {
  readonly workspaceId: string;
  /** After a merge: the home's other question lists (보관·초안 문제) re-read. */
  readonly onMerged?: () => void;
}) {
  const { toast } = useToast();
  const [scan, setScan] = useState<ScanState>({ status: 'loading' });
  const [choices, setChoices] = useState<Choices>(new Map());
  const [reload, setReload] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [resume, setResume] = useState<Resume | null>(null);
  const generation = useRef(0);
  const mergeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const requested = ++generation.current;
    scanDuplicatesAction(workspaceId).then(
      (result) => {
        if (requested !== generation.current) return;
        if (!result.ok) {
          setScan({ status: 'error', message: result.message });
          return;
        }
        setChoices(initialChoices(result.data.groups));
        setScan({ status: 'ready', groups: result.data.groups });
      },
      () => {
        if (requested === generation.current) {
          setScan({ status: 'error', message: QUESTION_FAILURE_MESSAGES.unavailable });
        }
      },
    );
  }, [workspaceId, reload]);

  function rescan() {
    setResume(null);
    setScan({ status: 'loading' });
    setReload((n) => n + 1);
  }

  const groups = scan.status === 'ready' ? scan.groups : [];
  const count = archivedCount(groups, choices);
  // HOMEDLG-01: a changed 남길 문제 or 정리 choice is unsaved input (the backdrop keeps it).
  useUnsavedChanges(
    groups.some((g) => {
      const choice = choices.get(g.fingerprint);
      return (
        choice !== undefined && (choice.keep !== g.suggested_keep_question_id || !choice.include)
      );
    }),
  );

  function choose(group: DuplicateGroup, patch: { keep?: string; include?: boolean }) {
    setChoices((prev) => {
      const next = new Map(prev);
      const current = prev.get(group.fingerprint) ?? {
        keep: group.suggested_keep_question_id,
        include: true,
      };
      next.set(group.fingerprint, { ...current, ...patch });
      return next;
    });
  }

  /** Sends `batches` in order; stops at the first failure and keeps the rest for 이어서 정리. */
  async function run(batches: readonly (readonly MergeGroup[])[], before: number) {
    if (batches.length === 0 || merging) return;
    setMerging(true);
    let archived = before;
    try {
      for (const [index, batch] of batches.entries()) {
        let message: string | null = null;
        try {
          const result = await mergeDuplicatesAction(workspaceId, [...batch]);
          if (result.ok) {
            // A resent batch answers already_merged for what an earlier try archived.
            archived += result.data.groups.reduce(
              (n, g) => n + g.archived_question_ids.length + g.already_merged_question_ids.length,
              0,
            );
          } else {
            message = result.message;
          }
        } catch {
          message = QUESTION_FAILURE_MESSAGES.unavailable;
        }
        if (message !== null) {
          setConfirming(false);
          if (archived > before) onMerged?.();
          setResume({ batches: batches.slice(index), archived, message });
          return;
        }
      }
      setConfirming(false);
      toast({ tone: 'success', title: `중복 문제 ${archived}개를 보관했습니다.` });
      onMerged?.();
      rescan();
    } finally {
      setMerging(false);
    }
  }

  function merge() {
    void run(mergeBatches(mergeRequest(groups, choices)), 0);
  }

  const busy = scan.status === 'loading';
  return (
    <div className={styles.body} aria-busy={busy || undefined}>
      {scan.status === 'loading' ? (
        <p className={styles.status} role="status">
          중복 문제를 찾는 중입니다.
        </p>
      ) : scan.status === 'error' ? (
        <div role="alert" className={styles.alert}>
          <p>중복 문제를 찾지 못했습니다. {scan.message}</p>
          <Button onClick={rescan}>다시 시도</Button>
        </div>
      ) : null}
      {resume ? (
        <div role="alert" className={styles.alert}>
          <p>
            {resume.archived > 0 ? `중복 문제 ${resume.archived}개를 보관했습니다. ` : ''}
            남은 문제는 정리하지 못했습니다. {resume.message}
          </p>
          <div className={styles.actions}>
            <Button onClick={rescan} disabled={merging}>
              다시 검사
            </Button>
            <Button
              variant="primary"
              loading={merging}
              onClick={() => void run(resume.batches, resume.archived)}
            >
              이어서 정리
            </Button>
          </div>
        </div>
      ) : null}
      {scan.status !== 'ready' ? null : groups.length === 0 ? (
        <EmptyState
          headingLevel={3}
          title="중복 문제가 없습니다"
          description="발문과 보기가 같은 확정 문제가 없습니다. 보기 순서·번호·띄어쓰기·문장부호만 다른 문제도 같은 문제로 찾습니다."
        />
      ) : (
        <>
          <p className={styles.intro}>
            묶음마다 남길 문제를 고르세요. 나머지는 보관되고 풀이 기록은 남길 문제에 합쳐집니다.
          </p>
          <p className="qz-visually-hidden" role="status">
            중복 묶음 {groups.length}개
          </p>
          <div className={styles.groups}>
            {groups.map((group, index) => {
              const choice = choices.get(group.fingerprint);
              return (
                <Group
                  key={group.fingerprint}
                  group={group}
                  index={index}
                  keep={choice?.keep ?? group.suggested_keep_question_id}
                  include={choice?.include ?? true}
                  disabled={merging}
                  frozen={resume ? FROZEN_REASON : null}
                  onKeep={(keep) => choose(group, { keep })}
                  onInclude={(include) => choose(group, { include })}
                />
              );
            })}
          </div>
          <div className={styles.actions}>
            <Button
              ref={mergeButton}
              variant="primary"
              disabled={count === 0 || merging || resume !== null}
              onClick={() => setConfirming(true)}
            >
              선택한 묶음 정리 ({count})
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !merging) setConfirming(false);
        }}
        title={`중복 문제 ${count}개를 보관할까요?`}
        description="남길 문제에 풀이 기록이 합쳐집니다. 보관·초안 문제에서 보관 해제하면 되돌릴 수 있습니다."
        confirmLabel="보관"
        onConfirm={merge}
        loading={merging}
        returnFocusRef={mergeButton}
      />
    </div>
  );
}
