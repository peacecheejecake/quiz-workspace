'use client';

// MOCK-01 모의고사 (docs/screens/mock-exams.md): the workspace home's modal floating dialog
// (UX9, HOMEDLG-01; `?panel=mock-exams`, the DOC-01 list dialog pattern), opened from `문제 › 모의고사` by every
// member. It opens at once with a skeleton (aria-busy) and shows one of three views in place,
// each with a heading that takes focus:
//   list    "모의고사 n개" + `추가` (every member; without edit rights the form starts only a
//           variation-free run, UX12-MOCKNAV-AC05), the viewer's unfinished bank runs
//           (`이어 풀기`, UX12-RESUME), one row per mock exam (name →
//           detail, status badge in text, meta line, a "문제 생성 진행률" bar while it is made,
//           `풀기`, and the editors' row menu 이름 바꾸기 / 설정 바꾸기 / 삭제), or the empty state.
//   create  `&mock=new`: MockExamForm (옵션 → 범위) → `만들기` saves and shows the detail.
//   detail  `&mock=<id>`: MockExamDetail (progress, failure, partial, round, questions).
// The view is the URL's: list → 만들기 / 상세 pushes a history entry, so Back returns to the list
// with the dialog open (user decision 2026-11-02, QOV-01-AC14); the home owns the history.
// FastAPI decides every permission; the controls only follow the role it reported to the page.
import {
  Badge,
  BackLink,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FloatingPanelPinned,
  FloatingSidePanel,
  IconButton,
  MoreIcon,
  ProgressBar,
  Skeleton,
} from '@quiz/ui';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { withoutMockExams, type MockView } from '@/lib/workspaces/home';
import { withRunState } from '@/lib/questions/practice-runs';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import { rememberRun } from './mock-run';
import type { RunRange } from '@/lib/questions/practice-runs';
import { createMockExamApi, type MockExamApi } from './mock-exam-client';
import { MockExamDetail } from './mock-exam-detail';
import { MockExamForm, type MockExamSubmit } from './mock-exam-form';
import {
  canPractise,
  canResume,
  EMPTY_HINT,
  EMPTY_TEXT,
  generationProgress,
  isGenerating,
  isWaiting,
  metaText,
  MOCK_POLL_MS,
  NOT_FOUND_TEXT,
  newOptions,
  progressPercent,
  progressValueText,
  resumeLabel,
  STATUS_TONES,
  WAITING_TEXT,
  statusLabel,
  unfinishedRunName,
  unfinishedRunProgress,
  type MockExam,
  type MockExamList,
  type UnfinishedRun,
} from './mock-exam-model';
import { formatDateTime } from '../labels';
import { RenameField } from './rename-field';
import styles from './mock-exams.module.css';

const UNFINISHED_ERROR = '이어 풀 문제를 불러오지 못했습니다.';

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly message: string };

export interface MockExamsPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly container: HTMLElement | null;
  readonly workspaceId: string;
  /** Owner or editor of an active workspace (FastAPI re-checks every write). */
  readonly canEdit: boolean;
  readonly view: MockView;
  readonly onViewChange: (view: MockView, how: 'push' | 'replace') => void;
  /** `풀기`: the run panel on this mock exam (QuestionViewer sequence, source=mock). */
  readonly onPractise: (exam: MockExam) => void;
  readonly onBankStarted?: (runId: string) => void;
  /** `이어 풀기`: the run panel at this position, over this dialog (UX12-RESUME). */
  readonly onResume: (runId: string, position: number) => void;
  /** The run panel is open over this dialog: closing it reads the lists again. */
  readonly runOpen?: boolean;
  readonly screenId?: string;
  /** Tests and stories: the API. */
  readonly api?: MockExamApi;
}

export function bankRunLocation(pathname: string, search: string, runId: string): string {
  return `${pathname}${withRunState(withoutMockExams(search), { step: 'solve', runId, position: 1 })}`;
}

export function MockExamsPanel({
  open,
  onOpenChange,
  container,
  workspaceId,
  canEdit,
  view,
  onViewChange,
  onPractise,
  onBankStarted,
  onResume,
  runOpen = false,
  screenId,
  api: givenApi,
}: MockExamsPanelProps) {
  const api = useMemo(() => givenApi ?? createMockExamApi(workspaceId), [givenApi, workspaceId]);
  const [list, setList] = useState<Load<MockExamList>>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState<Load<readonly UnfinishedRun[]>>({
    status: 'loading',
  });
  // Not `reads`: the generation polling below has no reason to read the runs.
  const [runReads, setRunReads] = useState(0);
  // 만들기 is tied to the opening that started it (QVIEW-W key rule): a creation that answers after
  // the person left the form (closed the panel, went back to the list, opened another view or a
  // new 만들기) keeps the mock exam it made but never navigates or touches the newer form.
  const [formOpening, setFormOpening] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** The opening a creation may still show its answer in (null: not on 만들기). */
  const liveOpening = useRef<number | null>(null);
  const liveFormOpening = useRef(formOpening);
  /** Whether the panel is open on `view` now (for answers that arrive later). */
  const liveView = useRef<{ open: boolean; view: MockView }>({ open, view });
  useLayoutEffect(() => {
    liveOpening.current = open && view.view === 'create' ? formOpening : null;
    liveFormOpening.current = formOpening;
    liveView.current = { open, view };
  });
  const reload = () => setReads((n) => n + 1);

  // Read on every opening, then again while a mock exam is being made.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setList({ status: 'loading' });
      setUnfinished({ status: 'loading' });
    }
    // A new opening of the panel is a new 만들기 too (see formOpening).
    setFormOpening((n) => n + 1);
    setCreating(false);
    setCreateError(null);
  }
  // The run panel opens over this dialog, which stays open under it: its closing is what says
  // the lists moved on (a run answered, finished or started).
  const [wasRunOpen, setWasRunOpen] = useState(runOpen);
  if (runOpen !== wasRunOpen) {
    setWasRunOpen(runOpen);
    if (!runOpen) {
      setReads((n) => n + 1);
      setRunReads((n) => n + 1);
      setDetailVersion((n) => n + 1);
    }
  }
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.list().then(
      (result) => {
        if (!live) return;
        setList(
          result.ok
            ? { status: 'ready', data: result.data }
            : { status: 'error', message: result.message },
        );
      },
      () => {
        if (live) setList({ status: 'error', message: '모의고사 목록을 불러오지 못했습니다.' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, open, reads]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const failed = { status: 'error', message: UNFINISHED_ERROR } as const;
    api.unfinishedRuns().then(
      (result) => {
        if (live) setUnfinished(result.ok ? { status: 'ready', data: result.data } : failed);
      },
      () => {
        if (live) setUnfinished(failed);
      },
    );
    return () => {
      live = false;
    };
  }, [api, open, runReads]);
  const anyGenerating = list.status === 'ready' && list.data.items.some(isGenerating);
  useEffect(() => {
    if (!open || !anyGenerating || view.view !== 'list') return;
    const timer = window.setTimeout(reload, MOCK_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [open, anyGenerating, view.view, list]);

  const llmAvailable = list.status === 'ready' ? list.data.llm_available : false;
  const exams = list.status === 'ready' ? list.data.items : [];

  // Each view names itself: focus its heading when the view changes (not on the first open:
  // the panel itself takes focus so its name is announced).
  const titleRef = useRef<HTMLHeadingElement>(null);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const viewKey = view.view === 'detail' ? `detail:${view.mockExamId}` : view.view;
  const [seenKey, setSeenKey] = useState(viewKey);
  const [focusTick, setFocusTick] = useState(0);
  if (seenKey !== viewKey) {
    setSeenKey(viewKey);
    setFocusTick((n) => n + 1);
    setDismissError(null);
    // Every arrival on 만들기 is a new opening: a new form, its own creation key.
    setFormOpening((n) => n + 1);
    setCreating(false);
    setCreateError(null);
  }
  useEffect(() => {
    if (focusTick === 0 || !open) return;
    (view.view === 'detail' ? viewHeading.current : titleRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  // 설정 바꾸기 from a row menu opens the detail on its settings.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MockExam | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteReturn = useRef<HTMLElement | null>(null);

  async function runDelete() {
    const exam = confirmDelete;
    if (!exam || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await api.remove(exam.id);
    setDeleting(false);
    if (!result.ok && result.kind !== 'notFound') {
      setDeleteError(result.message);
      return;
    }
    setConfirmDelete(null);
    setList((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            data: { ...prev.data, items: prev.data.items.filter((e) => e.id !== exam.id) },
          }
        : prev,
    );
    // Only the open detail of the deleted mock exam goes back to the list (a panel closed
    // meanwhile stays closed).
    const now = liveView.current;
    if (now.open && now.view.view === 'detail' && now.view.mockExamId === exam.id) {
      deleteReturn.current = null;
      onViewChange({ view: 'list' }, 'replace');
    }
    reload();
  }

  async function dismiss(run: UnfinishedRun) {
    setDismissError(null);
    const result = await api.dismissRun(run.id);
    if (!result.ok && result.kind !== 'notFound') {
      setDismissError(result.message);
      return;
    }
    setUnfinished((prev) =>
      prev.status === 'ready'
        ? { status: 'ready', data: prev.data.filter((r) => r.id !== run.id) }
        : prev,
    );
    // The row and its menu are gone: the dialog's heading holds the focus.
    titleRef.current?.focus();
  }

  /** `이어 풀기` of a saved mock exam: the run's source is known, no read to learn it. */
  function resumeExam(exam: MockExam) {
    const run = exam.unfinished_run;
    if (!run) return;
    rememberRun({ id: run.id, source: 'mock', mock_exam_id: exam.id });
    onResume(run.id, run.next_position);
  }

  /** `이어 풀기 지우기`: an older unfinished run may take its place, so the lists read again. */
  async function dismissExamRun(exam: MockExam) {
    const run = exam.unfinished_run;
    if (!run) return;
    setDismissError(null);
    const result = await api.dismissRun(run.id);
    if (!result.ok && result.kind !== 'notFound') {
      setDismissError(result.message);
      return;
    }
    reload();
    setDetailVersion((n) => n + 1);
    (liveView.current.view.view === 'detail' ? viewHeading : titleRef).current?.focus();
  }

  async function rename(exam: MockExam, title: string): Promise<string | null> {
    const result = await api.rename(exam.id, title);
    if (!result.ok) return result.message;
    setList((prev) =>
      prev.status === 'ready'
        ? {
            status: 'ready',
            data: {
              ...prev.data,
              items: prev.data.items.map((e) => (e.id === exam.id ? result.data : e)),
            },
          }
        : prev,
    );
    setDetailVersion((n) => n + 1);
    return null;
  }

  // --- 만들기 ------------------------------------------------------------------------------------
  // One Idempotency-Key per opening and payload: a retry of the same opening reuses it (an
  // ambiguous failure may hide a saved mock exam, which the retry gets back), a new opening or
  // another payload gets a fresh one, and a confirmed success retires only its own key.
  const createKey = useRef<{ opening: number; payload: string; key: string } | null>(null);
  async function create(value: MockExamSubmit) {
    if (creating) return;
    const opening = formOpening;
    const payload = JSON.stringify(value);
    const held = createKey.current;
    const key =
      held && held.opening === opening && held.payload === payload
        ? held.key
        : (createKey.current = { opening, payload, key: crypto.randomUUID() }).key;
    setCreating(true);
    setCreateError(null);
    let result: Awaited<ReturnType<MockExamApi['create']>>;
    try {
      result = await api.create(value, key);
    } catch {
      result = {
        ok: false,
        kind: 'unavailable',
        message: '모의고사를 만들지 못했습니다. 다시 시도하세요.',
      };
    }
    if (result.ok) {
      if (createKey.current?.key === key) createKey.current = null;
      reload();
    }
    if (liveOpening.current !== opening) return;
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.message);
      return;
    }
    onViewChange({ view: 'detail', mockExamId: result.data.id }, 'replace');
  }

  const bankTransition = useRef(false);
  const panelOpener = useRef<HTMLElement | null>(null);
  const bankKey = useRef<{ payload: string; key: string } | null>(null);
  async function startBank(range: RunRange, count: number | null, random: boolean) {
    if (creating) return;
    const opening = formOpening;
    const startedView = liveView.current.view;
    const payload = JSON.stringify([opening, startedView, range, count, random]);
    const key = bankKey.current?.payload === payload ? bankKey.current.key : crypto.randomUUID();
    bankKey.current = { payload, key };
    setCreating(true);
    setCreateError(null);
    const result = await createPracticeRunApi(workspaceId).create(range, random, key, count);
    const now = liveView.current;
    if (
      !now.open ||
      JSON.stringify(now.view) !== JSON.stringify(startedView) ||
      liveFormOpening.current !== opening
    )
      return;
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.message);
      return;
    }
    bankKey.current = null;
    bankTransition.current = true;
    if (onBankStarted) onBankStarted(result.data.id);
    else
      window.location.replace(
        bankRunLocation(window.location.pathname, window.location.search, result.data.id),
      );
  }

  let body: ReactNode;
  if (view.view === 'list') {
    body = (
      <ListView
        list={list}
        unfinished={unfinished}
        dismissError={dismissError}
        canEdit={canEdit}
        renaming={renaming}
        onRetry={reload}
        onRetryRuns={() => {
          setUnfinished({ status: 'loading' });
          setRunReads((n) => n + 1);
        }}
        onResume={onResume}
        onDismiss={(run) => void dismiss(run)}
        onResumeExam={resumeExam}
        onDismissExamRun={(exam) => void dismissExamRun(exam)}
        onAdd={() => {
          setCreateError(null);
          onViewChange({ view: 'create' }, 'push');
        }}
        onOpen={(exam) => onViewChange({ view: 'detail', mockExamId: exam.id }, 'push')}
        onPractise={onPractise}
        onRename={(exam) => setRenaming(exam.id)}
        onRenamed={async (exam, title) => {
          const failed = await rename(exam, title);
          if (!failed) setRenaming(null);
          return failed;
        }}
        onRenameCancel={() => setRenaming(null)}
        onSettings={(exam) => {
          setSettingsFor(exam.id);
          onViewChange({ view: 'detail', mockExamId: exam.id }, 'push');
        }}
        onDelete={(exam, trigger) => {
          deleteReturn.current = trigger;
          setDeleteError(null);
          setConfirmDelete(exam);
        }}
      />
    );
  } else if (view.view === 'create') {
    body =
      list.status === 'loading' ? (
        <Loading />
      ) : list.status === 'error' ? (
        // The environment's AI availability comes with the list: without it, read it again.
        <div role="alert" className={styles.alert}>
          <p>{list.message}</p>
          <Button onClick={reload}>다시 시도</Button>
        </div>
      ) : (
        <MockExamForm
          key={formOpening}
          workspaceId={workspaceId}
          mode="create"
          initial={newOptions(exams.length, llmAvailable)}
          llmAvailable={llmAvailable}
          busy={creating}
          error={createError}
          onSubmit={(value) => void create(value)}
          onBankSubmit={(range, count, random) => void startBank(range, count, random)}
          canCreateMock={canEdit}
        />
      );
  } else if (view.view === 'detail') {
    body = (
      <MockExamDetail
        key={view.mockExamId}
        workspaceId={workspaceId}
        mockExamId={view.mockExamId}
        api={api}
        canEdit={canEdit}
        llmAvailable={llmAvailable}
        headingRef={viewHeading}
        refreshKey={detailVersion}
        openSettings={settingsFor === view.mockExamId}
        onSettingsShown={() => setSettingsFor(null)}
        onPractise={onPractise}
        onResume={resumeExam}
        onDismissRun={(exam) => void dismissExamRun(exam)}
        dismissError={dismissError}
        onBankSubmit={(range, count, random) => void startBank(range, count, random)}
        bankBusy={creating}
        bankError={createError}
        onRename={rename}
        onDelete={(exam, trigger) => {
          deleteReturn.current = trigger;
          setDeleteError(null);
          setConfirmDelete(exam);
        }}
        onChanged={reload}
      />
    );
  } else {
    body = <p className={styles.text}>{NOT_FOUND_TEXT}</p>;
  }

  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={onOpenChange}
      container={container}
      title="모의고사"
      onOpenerResolved={(opener) => {
        panelOpener.current = opener;
      }}
      onCloseAutoFocus={(event) => {
        if (bankTransition.current) {
          bankTransition.current = false;
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent('quiz:bank-run-transition', { detail: panelOpener.current }),
          );
        }
      }}
      titleRef={titleRef}
      closeLabel="모의고사 닫기"
      mobileLayout="full"
    >
      <div className={styles.body} data-screen-id={screenId}>
        {view.view !== 'list' ? (
          // Mounted before the form's steps in the same fixed area, so it stays above them.
          <FloatingPanelPinned>
            <BackLink
              label="모의고사 목록"
              onClick={() => onViewChange({ view: 'list' }, 'push')}
            />
          </FloatingPanelPinned>
        ) : null}
        {body}
      </div>
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next && !deleting) setConfirmDelete(null);
        }}
        title={confirmDelete ? `‘${confirmDelete.title}’을 삭제할까요?` : '삭제할까요?'}
        description={
          <>
            문제와 내 풀이 기록이 목록에서 사라집니다.
            {confirmDelete && isGenerating(confirmDelete) ? ' 만들고 있는 문제도 취소됩니다.' : ''}
            {deleteError ? (
              <span role="alert" className={styles.error}>
                {' '}
                {deleteError}
              </span>
            ) : null}
          </>
        }
        confirmLabel="삭제"
        loading={deleting}
        returnFocusRef={deleteReturn}
        onConfirm={() => void runDelete()}
      />
    </FloatingSidePanel>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className={styles.body}>
      <p className={styles.muted} role="status">
        불러오는 중…
      </p>
      <Skeleton height={56} />
      <Skeleton height={56} />
    </div>
  );
}

function ListView({
  list,
  unfinished,
  dismissError,
  canEdit,
  renaming,
  onRetry,
  onRetryRuns,
  onResume,
  onDismiss,
  onResumeExam,
  onDismissExamRun,
  onAdd,
  onOpen,
  onPractise,
  onRename,
  onRenamed,
  onRenameCancel,
  onSettings,
  onDelete,
}: {
  readonly list: Load<MockExamList>;
  readonly unfinished: Load<readonly UnfinishedRun[]>;
  readonly dismissError: string | null;
  readonly canEdit: boolean;
  readonly renaming: string | null;
  readonly onRetry: () => void;
  readonly onRetryRuns: () => void;
  readonly onResume: (runId: string, position: number) => void;
  readonly onDismiss: (run: UnfinishedRun) => void;
  readonly onResumeExam: (exam: MockExam) => void;
  readonly onDismissExamRun: (exam: MockExam) => void;
  readonly onAdd: () => void;
  readonly onOpen: (exam: MockExam) => void;
  readonly onPractise: (exam: MockExam) => void;
  readonly onRename: (exam: MockExam) => void;
  readonly onRenamed: (exam: MockExam, title: string) => Promise<string | null>;
  readonly onRenameCancel: () => void;
  readonly onSettings: (exam: MockExam) => void;
  readonly onDelete: (exam: MockExam, trigger: HTMLElement | null) => void;
}) {
  const groupTitle = useId();
  // Both first, so the empty text never shows ahead of a run.
  if (list.status === 'loading' || unfinished.status === 'loading') return <Loading />;
  if (list.status === 'error') {
    return (
      <div role="alert" className={styles.alert}>
        <p>{list.message}</p>
        <Button onClick={onRetry}>다시 시도</Button>
      </div>
    );
  }
  const items = list.data.items;
  const runs = unfinished.status === 'ready' ? unfinished.data : [];
  return (
    <>
      <div className={styles.toolbar}>
        <p className={styles.count}>모의고사 {items.length}개</p>
        <Button variant="primary" onClick={onAdd}>
          추가
        </Button>
      </div>
      {unfinished.status === 'error' ? (
        <div role="alert" className={styles.alert}>
          <p>{unfinished.message}</p>
          <Button onClick={onRetryRuns}>다시 시도</Button>
        </div>
      ) : null}
      {dismissError ? (
        <p role="alert" className={styles.error}>
          {dismissError}
        </p>
      ) : null}
      {runs.length > 0 ? (
        <section className={styles.group} aria-labelledby={groupTitle}>
          <h3 id={groupTitle} className={styles.groupTitle}>
            이어 풀기
          </h3>
          <ul className={styles.list} aria-label="이어 풀기 목록">
            {runs.map((run) => (
              <UnfinishedRow
                key={run.id}
                run={run}
                onResume={() => onResume(run.id, run.next_position)}
                onDismiss={() => onDismiss(run)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {items.length === 0 ? (
        runs.length === 0 ? (
          <EmptyState
            headingLevel={3}
            title={EMPTY_TEXT}
            description={canEdit ? EMPTY_HINT.replace(/`/g, '') : undefined}
          />
        ) : null
      ) : (
        <ul className={styles.list} aria-label="모의고사 목록">
          {items.map((exam) => (
            <ListRow
              key={exam.id}
              exam={exam}
              canEdit={canEdit}
              renaming={renaming === exam.id}
              onOpen={() => onOpen(exam)}
              onPractise={() => onPractise(exam)}
              onResume={() => onResumeExam(exam)}
              onDismissRun={() => onDismissExamRun(exam)}
              onRename={() => onRename(exam)}
              onRenamed={(title) => onRenamed(exam, title)}
              onRenameCancel={onRenameCancel}
              onSettings={() => onSettings(exam)}
              onDelete={(trigger) => onDelete(exam, trigger)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function UnfinishedRow({
  run,
  onResume,
  onDismiss,
}: {
  readonly run: UnfinishedRun;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
}) {
  const name = unfinishedRunName(run);
  const pending = useRef(false);
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <p className={styles.runName}>{name}</p>
        <p className={styles.meta}>
          {unfinishedRunProgress(run)} ·{' '}
          <time dateTime={run.last_touched_at}>{formatDateTime(run.last_touched_at)}</time>
        </p>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" aria-label={`${name} 이어 풀기`} onClick={onResume}>
          이어 풀기
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" variant="ghost" label={`${name} 메뉴`} icon={<MoreIcon />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (!pending.current) return;
              pending.current = false;
              event.preventDefault();
              onDismiss();
            }}
          >
            <DropdownMenuItem onSelect={() => (pending.current = true)}>지우기</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function ListRow({
  exam,
  canEdit,
  renaming,
  onOpen,
  onPractise,
  onResume,
  onDismissRun,
  onRename,
  onRenamed,
  onRenameCancel,
  onSettings,
  onDelete,
}: {
  readonly exam: MockExam;
  readonly canEdit: boolean;
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onPractise: () => void;
  readonly onResume: () => void;
  readonly onDismissRun: () => void;
  readonly onRename: () => void;
  readonly onRenamed: (title: string) => Promise<string | null>;
  readonly onRenameCancel: () => void;
  readonly onSettings: () => void;
  readonly onDelete: (trigger: HTMLElement | null) => void;
}) {
  const resumable = canResume(exam) ? exam.unfinished_run : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | null>(null);
  const generating = isGenerating(exam);
  const progress = generationProgress(exam.latest_generation);
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <div className={styles.titleRow}>
          {renaming ? (
            <RenameField
              initial={exam.title}
              onSave={async (title) => {
                const failure = await onRenamed(title);
                if (!failure) trigger.current?.focus();
                return failure;
              }}
              onCancel={() => {
                onRenameCancel();
                trigger.current?.focus();
              }}
            />
          ) : (
            <button type="button" className={styles.titleButton} onClick={onOpen}>
              {exam.title}
            </button>
          )}
          <Badge tone={STATUS_TONES[exam.status]}>{statusLabel(exam)}</Badge>
        </div>
        <p className={styles.meta}>
          {metaText(exam)} ·{' '}
          <time dateTime={exam.created_at}>{formatDateTime(exam.created_at)}</time>
        </p>
        {generating ? (
          <ProgressBar
            label="문제 생성 진행률"
            value={progressPercent(progress)}
            valueText={progressValueText(progress)}
          />
        ) : null}
        {isWaiting(exam) ? <p className={styles.meta}>{WAITING_TEXT}</p> : null}
      </div>
      <div className={styles.itemActions}>
        {resumable ? (
          <Button
            size="sm"
            variant="primary"
            aria-label={`${exam.title} ${resumeLabel(resumable)}`}
            onClick={onResume}
            disabled={renaming}
          >
            {resumeLabel(resumable)}
          </Button>
        ) : canPractise(exam) ? (
          <Button size="sm" onClick={onPractise} disabled={renaming}>
            풀기
          </Button>
        ) : null}
        {canEdit || resumable ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={trigger}
                size="sm"
                variant="ghost"
                label={`${exam.title} 메뉴`}
                icon={<MoreIcon />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                const action = pending.current;
                pending.current = null;
                if (!action) return;
                event.preventDefault();
                action();
              }}
            >
              {resumable ? (
                <>
                  <DropdownMenuItem
                    disabled={renaming}
                    onSelect={() =>
                      (pending.current = () => {
                        trigger.current?.focus();
                        onPractise();
                      })
                    }
                  >
                    풀기
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => (pending.current = onDismissRun)}>
                    이어 풀기 지우기
                  </DropdownMenuItem>
                </>
              ) : null}
              {canEdit ? (
                <>
                  <DropdownMenuItem onSelect={() => (pending.current = onRename)}>
                    이름 바꾸기
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => (pending.current = onSettings)}>
                    설정 바꾸기
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => (pending.current = () => onDelete(trigger.current))}
                  >
                    삭제
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
