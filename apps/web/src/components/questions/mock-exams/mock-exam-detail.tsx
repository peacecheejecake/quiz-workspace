'use client';

// MOCK-01 상세 (docs/screens/mock-exams.md "상세 화면"): the mock exam's name (heading), status badge,
// meta (settings, "2회차", 만든 시각), `풀기` and, for editors of an active workspace, the 더보기
// menu (UX12-MOCKNAV): `설정 바꾸기` (the 만들기 steps with the current values, ending in `다시
// 만들기`), `다시 만들기` (the same settings), `이름 바꾸기` and `삭제`. A round being made shows the
// "문제 생성 진행률" bar and "문제를 만드는 중입니다…" above the previous questions (they stay until
// the new round succeeds);
// a failed one the alert with its reason and `다시 시도`; a partial one how many passed. The
// 문제 목록 rows open MockQuestionDialog (manage for editors, an answer-free preview otherwise).
// While a round runs the mock exam is read again every MOCK_POLL_MS; its end is announced.
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  MoreIcon,
  ProgressBar,
  Skeleton,
} from '@quiz/ui';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RunRange } from '@/lib/questions/practice-runs';
import type { MockExamApi } from './mock-exam-client';
import { MockExamForm, type MockExamSubmit } from './mock-exam-form';
import {
  canPractise,
  DIFFICULTY_LABELS,
  FAILED_TITLE,
  failureText,
  generationProgress,
  isGenerating,
  isWaiting,
  MOCK_POLL_MS,
  needsReview,
  NOT_FOUND_TEXT,
  optionsFromConfig,
  partialText,
  progressPercent,
  progressValueText,
  questionRowTitle,
  replaceText,
  roundText,
  SAME_DIFFICULTY_LABEL,
  STATUS_TONES,
  statusLabel,
  usesAi,
  VARIATION_LABELS,
  variationText,
  WAITING_TEXT,
  WORKING_TEXT,
  type MockExam,
  type MockExamQuestion,
} from './mock-exam-model';
import { formatDateTime } from '../labels';
import { MockQuestionDialog, type MockQuestionTarget } from './mock-question-dialog';
import { RenameField } from './rename-field';
import styles from './mock-exams.module.css';

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly message: string; readonly notFound: boolean };

export interface MockExamDetailProps {
  readonly workspaceId: string;
  readonly mockExamId: string;
  readonly api: MockExamApi;
  readonly canEdit: boolean;
  readonly llmAvailable: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  /** Bumped when the mock exam changed elsewhere (renamed from the list): read it again. */
  readonly refreshKey: number;
  /** Open on 설정 바꾸기 (the list row's menu). */
  readonly openSettings: boolean;
  readonly onSettingsShown: () => void;
  readonly onPractise: (exam: MockExam) => void;
  readonly onBankSubmit: (range: RunRange, count: number | null, random: boolean) => void;
  readonly bankBusy: boolean;
  readonly bankError: string | null;
  readonly onRename: (exam: MockExam, title: string) => Promise<string | null>;
  readonly onDelete: (exam: MockExam, trigger: HTMLElement | null) => void;
  /** The mock exam changed (a new round, a finished one, a question): the list reads again. */
  readonly onChanged: () => void;
}

/** "문구 변형, 정오 반전 · 20문항 · 난이도 원본과 같게". */
function settingsText(exam: MockExam): string {
  const { config } = exam;
  const count = config.question_count === null ? '범위 전체' : `${config.question_count}문항`;
  const parts = [variationText(config.variation_types), count];
  if (usesAi(config.variation_types)) {
    parts.push(
      `난이도 ${config.difficulty ? DIFFICULTY_LABELS[config.difficulty] : SAME_DIFFICULTY_LABEL}`,
    );
  }
  return parts.join(' · ');
}

export function MockExamDetail({
  mockExamId,
  workspaceId,
  api,
  canEdit,
  llmAvailable,
  headingRef,
  refreshKey,
  openSettings,
  onSettingsShown,
  onPractise,
  onBankSubmit,
  bankBusy,
  bankError,
  onRename,
  onDelete,
  onChanged,
}: MockExamDetailProps) {
  const [exam, setExam] = useState<Load<MockExam>>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    api.get(mockExamId).then(
      (result) => {
        if (!live) return;
        setExam(
          result.ok
            ? { status: 'ready', data: result.data }
            : { status: 'error', message: result.message, notFound: result.kind === 'notFound' },
        );
      },
      () => {
        if (live) {
          setExam({ status: 'error', message: '모의고사를 불러오지 못했습니다.', notFound: false });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api, mockExamId, reads, refreshKey]);
  const data = exam.status === 'ready' ? exam.data : null;
  // The panel focuses the view's heading on arrival, but a detail that is still loading has no
  // heading yet (after 만들기 the form's button is gone and focus fell to <body>): once it is
  // read, its heading takes the focus that was lost meanwhile (MOCK-01 접근성, A11Y-14). The modal
  // panel (UX9) catches lost focus on itself instead of <body>: that counts as lost too.
  const loaded = exam.status !== 'loading';
  useEffect(() => {
    if (!loaded) return;
    const active = document.activeElement;
    const heading = headingRef.current;
    const lost =
      active === null ||
      active === document.body ||
      (active.getAttribute('role') === 'dialog' && heading !== null && active.contains(heading));
    if (lost) heading?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const generating = data ? isGenerating(data) : false;
  useEffect(() => {
    if (!generating) return;
    const timer = window.setTimeout(() => setReads((n) => n + 1), MOCK_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [generating, exam]);

  // The shown questions: the current round's, read again when it changes (or one was edited).
  const roundId = data?.current_generation?.id ?? null;
  const [questionsSeq, setQuestionsSeq] = useState(0);
  const questionsKey = roundId ? `${roundId}:${questionsSeq}` : null;
  const [questionsState, setQuestionsState] = useState<{
    key: string;
    load: Load<readonly MockExamQuestion[]>;
  } | null>(null);
  useEffect(() => {
    if (!questionsKey) return;
    let live = true;
    api.questions(mockExamId, canEdit).then(
      (result) => {
        if (!live) return;
        setQuestionsState({
          key: questionsKey,
          load: result.ok
            ? { status: 'ready', data: result.data }
            : { status: 'error', message: result.message, notFound: false },
        });
      },
      () => {
        if (live) {
          setQuestionsState({
            key: questionsKey,
            load: { status: 'error', message: '문제를 불러오지 못했습니다.', notFound: false },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api, mockExamId, canEdit, questionsKey]);
  const questions: Load<readonly MockExamQuestion[]> = !questionsKey
    ? { status: 'ready', data: [] }
    : questionsState?.key === questionsKey
      ? questionsState.load
      : { status: 'loading' };
  function setQuestions(
    patch: (prev: Load<readonly MockExamQuestion[]>) => Load<readonly MockExamQuestion[]>,
  ) {
    setQuestionsState((prev) => (prev ? { key: prev.key, load: patch(prev.load) } : prev));
  }

  // A round that ends is announced and the list reads again.
  const [announcement, setAnnouncement] = useState('');
  const wasGenerating = useRef<boolean | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = wasGenerating.current;
    wasGenerating.current = generating;
    if (before === true && !generating) {
      // A failure is its alert; a partial round's text appears in the live region below.
      setAnnouncement(
        data.latest_generation?.status === 'succeeded' ? '모의고사 문제를 만들었습니다.' : '',
      );
      onChanged();
    }
  }, [data, generating, onChanged]);

  const [mode, setMode] = useState<'view' | 'settings'>(openSettings ? 'settings' : 'view');
  // 설정 바꾸기 from the list's row menu is an opening of its own (see roundOpening).
  useEffect(() => {
    if (openSettings) onSettingsShown();
  }, [openSettings, onSettingsShown]);
  const [renaming, setRenaming] = useState(false);
  // 더보기 stays mounted through a rename; the 설정 바꾸기 form replaces it, so leaving that form
  // focuses it once it is back. Menu actions run after the menu closed (the list row's pattern).
  const moreButton = useRef<HTMLButtonElement>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const focusMore = useRef(false);
  useEffect(() => {
    if (mode !== 'view' || !focusMore.current) return;
    focusMore.current = false;
    moreButton.current?.focus();
  }, [mode]);

  // --- a new round (설정 바꾸기 / 다시 만들기 / 다시 시도) ---------------------------------------------
  const [confirm, setConfirm] = useState<{ body: Partial<MockExamSubmit> } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // One Idempotency-Key per opening and payload (the QVIEW-W rule): this detail's mount and each
  // 설정 바꾸기 opening are openings; a retry within one reuses its key (an ambiguous failure may
  // hide a started round), and a confirmed success retires only its own key.
  const [roundOpening, setRoundOpening] = useState(0);
  const roundKey = useRef<{ opening: number; payload: string; key: string } | null>(null);
  const mounted = useRef(true);
  const liveRound = useRef(roundOpening);
  useLayoutEffect(() => {
    liveRound.current = roundOpening;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function startRound(body: Partial<MockExamSubmit>) {
    if (!data || starting) return;
    const opening = roundOpening;
    const payload = JSON.stringify(body);
    const held = roundKey.current;
    const key =
      held && held.opening === opening && held.payload === payload
        ? held.key
        : (roundKey.current = { opening, payload, key: crypto.randomUUID() }).key;
    setStarting(true);
    setStartError(null);
    const request: Parameters<MockExamApi['regenerate']>[1] = {};
    if (body.config) request.config = body.config;
    if (body.range) request.range = body.range;
    let result: Awaited<ReturnType<MockExamApi['regenerate']>>;
    try {
      result = await api.regenerate(data.id, request, key);
    } catch {
      result = {
        ok: false,
        kind: 'unavailable',
        message: '다시 만들지 못했습니다. 다시 시도하세요.',
      };
    }
    if (result.ok && roundKey.current?.key === key) roundKey.current = null;
    // The list reads the new round even when this detail was left meanwhile.
    if (result.ok) onChanged();
    if (!mounted.current) return;
    setStarting(false);
    setConfirm(null);
    if (!result.ok) {
      // A 설정 바꾸기 closed or reopened meanwhile keeps its own (newer) state.
      if (liveRound.current === opening) setStartError(result.message);
      return;
    }
    setExam({ status: 'ready', data: result.data });
    // 보기 섞기 only: the round is already finished, so no generating state announces it.
    if (result.data.latest_generation?.status === 'succeeded') {
      setAnnouncement('모의고사 문제를 만들었습니다.');
    }
    if (liveRound.current === opening) setMode('view');
  }
  function startSettings() {
    setStartError(null);
    setRoundOpening((n) => n + 1);
    setMode('settings');
  }
  function askRound(body: Partial<MockExamSubmit>) {
    if (!data) return;
    setStartError(null);
    if (data.question_count_current > 0) setConfirm({ body });
    else void startRound(body);
  }

  // --- questions ----------------------------------------------------------------------------
  const [open, setOpen] = useState<MockQuestionTarget | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  if (exam.status === 'loading') {
    return (
      <div aria-busy="true" className={styles.body}>
        <p className={styles.muted} role="status">
          불러오는 중…
        </p>
        <Skeleton height={32} />
        <Skeleton height={80} />
      </div>
    );
  }
  if (exam.status === 'error') {
    return exam.notFound ? (
      <p className={styles.text}>{NOT_FOUND_TEXT}</p>
    ) : (
      <div role="alert" className={styles.alert}>
        <p>{exam.message}</p>
        <Button onClick={() => setReads((n) => n + 1)}>다시 시도</Button>
      </div>
    );
  }

  const shown = exam.data;
  const latest = shown.latest_generation;
  const progress = generationProgress(latest);
  const round = roundText(shown);
  const items = questions.status === 'ready' ? questions.data : [];
  const failed = !generating && latest?.status === 'failed';
  const partial = !generating && latest?.status === 'partial';

  return (
    <div className={styles.body}>
      <div className={styles.header}>
        {renaming ? (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="qz-visually-hidden">
              {shown.title}
            </h2>
            <RenameField
              initial={shown.title}
              onSave={async (title) => {
                const failure = await onRename(shown, title);
                if (!failure) {
                  setExam({ status: 'ready', data: { ...shown, title } });
                  setRenaming(false);
                  moreButton.current?.focus();
                  onChanged();
                }
                return failure;
              }}
              onCancel={() => {
                setRenaming(false);
                moreButton.current?.focus();
              }}
            />
          </>
        ) : (
          <h2 ref={headingRef} tabIndex={-1} className={styles.heading}>
            {shown.title}
          </h2>
        )}
        <div className={styles.badges}>
          <Badge tone={STATUS_TONES[shown.status]}>{statusLabel(shown)}</Badge>
          {round ? <span>{round}</span> : null}
          <span>문제 {shown.question_count_current}개</span>
        </div>
        <p className={styles.meta}>
          {settingsText(shown)} ·{' '}
          <time dateTime={shown.created_at}>{formatDateTime(shown.created_at)}</time>
        </p>
        {mode === 'view' ? (
          <div className={styles.actions}>
            {canPractise(shown) ? (
              <Button variant="primary" disabled={renaming} onClick={() => onPractise(shown)}>
                풀기
              </Button>
            ) : null}
            {canEdit ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <IconButton ref={moreButton} label="더보기" icon={<MoreIcon />} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    const action = pendingAction.current;
                    pendingAction.current = null;
                    if (!action) return;
                    event.preventDefault();
                    moreButton.current?.focus();
                    action();
                  }}
                >
                  <DropdownMenuItem
                    disabled={generating}
                    onSelect={() => (pendingAction.current = startSettings)}
                  >
                    설정 바꾸기
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={generating || starting}
                    onSelect={() => (pendingAction.current = () => askRound({}))}
                  >
                    다시 만들기
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => (pendingAction.current = () => setRenaming(true))}
                  >
                    이름 바꾸기
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      (pendingAction.current = () => onDelete(shown, moreButton.current))
                    }
                  >
                    삭제
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === 'settings' && canEdit ? (
        <section className={styles.form} aria-label="설정 바꾸기">
          <h3 className={styles.legend}>설정 바꾸기</h3>
          <MockExamForm
            workspaceId={workspaceId}
            mode="settings"
            initial={optionsFromConfig(shown.title, shown.config)}
            initialRange={shown.range}
            llmAvailable={llmAvailable}
            busy={starting || bankBusy}
            error={startError ?? bankError}
            onBankSubmit={onBankSubmit}
            onSubmit={(value) => askRound({ config: value.config, range: value.range })}
            onCancel={() => {
              focusMore.current = true;
              setMode('view');
            }}
          />
        </section>
      ) : (
        <>
          {startError ? (
            <p role="alert" className={styles.error}>
              {startError}
            </p>
          ) : null}
          {generating ? (
            <div className={styles.progress}>
              <ProgressBar
                label="문제 생성 진행률"
                value={progressPercent(progress)}
                valueText={progressValueText(progress)}
              />
              <p className={styles.muted}>
                {progressValueText(progress)} · {isWaiting(shown) ? WAITING_TEXT : WORKING_TEXT}
              </p>
            </div>
          ) : null}
          {failed ? (
            <div role="alert" className={styles.alert}>
              <p className={styles.alertTitle}>{FAILED_TITLE}</p>
              <p>{failureText(latest?.error_code)}</p>
              {canEdit ? (
                <Button disabled={starting} loading={starting} onClick={() => askRound({})}>
                  다시 시도
                </Button>
              ) : null}
            </div>
          ) : null}
          <div aria-live="polite">
            {partial && latest ? <p className={styles.text}>{partialText(latest)}</p> : null}
            {announcement && !partial && !failed ? (
              <p className="qz-visually-hidden">{announcement}</p>
            ) : null}
          </div>

          {questions.status === 'error' ? (
            <div role="alert" className={styles.alert}>
              <p>{questions.message}</p>
              <Button onClick={() => setQuestionsSeq((n) => n + 1)}>다시 시도</Button>
            </div>
          ) : questions.status === 'loading' ? (
            <Skeleton height={56} />
          ) : items.length > 0 ? (
            <ul className={styles.questions} aria-label="문제 목록">
              {items.map((q, i) => (
                <li key={q.id}>
                  <button
                    type="button"
                    className={styles.questionButton}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      openerRef.current = event.currentTarget;
                      setOpen({ question: q, number: i + 1 });
                    }}
                  >
                    <span className={styles.questionTitle}>{questionRowTitle(q.stem, i + 1)}</span>
                    <span className={styles.badges}>
                      <Badge>{VARIATION_LABELS[q.variation_type]}</Badge>
                      <span>{q.source.label}</span>
                      {canEdit && q.edited ? <Badge tone="accent">편집됨</Badge> : null}
                      {canEdit && needsReview(q) ? <Badge tone="warning">확인 필요</Badge> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <MockQuestionDialog
        target={open}
        workspaceId={workspaceId}
        manage={canEdit}
        api={api}
        returnFocusRef={openerRef}
        onClose={() => setOpen(null)}
        onEdited={(saved) => {
          setQuestions((prev) =>
            prev.status === 'ready'
              ? { status: 'ready', data: prev.data.map((q) => (q.id === saved.id ? saved : q)) }
              : prev,
          );
          setOpen((o) => (o && o.question.id === saved.id ? { ...o, question: saved } : o));
        }}
        onRemoved={(removed) => {
          setOpen(null);
          setQuestions((prev) =>
            prev.status === 'ready'
              ? { status: 'ready', data: prev.data.filter((q) => q.id !== removed.id) }
              : prev,
          );
          setExam({
            status: 'ready',
            data: {
              ...shown,
              question_count_current: Math.max(0, shown.question_count_current - 1),
            },
          });
          onChanged();
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next && !starting) setConfirm(null);
        }}
        title="문제를 새로 만들까요?"
        description={replaceText(shown.question_count_current)}
        confirmLabel="다시 만들기"
        loading={starting}
        returnFocusRef={moreButton}
        onConfirm={() => confirm && void startRound(confirm.body)}
      />
    </div>
  );
}
