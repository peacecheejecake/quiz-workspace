'use client';

// QGEN-01 문제 변형 출제 (docs/screens/questions-generation.md, docs/questions.md §5).
//
//   원본 문제 (?source=) → QuestionGenerationForm →
//     보기 섞기: the original's practice panel (QPLAY-01) in a shuffled order — the session stores
//                the displayed order; no run, no draft, no new question or dot.
//     문구 변형 / 정오 반전 / 유사 개념: POST /questions/{id}/generations (Idempotency-Key) → job →
//                drafts, each with VariationDiffViewer (diff vs the source revision, justification,
//                cited pages, validation state) → review (편집 / 원본 비교 / 승인) → "승인한 문제
//                등록" registers exactly the approved versions as new CONFIRMED questions with
//                lineage (the API decides; the LLM's declared answer is never trusted).
import { Badge, Button, CheckIcon, PageHeader, Select, useToast } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import { watchJob } from '@/lib/documents/job-events';
import {
  applyPublished,
  confirmTypeBody,
  generationDraftUpdateBody,
  publishedMessage,
  publishInBatches,
  publishSelection,
  replaceDraft,
  reviewBody,
  reviewDraftFromImport,
  sortDrafts,
  type DraftUpdateBody,
  type ImportDraft,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import {
  QUESTION_TYPE_LABELS,
  type QuestionDetail,
  type QuestionFormValues,
} from '@/lib/questions/form';
import {
  createGenerationClient,
  GenerationApiError,
  generatePath,
  isRunWorking,
  runFailureMessage,
  type GenerationCreate,
  type GenerationRun,
} from '@/lib/questions/generation-client';
import type { SourceRevision } from '@/lib/questions/generation-data';
import {
  bodyKey,
  RUN_HISTORY_LIMIT,
  runLabel,
  upsertRun,
  VARIATION_LABELS,
} from '@/lib/questions/generation-model';
import { getQuestionRevisionAction } from '@/lib/questions/actions';
import { placedTitle } from '@/lib/questions/overview-placement';
import { lookupOverviewQuestionAction, setMyStateAction } from '@/lib/questions/practice-actions';
import { DraftEditor, type DraftSaveResult } from '../drafts/draft-editor';
import { formatDateTime } from '../labels';
import { QuestionDraftReview, type DraftReviewState } from '../drafts/question-draft-review';
import { PracticePanel, type PracticeQuestion } from '../practice/practice-panel';
import { GenerationComparePanel } from './generation-compare-panel';
import { QuestionGenerationForm } from './question-generation-form';
import { VariationDiffViewer, type VariationOriginal } from './variation-diff-viewer';
import styles from './question-generation.module.css';

export type GenerationReadOnly = 'viewer' | 'archived' | null;

export interface QuestionGenerationProps {
  readonly workspaceId: string;
  readonly readOnly: GenerationReadOnly;
  readonly source: QuestionDetail;
  /** Recent runs of the source, newest first. */
  readonly initialRuns: readonly GenerationRun[];
  readonly initialRun: GenerationRun | null;
  /** The source revision `initialRun` was generated from, when it is not the current one. */
  readonly initialRunRevision: SourceRevision | null;
  readonly initialDrafts: readonly ImportDraft[];
  readonly loadFailed: boolean;
}

const READ_ONLY_TEXT: Readonly<Record<Exclude<GenerationReadOnly, null>, string>> = {
  viewer:
    '읽기 전용: 보기 권한으로는 변형 초안을 만들거나 승인할 수 없습니다. 보기 섞기로 풀어 볼 수는 있습니다.',
  archived: '읽기 전용: 보관된 Workspace에서는 변형 문제를 만들거나 풀 수 없습니다.',
};

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof GenerationApiError ? error.message : fallback;
}

function originalOf(revision: SourceRevision): VariationOriginal {
  const correct = new Set(revision.correct_option_ids ?? []);
  return {
    stem: revision.stem,
    options: revision.options.map((o) => ({ id: o.id, text: o.text, correct: correct.has(o.id) })),
  };
}

function failureOf(run: GenerationRun | null) {
  return run && (run.status === 'failed' || run.status === 'cancelled')
    ? { message: runFailureMessage(run.error_code ?? run.status), retry: null }
    : null;
}

export function QuestionGeneration({
  workspaceId,
  readOnly,
  source,
  initialRuns,
  initialRun,
  initialRunRevision,
  initialDrafts,
  loadFailed,
}: QuestionGenerationProps) {
  const router = useRouter();
  const { toast } = useToast();
  const client = useMemo(() => createGenerationClient(), []);
  const canEdit = readOnly === null;
  const revision = source.revision;

  const [runs, setRuns] = useState<GenerationRun[]>(() => [...initialRuns]);
  const [run, setRunState] = useState<GenerationRun | null>(initialRun);
  /**
   * The run the screen shows. Every async draft/run update checks it after its await, so a
   * response that arrives after the reviewer switched runs never lands in another run's list
   * (and a later publish never sends one run's drafts against another).
   */
  const shownRun = useRef<string | null>(initialRun?.id ?? null);
  const setRun = useCallback((next: GenerationRun | null) => {
    shownRun.current = next?.id ?? null;
    setRunState(next);
  }, []);
  const isShown = (runId: string) => shownRun.current === runId;
  /** Source revisions by id: the current one and those runs were generated from. */
  const [revisions, setRevisions] = useState<Record<string, SourceRevision>>(() => ({
    [revision.id]: revision,
    ...(initialRunRevision ? { [initialRunRevision.id]: initialRunRevision } : {}),
  }));
  const [revisionFailed, setRevisionFailed] = useState<string | null>(null);
  // Diffs compare with the revision the run was generated from (pinned on the run), never with
  // whatever the source says now.
  const pinnedId = run?.source_question_revision_id ?? revision.id;
  const pinned = revisions[pinnedId] ?? null;
  const original = useMemo<VariationOriginal | null>(
    () => (pinned ? originalOf(pinned) : null),
    [pinned],
  );
  const [drafts, setDrafts] = useState<ReviewDraft[]>(() =>
    sortDrafts(initialDrafts.map(reviewDraftFromImport)),
  );
  const [listFailed, setListFailed] = useState(loadFailed);
  const [working, setWorking] = useState<'starting' | 'generating' | null>(() =>
    initialRun && isRunWorking(initialRun) ? 'generating' : null,
  );
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [failure, setFailure] = useState<{
    message: string;
    retry: GenerationCreate | null;
  } | null>(() => failureOf(initialRun));
  const [states, setStates] = useState<Record<string, DraftReviewState>>({});
  const [publishing, setPublishing] = useState(false);
  const [publishFailure, setPublishFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; bank: boolean } | null>(null);
  const [editing, setEditing] = useState<ReviewDraft | null>(null);
  const [editorSession, setEditorSession] = useState(0);
  const [comparing, setComparing] = useState<ReviewDraft | null>(null);
  const [practice, setPractice] = useState<PracticeQuestion | null>(null);
  const [opening, setOpening] = useState(false);
  const [shuffleError, setShuffleError] = useState<string | null>(null);
  const [reloadingList, setReloadingList] = useState(false);

  const controller = useRef<AbortController | null>(null);
  /** Idempotency-Key of a start that has not succeeded yet, per request body. */
  const startKeys = useRef(new Map<string, string>());
  const publishRound = useRef(new Set<string>());

  const onUnauthenticated = useCallback(
    (error: unknown) => {
      if (error instanceof GenerationApiError && error.kind === 'unauthenticated') {
        router.replace(loginRedirectPath(generatePath(workspaceId, source.id)));
        return true;
      }
      return false;
    },
    [router, workspaceId, source.id],
  );

  const newController = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return next;
  }, []);

  const refreshDrafts = useCallback(
    async (runId: string, signal?: AbortSignal) => {
      try {
        const items = await client.listDrafts(runId, signal);
        if (shownRun.current !== runId) return false;
        setDrafts(sortDrafts(items.map(reviewDraftFromImport)));
        setListFailed(false);
        return true;
      } catch (error) {
        if (signal?.aborted || shownRun.current !== runId) return false;
        if (!onUnauthenticated(error)) setListFailed(true);
        return false;
      }
    },
    [client, onUnauthenticated],
  );

  /** Follows the run's job to its end, then loads the run and its drafts. */
  const followRun = useCallback(
    async (current: GenerationRun, signal: AbortSignal) => {
      setRun(current);
      setFailure(null);
      setWorking('generating');
      setProgress(undefined);
      if (current.job_id && isRunWorking(current)) {
        try {
          await watchJob(current.job_id, {
            signal,
            onJob: (job) => {
              const p = job.progress;
              setProgress(
                typeof p === 'number' && Number.isFinite(p)
                  ? Math.max(0, Math.min(100, p))
                  : undefined,
              );
            },
          });
        } catch (error) {
          if (isAbort(error, signal)) return;
          // Lost the job stream (deleted, network): the run below tells what happened.
        }
      }
      let latest = current;
      try {
        latest = await client.getRun(current.id, signal);
      } catch (error) {
        if (isAbort(error, signal)) return;
        onUnauthenticated(error);
      }
      setRuns((list) => upsertRun(list, latest));
      if (shownRun.current !== current.id) return;
      setRun(latest);
      await refreshDrafts(latest.id, signal);
      if (signal.aborted || shownRun.current !== latest.id) return;
      setWorking(null);
      if (latest.status === 'succeeded') {
        setStatus({
          text: `변형 초안 ${latest.draft_count}개를 만들었습니다. 원본과 비교해 검토하고 승인한 초안만 문제은행에 등록됩니다.`,
          bank: false,
        });
      } else if (latest.status === 'failed' || latest.status === 'cancelled') {
        setFailure({ message: runFailureMessage(latest.error_code ?? latest.status), retry: null });
      } else {
        setFailure({
          message: '생성 상태를 확인하지 못했습니다. 목록을 새로 불러와 주세요.',
          retry: null,
        });
        setListFailed(true);
      }
    },
    [client, onUnauthenticated, refreshDrafts, setRun],
  );

  async function startGeneration(body: GenerationCreate) {
    if (!canEdit || working || publishing) return;
    const { signal } = newController();
    const keyOf = bodyKey(body);
    let key = startKeys.current.get(keyOf);
    if (!key) {
      key = crypto.randomUUID();
      startKeys.current.set(keyOf, key);
    }
    setFailure(null);
    setStatus(null);
    setPublishFailure(null);
    setWorking('starting');
    let started: GenerationRun;
    try {
      started = await client.startGeneration(source.id, body, key);
    } catch (error) {
      if (isAbort(error, signal) || onUnauthenticated(error)) return;
      setWorking(null);
      if (error instanceof GenerationApiError && error.kind === 'idempotencyKeyReused') {
        startKeys.current.delete(keyOf);
      }
      setFailure({
        message: `변형 생성을 시작하지 못했습니다. ${messageOf(error, '다시 시도해 주세요.')}`,
        retry: body,
      });
      return;
    }
    // The run exists: a later "생성" with the same settings is a new run.
    startKeys.current.delete(keyOf);
    setRuns((list) => upsertRun(list, started));
    showRunInUrl(started.id);
    setDrafts([]);
    setStates({});
    publishRound.current.clear();
    await followRun(started, signal);
  }

  // Resume following a run that was still working when the page loaded; stop on leave.
  useEffect(() => {
    if (initialRun && isRunWorking(initialRun)) {
      const { signal } = newController();
      void Promise.resolve().then(() => followRun(initialRun, signal));
    }
    return () => controller.current?.abort();
    // Only once for the server-rendered run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadList() {
    setReloadingList(true);
    try {
      let list: GenerationRun[];
      try {
        list = await client.listRuns(workspaceId, source.id, RUN_HISTORY_LIMIT);
      } catch (error) {
        onUnauthenticated(error);
        return;
      }
      setRuns(list);
      const latest = list.find((r) => r.id === run?.id) ?? list[0] ?? null;
      setRun(latest);
      setFailure(failureOf(latest));
      if (!latest) {
        setDrafts([]);
        setListFailed(false);
        return;
      }
      if (isRunWorking(latest)) {
        setListFailed(false);
        void followRun(latest, newController().signal);
        return;
      }
      await refreshDrafts(latest.id);
    } finally {
      setReloadingList(false);
    }
  }

  function showRunInUrl(runId: string) {
    // The selected run is part of the URL (reload / share), without a server round trip.
    window.history.replaceState(null, '', generatePath(workspaceId, source.id, runId));
  }

  /** Shows an earlier (or the newest) run: its drafts, review state and failure. */
  async function selectRun(runId: string) {
    const next = runs.find((r) => r.id === runId);
    // Not while a publish (and its refresh) is in flight: it belongs to the run on screen.
    if (!next || next.id === run?.id || working || publishing) return;
    const { signal } = newController();
    showRunInUrl(next.id);
    setRun(next);
    setDrafts([]);
    setStates({});
    setStatus(null);
    setPublishFailure(null);
    setFailure(failureOf(next));
    publishRound.current.clear();
    if (isRunWorking(next)) {
      void followRun(next, signal);
      return;
    }
    await refreshDrafts(next.id, signal);
  }

  /** Loads the source revision the selected run was generated from (when not loaded yet). */
  const loadRevision = useCallback(
    async (revisionId: string) => {
      setRevisionFailed(null);
      let result: Awaited<ReturnType<typeof getQuestionRevisionAction>>;
      try {
        result = await getQuestionRevisionAction(workspaceId, source.id, revisionId);
      } catch {
        setRevisionFailed(revisionId);
        return;
      }
      if (result.ok) setRevisions((r) => ({ ...r, [revisionId]: result.data }));
      else setRevisionFailed(revisionId);
    },
    [workspaceId, source.id],
  );

  useEffect(() => {
    if (pinned || revisionFailed === pinnedId) return;
    void Promise.resolve().then(() => loadRevision(pinnedId));
  }, [pinned, pinnedId, revisionFailed, loadRevision]);

  /** Re-reads the run (counts) after a publish, so the history shows what is left. */
  async function refreshRun(runId: string) {
    try {
      const latest = await client.getRun(runId);
      setRuns((list) => upsertRun(list, latest));
      if (shownRun.current === latest.id) setRun(latest);
    } catch {
      // Counts in the history stay as they were; the drafts themselves are up to date.
    }
  }

  // --- 보기 섞기 ------------------------------------------------------------------------------

  async function openShuffled() {
    setShuffleError(null);
    setOpening(true);
    try {
      const found = await lookupOverviewQuestionAction(workspaceId, source.id);
      if (!found.ok) {
        setShuffleError(found.message);
        return;
      }
      if (!found.data) {
        setShuffleError('확정된 문제만 풀 수 있습니다.');
        return;
      }
      const placed = found.data;
      setPractice({
        id: placed.item.question_id,
        title: placedTitle(placed),
        chapterTitle: placed.chapterTitle,
        questionType: placed.item.question_type,
        preview: placed.item.preview,
        isFavorite: placed.item.is_favorite,
        needsRetry: placed.item.needs_retry,
      });
    } catch {
      setShuffleError('문제를 열지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setOpening(false);
    }
  }

  async function changeFlags(
    questionId: string,
    flags: { is_favorite?: boolean; needs_retry?: boolean },
  ) {
    setPractice((p) => (p && p.id === questionId ? { ...p, savingFlags: true } : p));
    let result: Awaited<ReturnType<typeof setMyStateAction>>;
    try {
      result = await setMyStateAction(workspaceId, questionId, flags);
    } catch {
      result = {
        ok: false,
        kind: 'unavailable',
        message: '저장하지 못했습니다. 다시 시도해 주세요.',
      };
    }
    setPractice((p) => {
      if (!p || p.id !== questionId) return p;
      return result.ok
        ? {
            ...p,
            isFavorite: result.data.is_favorite,
            needsRetry: result.data.needs_retry,
            savingFlags: false,
          }
        : { ...p, savingFlags: false };
    });
    if (!result.ok) toast({ tone: 'error', title: result.message });
  }

  // --- review -------------------------------------------------------------------------------

  async function patchDraft(draft: ReviewDraft, body: DraftUpdateBody, fallback: string) {
    const runId = shownRun.current;
    if (!runId) return;
    try {
      const updated = await client.updateDraft(draft.id, body);
      if (!isShown(runId)) return;
      setDrafts((list) => replaceDraft(list, reviewDraftFromImport(updated)));
      setStates((s) => {
        const { [draft.id]: _done, ...rest } = s;
        return rest;
      });
    } catch (error) {
      if (onUnauthenticated(error) || !isShown(runId)) return;
      setStates((s) => ({ ...s, [draft.id]: { error: messageOf(error, fallback) } }));
      if (error instanceof GenerationApiError && error.kind !== 'network') {
        void refreshDrafts(runId);
      }
    }
  }

  async function changeApproval(draft: ReviewDraft, approved: boolean) {
    setStates((s) => ({ ...s, [draft.id]: { approving: approved } }));
    setStatus(null);
    await patchDraft(
      draft,
      reviewBody(draft, approved),
      '승인 상태를 바꾸지 못했습니다. 다시 시도해 주세요.',
    );
  }

  async function confirmType(draft: ReviewDraft) {
    setStates((s) => ({ ...s, [draft.id]: { approving: false } }));
    await patchDraft(
      draft,
      confirmTypeBody(draft),
      '유형 변경을 확인하지 못했습니다. 다시 시도해 주세요.',
    );
  }

  async function saveDraft(
    values: QuestionFormValues,
    baseVersion: string,
  ): Promise<DraftSaveResult> {
    const target = editing;
    const runId = shownRun.current;
    if (!target || !runId) return { ok: false, message: '편집할 초안이 없습니다.' };
    try {
      const updated = await client.updateDraft(
        target.id,
        generationDraftUpdateBody(values, target, baseVersion),
      );
      if (!isShown(runId)) return { ok: true };
      setDrafts((list) => replaceDraft(list, reviewDraftFromImport(updated)));
      setStates((s) => {
        const { [target.id]: _done, ...rest } = s;
        return rest;
      });
      setStatus({
        text: `${updated.position + 1}번 초안을 저장했습니다. 검증 결과를 확인하고 승인해 주세요.`,
        bank: false,
      });
      return { ok: true };
    } catch (error) {
      if (onUnauthenticated(error)) return { ok: false, message: '로그인이 필요합니다.' };
      if (error instanceof GenerationApiError) {
        return { ok: false, message: error.message, stale: error.kind === 'staleDraft' };
      }
      return { ok: false, message: '초안을 저장하지 못했습니다. 다시 시도해 주세요.' };
    }
  }

  async function reloadDraft(draftId: string): Promise<ReviewDraft | null> {
    const runId = shownRun.current;
    if (!runId) return null;
    try {
      const items = (await client.listDrafts(runId)).map(reviewDraftFromImport);
      if (!isShown(runId)) return null;
      setDrafts(sortDrafts(items));
      return items.find((d) => d.id === draftId) ?? null;
    } catch (error) {
      onUnauthenticated(error);
      return null;
    }
  }

  // --- publish ------------------------------------------------------------------------------

  const selection = publishSelection(drafts);
  const approving = Object.values(states).some((s) => s.approving !== undefined);

  async function publish() {
    // The drafts on screen belong to the shown run (every draft update is scoped to it).
    if (!run || !isShown(run.id) || publishing || selection.length === 0) return;
    setPublishing(true);
    setPublishFailure(null);
    setStatus(null);
    const runId = run.id;
    const round = publishRound.current;
    // Switching runs stays disabled until the publish and its refresh are done.
    try {
      await publishInBatches(
        selection,
        (batch) => client.publish(runId, batch),
        (items) => {
          for (const item of items) round.add(item.draft_id);
          if (isShown(runId)) setDrafts((list) => applyPublished(list, items));
        },
      );
      setStatus({ text: publishedMessage(round.size), bank: true });
      round.clear();
      await Promise.all([refreshDrafts(runId), refreshRun(runId)]);
    } catch (error) {
      if (onUnauthenticated(error)) return;
      const kind = error instanceof GenerationApiError ? error.kind : 'unavailable';
      const partial = round.size > 0 ? ` 지금까지 ${round.size}개를 등록했습니다.` : '';
      setPublishFailure(
        `승인한 초안을 모두 등록하지 못했습니다.${partial} ${messageOf(error, '문제를 등록하지 못했습니다.')}`,
      );
      // A refusal (e.g. 409 duplicate-question) re-validated the drafts: show why.
      await Promise.all([
        kind !== 'network' && kind !== 'unavailable' ? refreshDrafts(runId) : null,
        round.size > 0 ? refreshRun(runId) : null,
      ]);
    } finally {
      setPublishing(false);
    }
  }

  // --- render -------------------------------------------------------------------------------

  const busy = working !== null;
  const originalPending =
    revisionFailed === pinnedId
      ? '생성 당시 원본을 불러오지 못해 비교를 보여 줄 수 없습니다.'
      : undefined;
  const registered = drafts.filter((d) => d.publishedQuestionId !== null).length;
  const docHref = (documentId: string, page: number) =>
    `/workspaces/${workspaceId}/documents/${documentId}?page=${page}`;
  const sourcePages = source.sources.flatMap((s) =>
    s.document_id && s.page_start !== null
      ? [{ documentId: s.document_id, start: s.page_start, end: s.page_end }]
      : [],
  );
  const correct = new Set(revision.correct_option_ids ?? []);

  return (
    <div className={styles.screen}>
      <PageHeader
        title="문제 변형 출제"
        description="확정된 문제를 골라 보기 섞기, 문구 변형, 정오 반전, 유사 개념 변형을 만듭니다. 만든 변형은 원본과 비교해 검토하고 승인한 초안만 새 문제로 등록됩니다."
        actions={
          <>
            <Button asChild>
              <Link href={generatePath(workspaceId)}>다른 문제 선택</Link>
            </Button>
            <Button asChild>
              <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제은행</Link>
            </Button>
          </>
        }
      />

      {readOnly ? <p className={styles.readOnly}>{READ_ONLY_TEXT[readOnly]}</p> : null}

      <section className={styles.source} aria-labelledby="qgen-source-title">
        <div className={styles.sourceHeader}>
          <h2 id="qgen-source-title" className={styles.sectionTitle}>
            원본 문제
          </h2>
          {source.question_number ? <Badge>{source.question_number}번</Badge> : null}
          <Badge>{QUESTION_TYPE_LABELS[source.question_type]}</Badge>
          {source.chapter ? <Badge>{source.chapter.title}</Badge> : null}
          {source.publication_status !== 'CONFIRMED' ? (
            <Badge tone="warning">확정되지 않은 문제</Badge>
          ) : null}
        </div>
        <p className={styles.sourceStem}>{revision.stem}</p>
        {revision.options.length > 0 ? (
          <ol className={styles.sourceOptions}>
            {revision.options.map((o) => (
              <li key={o.id} data-correct={correct.has(o.id) || undefined}>
                {o.text}
                {correct.has(o.id) ? (
                  <span className={styles.mark}>
                    <CheckIcon width={12} height={12} aria-hidden="true" />
                    정답
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {sourcePages.length > 0 ? (
          <p className={styles.sourcePages}>
            <span className={styles.noteLabel}>출처</span>
            {sourcePages.map(({ documentId, start, end }) => {
              const label = end && end !== start ? `${start}~${end}쪽` : `${start}쪽`;
              return (
                <Link
                  key={`${documentId}-${start}`}
                  href={docHref(documentId, start)}
                  className={styles.link}
                >
                  {label}
                </Link>
              );
            })}
          </p>
        ) : (
          <p className={styles.muted}>
            문서 출처가 없는 문제입니다. 유사 개념 변형은 Workspace 문서에서 관련 원문을 찾아 근거로
            씁니다.
          </p>
        )}
      </section>

      <QuestionGenerationForm
        source={{
          questionType: source.question_type,
          confirmed: source.publication_status === 'CONFIRMED',
        }}
        canGenerate={canEdit}
        canShuffle={readOnly !== 'archived'}
        busy={busy || opening || publishing}
        onShuffle={() => void openShuffled()}
        onGenerate={(body) => void startGeneration(body)}
      />

      {shuffleError ? (
        <p role="alert" className={styles.alert}>
          {shuffleError}
        </p>
      ) : null}

      {working ? (
        <div className={styles.progressBox}>
          <p className={styles.progressText}>
            {working === 'starting' ? '변형 생성 준비 중' : '변형 초안 생성 중'}
            {progress !== undefined ? <span> · {progress}%</span> : null}
          </p>
          <div
            role="progressbar"
            aria-label="생성 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-valuetext={
              progress === undefined ? '변형 초안 생성 중' : `변형 초안 생성 중 ${progress}%`
            }
            className={styles.progress}
            data-indeterminate={progress === undefined || undefined}
          >
            <div
              className={styles.progressFill}
              style={progress === undefined ? undefined : { width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      {failure ? (
        <div role="alert" className={styles.failure}>
          <p>{failure.message}</p>
          {failure.retry && canEdit ? (
            <Button size="sm" onClick={() => failure.retry && void startGeneration(failure.retry)}>
              다시 시도
            </Button>
          ) : (
            <p className={styles.muted}>설정을 확인하고 다시 생성해 주세요.</p>
          )}
        </div>
      ) : null}

      {publishFailure ? (
        <div role="alert" className={styles.failure}>
          <p>{publishFailure}</p>
          <Button size="sm" onClick={() => void publish()} loading={publishing}>
            다시 시도
          </Button>
        </div>
      ) : null}

      {listFailed ? (
        <div role="alert" className={styles.failure}>
          <p>생성된 초안을 불러오지 못했습니다.</p>
          <Button size="sm" onClick={() => void reloadList()} loading={reloadingList}>
            목록 새로고침
          </Button>
        </div>
      ) : null}

      <div role="status" className={styles.status} data-empty={status === null || undefined}>
        {status ? (
          <p>
            {status.text}{' '}
            {status.bank ? (
              <Link href={`/workspaces/${workspaceId}/questions/bank`} className={styles.link}>
                문제은행에서 보기
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {run !== null || busy ? (
        <section className={styles.drafts} aria-labelledby="qgen-drafts-title">
          <div className={styles.draftsHeader}>
            <div>
              <h2 id="qgen-drafts-title" className={styles.sectionTitle}>
                생성된 초안 <span className={styles.count}>{drafts.length}개</span>
              </h2>
              {run ? (
                <p className={styles.muted}>
                  {run.variation_types.map((t) => VARIATION_LABELS[t]).join(', ')} · 승인 대기{' '}
                  {
                    drafts.filter((d) => d.reviewStatus !== 'approved' && !d.publishedQuestionId)
                      .length
                  }
                  개 · 등록 {registered}개
                </p>
              ) : null}
            </div>
            {canEdit ? (
              <Button
                variant="primary"
                onClick={() => void publish()}
                disabled={selection.length === 0 || approving || busy}
                loading={publishing}
              >
                승인한 문제 등록 ({selection.length})
              </Button>
            ) : null}
          </div>
          {runs.length > 1 ? (
            <Select
              label="생성 기록"
              description="이전에 만든 초안도 여기서 다시 열어 검토하고 등록할 수 있습니다."
              value={run?.id ?? ''}
              disabled={busy || publishing}
              options={runs.map((r) => ({ value: r.id, label: runLabel(r, formatDateTime) }))}
              onValueChange={(value) => void selectRun(value)}
              fieldClassName={styles.historyField}
            />
          ) : null}
          {run && pinnedId !== revision.id ? (
            <p className={styles.pinnedNotice}>
              {pinned
                ? `이 초안들은 원본 문제의 이전 판(${pinned.version}판)으로 만들었습니다. 원본은 그 뒤 ${revision.version}판으로 수정되어 지금 보이는 원본 문제와 다릅니다. 아래 비교는 생성 당시 원본 기준입니다.`
                : '이 초안들은 원본 문제의 이전 판으로 만들었습니다. 지금 보이는 원본 문제와 다르며, 비교는 생성 당시 원본 기준입니다.'}
              {revisionFailed === pinnedId ? (
                <>
                  {' '}
                  <Button size="sm" onClick={() => void loadRevision(pinnedId)}>
                    생성 당시 원본 다시 불러오기
                  </Button>
                </>
              ) : null}
            </p>
          ) : null}
          {drafts.length === 0 && !busy && run?.status === 'succeeded' ? (
            <p className={styles.muted}>검증을 통과해 저장된 초안이 없습니다.</p>
          ) : null}
          <QuestionDraftReview
            label="생성된 초안"
            drafts={drafts}
            states={states}
            readOnly={!canEdit}
            onApproveChange={(draft, approved) => void changeApproval(draft, approved)}
            onEdit={(draft) => {
              setEditorSession((n) => n + 1);
              setEditing(draft);
            }}
            onCompare={setComparing}
            pageHref={(draft, page) =>
              draft.sourceDocumentId ? docHref(draft.sourceDocumentId, page) : null
            }
            renderExtra={(draft) => (
              <VariationDiffViewer
                original={original}
                {...(originalPending ? { originalPending } : {})}
                draft={draft}
                pageHref={docHref}
                actions={
                  canEdit &&
                  !draft.publishedQuestionId &&
                  draft.issues.some(
                    (i) => i.code === 'question_type_changed' && i.severity === 'error',
                  ) ? (
                    <Button
                      size="sm"
                      onClick={() => void confirmType(draft)}
                      disabled={states[draft.id]?.approving !== undefined}
                    >
                      유형 변경 확인
                    </Button>
                  ) : null
                }
              />
            )}
          />
        </section>
      ) : null}

      <DraftEditor
        draft={editing}
        session={editorSession}
        onClose={() => setEditing(null)}
        save={saveDraft}
        reload={reloadDraft}
      />
      <GenerationComparePanel
        original={original}
        {...(originalPending ? { originalPending } : {})}
        draft={comparing}
        onClose={() => setComparing(null)}
        pageHref={docHref}
      />
      <PracticePanel
        workspaceId={workspaceId}
        question={practice}
        readOnly={readOnly === 'archived'}
        screenId="QPLAY-01"
        onClose={() => setPractice(null)}
        onFlagsChange={(questionId, flags) => void changeFlags(questionId, flags)}
        onViewed={() => undefined}
      />
    </div>
  );
}
