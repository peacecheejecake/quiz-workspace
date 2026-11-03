'use client';

// CHREDIST-01 챕터 재분배 (docs/screens/chapter-redistribution.md, docs/questions.md §14): the
// workspace home's modal floating dialog (`?panel=chapter-redistribution`, HOMEDLG-01), opened
// from `문제 › 챕터 재분배` by editors of an active workspace. Two steps in place (the URL keeps
// only the panel; Back closes the dialog):
//   list     the confirmed questions in a QuestionRangePicker ("직접 정함" badge on `manual`
//            rows), the 직접 옮기기 row (`옮길 챕터` + `이동 (n)`, reasons while disabled) and the
//            자동 추천 row (`직접 정한 챕터도 다시 추천`, `자동 추천 보기` + its scope).
//   preview  `자동 추천 보기`: the summary, then only the questions whose chapter would change,
//            each with `적용` (checked), `모두 적용` (tri-state) and `선택한 추천 적용 (k)`.
// Every move goes through a ConfirmDialog and one atomic request carrying the chapter each
// question showed: a question changed meanwhile refuses the whole request (409 chapter-changed),
// the alert says so and the list (or the preview) is read again. One Idempotency-Key per intended
// move, kept for a retry of the same move after a network failure; a double press sends once.
// Selected questions or a chosen target are unsaved input: a backdrop click keeps the dialog.
import {
  BackLink,
  Button,
  Checkbox,
  ConfirmDialog,
  FloatingSidePanel,
  Select,
  Skeleton,
  useUnsavedChanges,
} from '@quiz/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';
import {
  applyItems,
  createRedistributionApi,
  movePlan,
  NO_CHAPTER_TITLE,
  NO_RECOMMENDATION_LABELS,
  previewEdited,
  previewSummary,
  REASON_LABELS,
  REDIST_FAILURE_MESSAGES,
  redistributionGroups,
  rowNumber,
  targetOptions,
  type AssignmentItem,
  type RedistFailureKind,
  type RedistributionApi,
  type RedistributionList,
  type RedistributionPreview,
  type RedistributionPreviewItem,
} from '@/lib/questions/redistribution';
import { triState } from '../viewer/range-model';
import { QuestionRangePicker, VIRTUALIZE_AT, VirtualRows } from '../viewer/question-range-picker';
import styles from './chapter-redistribution.module.css';

export interface ChapterRedistributionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly container: HTMLElement | null;
  readonly workspaceId: string;
  /** After a move or a refused one: the home re-reads the Heatmap and an open 정리 노트 panel. */
  readonly onChanged: () => void;
  readonly screenId?: string;
}

export function ChapterRedistributionDialog({
  open,
  onOpenChange,
  container,
  workspaceId,
  onChanged,
  screenId,
}: ChapterRedistributionDialogProps) {
  // While the confirmation is open (and in the task it closes in), a close request of the panel
  // is an Escape meant for the confirmation: it closes the confirmation, never the panel. At 375px
  // Chromium intermittently ranked the panel's Radix layer above the confirmation's, so the panel
  // took that Escape (and before the guard closed itself, with the move half done).
  const holdRef = useRef<(() => void) | null>(null);
  const onHold = useCallback((closeConfirm: (() => void) | null) => {
    if (closeConfirm) holdRef.current = closeConfirm;
    else window.setTimeout(() => (holdRef.current = null), 0);
  }, []);
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={(next) => {
        if (!next && holdRef.current) {
          holdRef.current();
          return;
        }
        onOpenChange(next);
      }}
      container={container}
      title="챕터 재분배"
      closeLabel="챕터 재분배 닫기"
      mobileLayout="full"
    >
      <div data-screen-id={screenId}>
        {open ? (
          <RedistributionContent workspaceId={workspaceId} onChanged={onChanged} onHold={onHold} />
        ) : null}
      </div>
    </FloatingSidePanel>
  );
}

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly kind: RedistFailureKind };

interface PendingMove {
  readonly source: 'manual' | 'recommendation';
  readonly items: readonly AssignmentItem[];
  readonly title: string;
  readonly done: string;
  readonly key: string;
}

type Notice = { readonly tone: 'status' | 'alert'; readonly text: string } | null;

/** The fixed height of a recommendation row once the list is virtualized (px). */
const PREVIEW_ROW_PX = 128;

const CONFIRM_DESCRIPTION =
  '옮긴 장과 새 장의 정리 노트가 최신이 아니게 됩니다. 문제 내용과 풀이 기록은 바뀌지 않습니다.';

/**
 * Safari's default Tab order skips buttons (the QuestionRangePicker gives its own an explicit
 * tabIndex for the same reason): every button-like control of the dialog, the kit's Select
 * trigger and checkboxes included, and of its confirmation gets `tabindex="0"` so the keyboard
 * path reaches `옮길 챕터`, `이동` and `옮기기` there too.
 */
function useTabStops(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mark = () => {
      const scopes = [root, ...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')];
      for (const scope of scopes) {
        for (const el of scope.querySelectorAll<HTMLElement>('button:not([tabindex])')) {
          el.tabIndex = 0;
        }
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootRef]);
}

function sameItems(a: readonly AssignmentItem[], b: readonly AssignmentItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function RedistributionContent({
  workspaceId,
  onChanged,
  onHold,
}: {
  readonly workspaceId: string;
  readonly onChanged: () => void;
  readonly onHold: (closeConfirm: (() => void) | null) => void;
}) {
  const api = useMemo<RedistributionApi>(() => createRedistributionApi(workspaceId), [workspaceId]);
  const [list, setList] = useState<Load<RedistributionList>>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [target, setTarget] = useState<string | null>(null);
  const [includeManual, setIncludeManual] = useState(false);
  const [step, setStep] = useState<'list' | 'preview'>('list');
  const [preview, setPreview] = useState<Load<RedistributionPreview>>({ status: 'loading' });
  const [previewScope, setPreviewScope] = useState<readonly string[] | 'all'>('all');
  const [previewRun, setPreviewRun] = useState(0);
  const [applyChecked, setApplyChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);
  const confirming = confirm !== null;
  useEffect(() => {
    // While the move is in flight the confirmation stays (and so does the panel).
    onHold(confirming ? () => (busy ? undefined : setConfirm(null)) : null);
  }, [confirming, busy, onHold]);
  useEffect(() => () => onHold(null), [onHold]);
  const [notice, setNotice] = useState<Notice>(null);
  const busyRef = useRef(false);
  /** The last move that failed on the network: the same move again reuses its key. */
  const retryRef = useRef<PendingMove | null>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const recommendRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusAfterStep = useRef<'back' | 'recommend' | null>(null);
  const moveReasonId = useId();
  const autoId = useId();
  const applyReasonId = useId();

  // Unsaved input: selected questions, a chosen target, or `적용` choices changed in the preview.
  useUnsavedChanges(
    selected.size > 0 ||
      target !== null ||
      (step === 'preview' &&
        preview.status === 'ready' &&
        previewEdited(preview.data.items, applyChecked)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useTabStops(rootRef);

  useEffect(() => {
    const controller = new AbortController();
    api.list(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        // A re-read keeps the last list on screen when it fails.
        setList((prev) =>
          result.ok
            ? { status: 'ready', data: result.data }
            : prev.status === 'ready' && result.kind === 'unavailable'
              ? prev
              : { status: 'error', kind: result.kind },
        );
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, reload]);

  useEffect(() => {
    if (step !== 'preview') return;
    const controller = new AbortController();
    api.preview(previewScope, includeManual, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setPreview({ status: 'error', kind: result.kind });
          return;
        }
        setApplyChecked(new Set(result.data.items.map((i) => i.question_id)));
        setPreview({ status: 'ready', data: result.data });
      },
      () => undefined,
    );
    return () => controller.abort();
    // includeManual is read when a preview starts (the checkbox lives on the list step).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, step, previewScope, previewRun]);

  // Focus follows the step: the new step's first control, so it is never lost on a removed one.
  useEffect(() => {
    const which = focusAfterStep.current;
    if (!which) return;
    focusAfterStep.current = null;
    const el = which === 'back' ? backRef.current?.querySelector('button') : recommendRef.current;
    el?.focus({ preventScroll: true });
  }, [step]);

  const data = list.status === 'ready' ? list.data : null;
  const groups = useMemo(() => (data ? redistributionGroups(data) : null), [data]);
  const options = useMemo(() => (data ? targetOptions(data) : []), [data]);
  const listedSelected = data ? data.items.filter((q) => selected.has(q.question_id)).length : 0;
  const plan = data ? movePlan(data, selected, target) : null;
  const targetTitle = options.find((o) => o.value === target)?.title ?? NO_CHAPTER_TITLE;

  function startMove(pending: Omit<PendingMove, 'key'>, opener: HTMLElement | null) {
    const retry = retryRef.current;
    const key =
      retry && retry.source === pending.source && sameItems(retry.items, pending.items)
        ? retry.key
        : newIdempotencyKey();
    returnFocusRef.current = opener;
    setConfirm({ ...pending, key });
  }

  function openMove() {
    if (!plan || plan.items.length === 0) return;
    const n = plan.items.length;
    startMove(
      {
        source: 'manual',
        items: plan.items,
        title: `문제 ${n}개를 ${targetTitle}로 옮길까요?`,
        done: `문제 ${n}개를 ${targetTitle}로 옮겼습니다.`,
      },
      moveRef.current,
    );
  }

  function openApply() {
    if (preview.status !== 'ready') return;
    const items = applyItems(preview.data.items, applyChecked);
    if (items.length === 0) return;
    startMove(
      {
        source: 'recommendation',
        items,
        title: `추천한 챕터로 문제 ${items.length}개를 옮길까요?`,
        done: `문제 ${items.length}개의 챕터를 추천대로 바꿨습니다.`,
      },
      applyRef.current,
    );
  }

  async function runMove() {
    const pending = confirm;
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let result;
    try {
      result = await api.assign(pending.source, pending.items, pending.key);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    retryRef.current = !result.ok && result.kind === 'unavailable' ? pending : null;
    if (result.ok) {
      setNotice({ tone: 'status', text: pending.done });
      // The control that opened the confirmation goes away (cleared selection, other step).
      returnFocusRef.current = statusRef.current;
      setSelected(new Set());
      setTarget(null);
      if (step === 'preview') setStep('list');
      setReload((n) => n + 1);
      onChanged();
    } else {
      setNotice({ tone: 'alert', text: REDIST_FAILURE_MESSAGES[result.kind] });
      if (result.kind === 'changed' || result.kind === 'invalid') {
        setReload((n) => n + 1);
        if (step === 'preview') setPreviewRun((n) => n + 1);
        onChanged();
      }
    }
    setConfirm(null);
  }

  function showPreview() {
    if (!data) return;
    const ids = data.items.filter((q) => selected.has(q.question_id)).map((q) => q.question_id);
    setNotice(null);
    setPreview({ status: 'loading' });
    setPreviewScope(ids.length > 0 ? ids : 'all');
    setPreviewRun((n) => n + 1);
    focusAfterStep.current = 'back';
    setStep('preview');
  }

  function backToList() {
    focusAfterStep.current = 'recommend';
    setStep('list');
  }

  const moveCount = plan?.items.length ?? 0;
  const moveReason =
    listedSelected === 0
      ? '옮길 문제를 고르세요'
      : target === null
        ? '옮길 챕터를 고르세요'
        : moveCount === 0
          ? '고른 문제가 모두 이미 이 챕터입니다'
          : null;

  return (
    <div
      ref={rootRef}
      className={styles.body}
      aria-busy={list.status === 'loading' || busy || undefined}
    >
      <p ref={statusRef} role="status" tabIndex={-1} className={styles.notice}>
        {notice?.tone === 'status' ? notice.text : null}
      </p>
      {notice?.tone === 'alert' ? (
        <p role="alert" className={styles.alertText}>
          {notice.text}
        </p>
      ) : null}

      {step === 'list' ? (
        list.status === 'loading' ? (
          <div className={styles.loading}>
            <p className={styles.muted}>문제를 불러오는 중입니다.</p>
            <Skeleton height={40} />
            <Skeleton height={40} />
          </div>
        ) : list.status === 'error' ? (
          <div role="alert" className={styles.failure}>
            <p>{REDIST_FAILURE_MESSAGES[list.kind]}</p>
            <Button
              onClick={() => {
                setList({ status: 'loading' });
                setReload((n) => n + 1);
              }}
            >
              다시 시도
            </Button>
          </div>
        ) : data && data.items.length === 0 ? (
          <p className={styles.muted}>옮길 확정 문제가 없습니다</p>
        ) : (
          <>
            <QuestionRangePicker
              groups={groups}
              selected={selected}
              onSelectedChange={setSelected}
              emptyText="옮길 확정 문제가 없습니다"
            />

            <section className={styles.section} aria-labelledby={`${moveReasonId}-h`}>
              <h3 id={`${moveReasonId}-h`} className={styles.sectionTitle}>
                직접 옮기기
              </h3>
              <div className={styles.row}>
                <Select
                  label="옮길 챕터"
                  placeholder="챕터 고르기"
                  fieldClassName={styles.target}
                  options={options.map((o) => ({
                    value: o.value,
                    textValue: o.title,
                    label: (
                      <span className={styles.option} data-depth={Math.min(o.depth, 4)}>
                        {o.documentTitle ? `${o.title} · ${o.documentTitle}` : o.title}
                      </span>
                    ),
                  }))}
                  {...(target !== null ? { value: target } : { value: '' })}
                  onValueChange={(value) => value && setTarget(value)}
                />
                <Button
                  ref={moveRef}
                  variant="primary"
                  disabled={moveReason !== null || busy}
                  aria-describedby={moveReason !== null ? moveReasonId : undefined}
                  onClick={openMove}
                >
                  {moveCount > 0 ? `이동 (${moveCount})` : '이동'}
                </Button>
              </div>
              {moveReason !== null ? (
                <p id={moveReasonId} className={styles.muted}>
                  {moveReason}
                </p>
              ) : null}
              {plan && target !== null && plan.already > 0 ? (
                <p className={styles.muted}>
                  {`${plan.selected}문제 중 ${plan.already}문제는 이미 이 챕터입니다`}
                </p>
              ) : null}
            </section>

            <section className={styles.section} aria-labelledby={autoId}>
              <h3 id={autoId} className={styles.sectionTitle}>
                자동 추천
              </h3>
              <Checkbox
                label="직접 정한 챕터도 다시 추천"
                checked={includeManual}
                onCheckedChange={(checked) => setIncludeManual(checked === true)}
              />
              <div className={styles.row}>
                <Button ref={recommendRef} onClick={showPreview}>
                  자동 추천 보기
                </Button>
                <span className={styles.muted}>
                  {listedSelected > 0 ? `선택한 ${listedSelected}문제` : '전체 문제'}
                </span>
              </div>
            </section>
          </>
        )
      ) : (
        <PreviewStep
          preview={preview}
          checked={applyChecked}
          onCheckedChange={setApplyChecked}
          backRef={backRef}
          applyRef={applyRef}
          applyReasonId={applyReasonId}
          busy={busy}
          onBack={backToList}
          onApply={openApply}
          onRetry={() => {
            setPreview({ status: 'loading' });
            setPreviewRun((n) => n + 1);
          }}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={confirm?.title ?? ''}
        description={CONFIRM_DESCRIPTION}
        confirmLabel="옮기기"
        loading={busy}
        onConfirm={() => void runMove()}
        returnFocusRef={returnFocusRef}
      />
    </div>
  );
}

export function PreviewStep({
  preview,
  checked,
  onCheckedChange,
  backRef,
  applyRef,
  applyReasonId,
  busy,
  onBack,
  onApply,
  onRetry,
}: {
  readonly preview: Load<RedistributionPreview>;
  readonly checked: ReadonlySet<string>;
  readonly onCheckedChange: (checked: ReadonlySet<string>) => void;
  readonly backRef: RefObject<HTMLDivElement | null>;
  readonly applyRef: RefObject<HTMLButtonElement | null>;
  readonly applyReasonId: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onApply: () => void;
  readonly onRetry: () => void;
}) {
  const data = preview.status === 'ready' ? preview.data : null;
  const ids = data ? data.items.map((i) => i.question_id) : [];
  const count = ids.filter((id) => checked.has(id)).length;
  /** One recommendation: `적용` (named with the whole change) and its text lines. */
  const row = (item: RedistributionPreviewItem) => {
    const current = item.current_chapter?.title ?? NO_CHAPTER_TITLE;
    const next = item.recommended_chapter.title;
    const number =
      item.current_chapter === null
        ? rowNumber({ chapter_id: null, label: item.number_label })
        : item.number_label;
    return (
      <>
        <Checkbox
          label="적용"
          aria-label={`적용: ${number} · ${item.stem_preview} (${current}에서 ${next}으로)`}
          tabIndex={0}
          checked={checked.has(item.question_id)}
          onCheckedChange={(on) => {
            const set = new Set(checked);
            if (on === true) set.add(item.question_id);
            else set.delete(item.question_id);
            onCheckedChange(set);
          }}
        />
        <div className={styles.previewText}>
          <p className={styles.stem}>{`${number} · ${item.stem_preview}`}</p>
          {/* Two lines, each clamped on its own: the recommended chapter always shows. */}
          <p data-part="current">{`현재: ${current}`}</p>
          <p data-part="recommended">
            <span aria-hidden="true">→</span> {`추천: ${next}`}
          </p>
          <p className={styles.muted}>{REASON_LABELS[item.reason] ?? item.reason}</p>
        </div>
      </>
    );
  };
  const missing = data ? Object.entries(data.no_recommendation).filter(([, n]) => n > 0) : [];
  return (
    <div className={styles.body}>
      <div ref={backRef}>
        <BackLink label="목록으로" onClick={onBack} />
      </div>
      {preview.status === 'loading' ? (
        <div className={styles.loading}>
          <p className={styles.muted}>추천을 계산하는 중입니다.</p>
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : preview.status === 'error' ? (
        <div role="alert" className={styles.failure}>
          <p>{REDIST_FAILURE_MESSAGES[preview.kind]}</p>
          <Button onClick={onRetry}>다시 시도</Button>
        </div>
      ) : data ? (
        <>
          <p className={styles.summary}>{previewSummary(data)}</p>
          {missing.length > 0 ? (
            <details className={styles.details}>
              <summary className={styles.detailsSummary}>추천 없음 이유</summary>
              <ul className={styles.reasons}>
                {missing.map(([reason, n]) => (
                  <li key={reason}>{`${NO_RECOMMENDATION_LABELS[reason] ?? reason} ${n}개`}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {data.items.length === 0 ? (
            <div className={styles.section}>
              <p className={styles.muted}>추천과 다른 챕터의 문제가 없습니다.</p>
              <div>
                <Button onClick={onBack}>목록으로</Button>
              </div>
            </div>
          ) : (
            <>
              <Checkbox
                label="모두 적용"
                checked={triState(ids, checked)}
                onCheckedChange={() =>
                  onCheckedChange(triState(ids, checked) === true ? new Set() : new Set(ids))
                }
              />
              {data.items.length > VIRTUALIZE_AT ? (
                <VirtualRows
                  items={data.items.map((item) => ({ id: item.question_id, item }))}
                  row={({ item }) => row(item)}
                  rowPx={PREVIEW_ROW_PX}
                  label="추천"
                  listClassName={styles.previewList}
                  rowClassName={`${styles.previewRow} ${styles.previewRowFixed}`}
                />
              ) : (
                <ul className={styles.previewList} aria-label="추천">
                  {data.items.map((item) => (
                    <li key={item.question_id} className={styles.previewRow}>
                      {row(item)}
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.row}>
                <Button
                  ref={applyRef}
                  variant="primary"
                  disabled={count === 0 || busy}
                  aria-describedby={count === 0 ? applyReasonId : undefined}
                  onClick={onApply}
                >
                  {`선택한 추천 적용 (${count})`}
                </Button>
              </div>
              {count === 0 ? (
                <p id={applyReasonId} className={styles.muted}>
                  적용할 추천을 고르세요
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
