'use client';

// MOCK-01 만들기 / 설정 바꾸기 (docs/screens/mock-exams.md "만들기 화면", UX12-MOCKFORM,
// UX12-MOCKFORM2): two steps `범위 → 옵션`. The StepList and the action row live in the panel's
// fixed areas, outside the scrolling body; pressing the done step goes back with every entered
// value kept. 범위: the shared QuestionRangePicker over this workspace's confirmed questions with
// its filters and `다음`, disabled with "출제 범위를 고르세요" while nothing is selected. A saved
// range comes back as the selection it meant (selectionFromRange). 옵션: 이름 (with a type chosen:
// a bank run stores no name; a new exam starts with the chosen chapters' name until it is edited),
// the 변형 유형 (one `?` Popover describes them all; the AI ones are absent where the environment
// has no LLM), 문항 수 (1–100 with an AI type; 보기 섞기 only up to the range, or 범위 전체) and
// 난이도, "선택 n문제 중 m문항을 만듭니다", the AI notice and `만들기` (설정 바꾸기: `다시 만들기`,
// a variation-free run: `시작`), which checks the options.
import {
  Button,
  Checkbox,
  FloatingPanelFooter,
  FloatingPanelPinned,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  StepList,
  useUnsavedChanges,
} from '@quiz/ui';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import { RUN_FAILURE_MESSAGES } from '@/lib/questions/practice-run-problems';
import { QuestionRangePicker } from '../viewer/question-range-picker';
import {
  EMPTY_RANGE_FILTERS,
  keepVisible,
  rangeGroups,
  rangeRequest,
  type RangeFilterState,
  type RangeGroup,
} from '../viewer/range-model';
import {
  AI_NOTICE_TEXT,
  cappedCount,
  chapterDefaultTitle,
  checkOptions,
  configFrom,
  DIFFICULTY_LABELS,
  filtersFromRange,
  isAiType,
  madeCount,
  MAX_AI_QUESTIONS,
  NO_RANGE_TEXT,
  SAME_DIFFICULTY_LABEL,
  selectionFromRange,
  usesAi,
  VARIATION_DESCRIPTIONS,
  VARIATION_LABELS,
  VARIATION_ORDER,
  type Difficulty,
  type MockExamConfig,
  type MockRange,
  type OptionError,
  type OptionValues,
  type VariationType,
} from './mock-exam-model';
import styles from './mock-exams.module.css';

const STEPS = [
  { id: 'range', label: '범위' },
  { id: 'options', label: '옵션' },
] as const;
const SAME = '__same__';

export interface MockExamSubmit {
  readonly title: string;
  readonly config: MockExamConfig;
  readonly range: MockRange;
}

export interface MockExamFormProps {
  readonly workspaceId: string;
  readonly mode: 'create' | 'settings';
  readonly initial: OptionValues;
  /** 설정 바꾸기: the range the mock exam was made from (shown as its selection). */
  readonly initialRange?: MockRange | null;
  readonly llmAvailable: boolean;
  readonly busy: boolean;
  /** The last request's failure, shown above the step's buttons. */
  readonly error: string | null;
  readonly onSubmit: (value: MockExamSubmit) => void;
  readonly onBankSubmit?: (range: MockRange, count: number | null, randomOrder: boolean) => void;
  readonly canCreateMock?: boolean;
  /** 설정 바꾸기: back to the detail without a new round. */
  readonly onCancel?: () => void;
  /**
   * The step (0 범위, 1 옵션) when the caller owns it: the create view's header back button moves
   * it too (UX12-MOCKFORM3). Omitted, the form keeps its own.
   */
  readonly step?: 0 | 1;
  readonly onStepChange?: (step: 0 | 1) => void;
}

export function MockExamForm({
  workspaceId,
  mode,
  initial,
  initialRange = null,
  llmAvailable,
  busy,
  error,
  onSubmit,
  onBankSubmit,
  canCreateMock = true,
  onCancel,
  step: stepProp,
  onStepChange,
}: MockExamFormProps) {
  const [ownStep, setOwnStep] = useState<0 | 1>(0);
  const step = stepProp ?? ownStep;
  const setStep = (next: 0 | 1) => {
    setOwnStep(next);
    onStepChange?.(next);
  };
  const [values, setValues] = useState<OptionValues>(() => {
    if (llmAvailable) return initial;
    const types = initial.types.filter((type) => !isAiType(type));
    return {
      ...initial,
      types: types.length || initial.types.length === 0 ? types : ['OPTION_SHUFFLE'],
    };
  });
  const [opening] = useState(() => JSON.stringify(values));
  const range = useRangeStep(workspaceId, step === 0, initialRange);
  // HOMEDLG-01: a touched range or typed options on the range step are unsaved input (the backdrop
  // keeps them). On the options step a backdrop click closes at once (user decision 2026-11-07,
  // UX12-MOCKFORM3).
  useUnsavedChanges(step === 0 && (range.touched || JSON.stringify(values) !== opening));
  const [randomOrder, setRandomOrder] = useState(false);
  // A default follows the range only until the person edits that field (UX12-MOCKFORM2).
  const edited = useRef({ title: false, count: false });
  const [optionError, setOptionError] = useState<OptionError | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  // A step change, from the form or the panel's back button, moves focus to the step's heading.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stepHeading.current?.focus();
  }, [step]);

  function moveTo(index: 0 | 1) {
    setStep(index);
  }

  function toOptions() {
    if (mode === 'create') {
      setValues((current) => ({
        ...current,
        title: edited.current.title
          ? current.title
          : chapterDefaultTitle(range.groups ?? [], range.selected, initial.title),
        count: edited.current.count ? current.count : cappedCount(initial.count, range.count),
      }));
    }
    setOptionError(null);
    moveTo(1);
  }

  const formId = useId();
  const shownTypes = VARIATION_ORDER.filter((type) => llmAvailable || !isAiType(type));
  const ai = usesAi(values.types);
  const shuffleOnly = !ai;
  const reasonId = useId();
  const tooMany = !values.wholeRange && Number(values.count) > range.count;
  const noRange = range.count === 0 || !range.request;
  const rangeReason = range.count === 0 ? NO_RANGE_TEXT : null;
  const optionsReason = tooMany ? '선택한 범위보다 문항 수가 많습니다.' : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = checkOptions(values, llmAvailable);
    setOptionError(found);
    if (found) {
      document.getElementById(`${formId}-${found.field}`)?.focus();
      return;
    }
    if (!range.request || busy || noRange || tooMany) return;
    if (values.types.length === 0 && onBankSubmit) {
      onBankSubmit(range.request, values.wholeRange ? null : Number(values.count), randomOrder);
      return;
    }
    if (values.types.length === 0) return;
    onSubmit({
      title: values.title.trim(),
      config: configFrom(values, range.count),
      range: range.request,
    });
  }

  return (
    <div className={`${styles.form} ${styles.playForm}`}>
      <FloatingPanelPinned>
        <StepList
          label="모의고사 단계"
          steps={STEPS}
          current={step}
          disabled={busy}
          onStepSelect={() => moveTo(0)}
          stepActionLabel={(item) => `${item.label} 단계로 돌아가기`}
        />
      </FloatingPanelPinned>
      {step === 0 ? (
        <div className={styles.form}>
          <h3 ref={stepHeading} tabIndex={-1} className="qz-visually-hidden">
            범위
          </h3>
          <QuestionRangePicker
            // While other filters load the old questions are not shown: a click on them would
            // change a selection the new questions replace.
            groups={range.error || range.busy ? null : range.groups}
            busy={range.busy}
            error={range.error}
            onRetry={range.retry}
            selected={range.selected}
            onSelectedChange={range.setSelected}
            filters={range.filters}
            onFiltersChange={range.setFilters}
          />
          <FloatingPanelFooter>
            {rangeReason ? (
              <p id={reasonId} className={`${styles.muted} ${styles.footerReason}`}>
                {rangeReason}
              </p>
            ) : null}
            {onCancel ? (
              <Button onClick={onCancel} disabled={busy}>
                취소
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={noRange || range.busy || range.error !== null}
              aria-describedby={rangeReason ? reasonId : undefined}
              onClick={toOptions}
            >
              다음
            </Button>
          </FloatingPanelFooter>
        </div>
      ) : (
        <form id={`${formId}-options`} className={styles.form} onSubmit={submit} noValidate>
          <h3 ref={stepHeading} tabIndex={-1} className="qz-visually-hidden">
            옵션
          </h3>
          {values.types.length > 0 ? (
            <Input
              id={`${formId}-title`}
              label="이름"
              value={values.title}
              maxLength={100}
              required
              error={optionError?.field === 'title' ? optionError.message : undefined}
              onChange={(e) => {
                edited.current.title = true;
                setValues({ ...values, title: e.target.value });
                if (optionError?.field === 'title') setOptionError(null);
              }}
            />
          ) : null}
          <fieldset
            className={styles.fieldset}
            aria-labelledby={`${formId}-types-legend`}
            aria-describedby={optionError?.field === 'types' ? `${formId}-types` : undefined}
          >
            <legend className={`${styles.legend} ${styles.legendRow}`}>
              <span id={`${formId}-types-legend`}>변형 유형</span>
              <VariationHelp types={shownTypes} />
            </legend>
            {shownTypes.map((type) => (
              <Checkbox
                key={type}
                label={VARIATION_LABELS[type]}
                checked={values.types.includes(type)}
                disabled={busy || !canCreateMock}
                onCheckedChange={(next) => {
                  setValues({
                    ...values,
                    types:
                      next === true
                        ? [...values.types.filter((t) => t !== type), type]
                        : values.types.filter((t) => t !== type),
                  });
                  if (optionError?.field !== 'count') setOptionError(null);
                }}
              />
            ))}
            {optionError?.field === 'types' ? (
              <p id={`${formId}-types`} role="alert" className={styles.error} tabIndex={-1}>
                {optionError.message}
              </p>
            ) : null}
          </fieldset>
          {!canCreateMock ? (
            <p className={styles.muted}>변형 출제에는 편집 권한이 필요합니다.</p>
          ) : null}
          {values.types.length === 0 ? (
            <Checkbox
              label="문제 순서 무작위"
              checked={randomOrder}
              onCheckedChange={(checked) => setRandomOrder(checked === true)}
            />
          ) : null}
          <div className={styles.formRow}>
            <Input
              id={`${formId}-count`}
              label="문항 수"
              type="number"
              inputMode="numeric"
              min={1}
              max={ai ? MAX_AI_QUESTIONS : undefined}
              value={values.count}
              disabled={busy || (shuffleOnly && values.wholeRange)}
              description={ai ? `1~${MAX_AI_QUESTIONS}문항` : undefined}
              error={optionError?.field === 'count' ? optionError.message : undefined}
              fieldClassName={styles.countField}
              onChange={(e) => {
                edited.current.count = true;
                setValues({ ...values, count: e.target.value });
                if (optionError?.field === 'count') setOptionError(null);
              }}
            />
            {ai ? (
              <Select
                label="난이도"
                value={values.difficulty ?? SAME}
                disabled={busy}
                options={[
                  { value: SAME, label: SAME_DIFFICULTY_LABEL },
                  ...(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((value) => ({
                    value,
                    label: DIFFICULTY_LABELS[value],
                  })),
                ]}
                onValueChange={(value) =>
                  setValues({
                    ...values,
                    difficulty: value === SAME ? null : (value as Difficulty),
                  })
                }
              />
            ) : null}
          </div>
          {shuffleOnly ? (
            <Checkbox
              label="선택 범위의 모든 문항"
              checked={values.wholeRange}
              disabled={busy}
              onCheckedChange={(checked) => setValues({ ...values, wholeRange: checked === true })}
            />
          ) : null}
          <p className={styles.muted} aria-live="polite">
            {`선택 ${range.count}문제 중 ${madeCount(values, range.count)}문항을 만듭니다`}
          </p>
          {mode === 'settings' && values.types.length === 0 ? (
            <p className={styles.notice}>
              기존 모의고사를 변경하지 않고 새 원본 풀이를 시작합니다.
            </p>
          ) : null}
          {ai ? <p className={styles.notice}>{AI_NOTICE_TEXT}</p> : null}
          <FloatingPanelFooter>
            {error ? (
              <p role="alert" className={`${styles.error} ${styles.footerLine}`}>
                {error}
              </p>
            ) : null}
            {optionsReason ? (
              <p id={reasonId} className={`${styles.muted} ${styles.footerReason}`}>
                {optionsReason}
              </p>
            ) : null}
            <Button
              type="submit"
              form={`${formId}-options`}
              variant="primary"
              loading={busy}
              disabled={noRange || tooMany}
              aria-describedby={optionsReason ? reasonId : undefined}
            >
              {values.types.length === 0 ? '시작' : mode === 'create' ? '만들기' : '다시 만들기'}
            </Button>
          </FloatingPanelFooter>
        </form>
      )}
    </div>
  );
}

/**
 * Every shown type's description behind one `?`. A Popover, not a Tooltip: the kit's Tooltip
 * opens on hover and keyboard focus only, never by a tap (UX12-MOCKFORM2-AC04).
 */
function VariationHelp({ types }: { readonly types: readonly VariationType[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          className={styles.helpButton}
          size="sm"
          variant="ghost"
          label="변형 유형 설명"
          icon={<span aria-hidden="true">?</span>}
        />
      </PopoverTrigger>
      <PopoverContent aria-label="변형 유형 설명" align="start">
        <dl className={styles.variationHelp}>
          {types.map((type) => (
            <div key={type}>
              <dt>{VARIATION_LABELS[type]}</dt>
              <dd>{VARIATION_DESCRIPTIONS[type]}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// --- 범위 step ---------------------------------------------------------------------------------

function useRangeStep(workspaceId: string, active: boolean, initialRange: MockRange | null) {
  const [api] = useState(() => createPracticeRunApi(workspaceId));
  const [filters, setFiltersState] = useState<RangeFilterState>(() =>
    initialRange ? filtersFromRange(initialRange) : EMPTY_RANGE_FILTERS,
  );
  const [groups, setGroups] = useState<RangeGroup[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retries, setRetries] = useState(0);
  // The saved range is applied once, to the first questions read (설정 바꾸기).
  const pendingRange = useRef<MockRange | null>(initialRange);
  // Until the person changes the selection or the filters, 설정 바꾸기 sends the saved range
  // itself: its intent (`전체 선택` with exclusions, chapters, single questions) is resolved
  // again by the server on every round (docs/screens/mock-exams.md "범위"), whereas a selection
  // recompressed from today's questions would turn, e.g., single ids covering everything into
  // `all`, which takes in questions added later.
  const [changed, setChanged] = useState(initialRange === null);
  const [touched, setTouched] = useState(false);
  const filtersKey = JSON.stringify(filters);
  const requestKey = `${filtersKey}:${retries}`;
  const busy = active && loadedKey !== requestKey;

  useEffect(() => {
    if (!active) return;
    let live = true;
    api.rangeQuestions(filters).then(
      (result) => {
        if (!live) return;
        setLoadedKey(requestKey);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(null);
        const next = rangeGroups(result.data);
        setGroups(next);
        const saved = pendingRange.current;
        pendingRange.current = null;
        // A filter hides questions: they leave the selection.
        setSelected((prev) => (saved ? selectionFromRange(next, saved) : keepVisible(prev, next)));
      },
      () => {
        if (!live) return;
        setLoadedKey(requestKey);
        setError(RUN_FAILURE_MESSAGES.unavailable);
      },
    );
    return () => {
      live = false;
    };
    // `filters` is read through its key: a new object with the same filters reads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, active, requestKey]);

  const count = groups ? keepVisible(selected, groups).size : 0;
  const request = !groups
    ? null
    : !changed && initialRange
      ? initialRange
      : rangeRequest(groups, selected, filters);
  return {
    groups,
    busy,
    error,
    retry: () => setRetries((n) => n + 1),
    selected,
    setSelected: (next: Set<string>) => {
      setChanged(true);
      setTouched(true);
      setSelected(next);
    },
    filters,
    setFilters: (next: RangeFilterState) => {
      setChanged(true);
      setTouched(true);
      setFiltersState(next);
    },
    touched,
    count,
    request,
  };
}
