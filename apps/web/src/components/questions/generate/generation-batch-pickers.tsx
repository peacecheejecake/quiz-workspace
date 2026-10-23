'use client';

// QGEN-MULTI tabs of the "문제 생성" dialog (docs/screens/questions-generation.md "묶음 변형
// 출제"): `여러 문제` (check several CONFIRMED questions) and `임의 선택` (a count and filters; the
// server picks). Both submit the same generation form (no 보기 섞기) as one batch and go to the
// batch results page.
import { Badge, Checkbox, Input, Select } from '@quiz/ui';
import { useId, useState } from 'react';
import { QUESTION_TYPE_LABELS, QUESTION_TYPES, type Question } from '@/lib/questions/form';
import type { GenerationCreate } from '@/lib/questions/generation-client';
import {
  batchCostProblem,
  DEFAULT_RANDOM_FILTERS,
  MAX_BATCH_SOURCES,
  randomSelection,
  STUDY_STATUS_LABELS,
  STUDY_STATUS_ORDER,
  toggleSource,
  type RandomPickFilters,
} from '@/lib/questions/generation-model';
import type { ChapterChoice } from '@/lib/questions/overview-data';
import { QuestionGenerationForm } from './question-generation-form';
import { useBatchStart } from './use-batch-start';
import styles from './question-generation.module.css';

const ALL = '__all__';
const BATCH_SOURCE = { questionType: 'MCQ', confirmed: true } as const;

function BatchError({ message }: { readonly message: string | null }) {
  return message ? (
    <p role="alert" className={styles.alert}>
      {message}
    </p>
  ) : null;
}

export function MultiSourcePicker({
  workspaceId,
  candidates,
  returnTo,
}: {
  readonly workspaceId: string;
  readonly candidates: readonly Question[];
  readonly returnTo: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const batch = useBatchStart(workspaceId, returnTo);
  const full = selected.length >= MAX_BATCH_SOURCES;
  const countId = useId();

  function generate(body: GenerationCreate) {
    if (selected.length === 0) {
      setProblem('변형할 문제를 하나 이상 골라 주세요.');
      return;
    }
    const cost = batchCostProblem(selected.length, body);
    setProblem(cost);
    if (cost) return;
    void batch.start({ ...body, selection: { mode: 'selected', question_ids: selected } });
  }

  return (
    <div className={styles.dialogBody}>
      <p className={styles.muted}>
        변형할 확정 문제를 최대 {MAX_BATCH_SOURCES}개까지 고르세요. 문제마다 같은 설정으로 초안을
        만들고, 원본별로 검토해 승인한 초안만 등록됩니다.
      </p>
      <p id={countId} role="status" className={styles.selectionCount}>
        {selected.length}개 선택됨
        {full ? ` · 최대 ${MAX_BATCH_SOURCES}개까지 고를 수 있습니다` : ''}
      </p>
      <ul aria-label="변형할 문제 선택" aria-describedby={countId} className={styles.pickList}>
        {candidates.map((q) => {
          const checked = selected.includes(q.id);
          return (
            <li key={q.id} className={styles.checkItem}>
              <Checkbox
                checked={checked}
                disabled={batch.starting || (full && !checked)}
                onCheckedChange={(on) => {
                  setSelected((s) => toggleSource(s, q.id, on === true));
                  setProblem(null);
                }}
                label={
                  <span className={styles.checkLabel}>
                    <span className={styles.pickMeta}>
                      {q.question_number ? <Badge>{q.question_number}번</Badge> : null}
                      <Badge>{QUESTION_TYPE_LABELS[q.question_type]}</Badge>
                      {q.chapter ? <span className={styles.muted}>{q.chapter.title}</span> : null}
                    </span>
                    <span className={styles.pickStem}>{q.revision.stem}</span>
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
      <QuestionGenerationForm
        source={BATCH_SOURCE}
        canGenerate
        canShuffle={false}
        allowShuffle={false}
        busy={batch.starting}
        onShuffle={() => undefined}
        onGenerate={generate}
      />
      <BatchError message={problem ?? batch.error} />
    </div>
  );
}

export function RandomSourcePicker({
  workspaceId,
  chapters,
  returnTo,
}: {
  readonly workspaceId: string;
  readonly chapters: readonly ChapterChoice[];
  readonly returnTo: string;
}) {
  const [filters, setFilters] = useState<RandomPickFilters>(DEFAULT_RANDOM_FILTERS);
  const [countError, setCountError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const batch = useBatchStart(workspaceId, returnTo);
  const disabled = batch.starting;

  function patch(next: Partial<RandomPickFilters>) {
    setFilters((f) => ({ ...f, ...next }));
    setProblem(null);
    batch.clearError();
  }

  function generate(body: GenerationCreate) {
    const selection = randomSelection(filters);
    if (!selection) {
      setCountError(`1~${MAX_BATCH_SOURCES} 사이의 숫자로 입력해 주세요.`);
      return;
    }
    const cost = batchCostProblem(selection.count, body);
    setProblem(cost);
    if (cost) return;
    void batch.start({ ...body, selection });
  }

  return (
    <div className={styles.dialogBody}>
      <p className={styles.muted}>
        조건에 맞는 확정 문제 중에서 서버가 정한 개수만큼 임의로 골라 변형합니다. 풀이 상태와
        즐겨찾기는 내 기록을 기준으로 합니다.
      </p>
      <div role="group" aria-label="임의 선택 조건" className={styles.randomFields}>
        <Input
          label="문제 수"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_BATCH_SOURCES}
          value={filters.count}
          disabled={disabled}
          description={`1~${MAX_BATCH_SOURCES}개`}
          error={countError ?? undefined}
          onChange={(event) => {
            patch({ count: event.target.value });
            setCountError(null);
          }}
          fieldClassName={styles.countField}
        />
        <Select
          label="챕터"
          value={filters.chapter ?? ALL}
          disabled={disabled}
          options={[
            { value: ALL, label: '전체 챕터' },
            ...chapters.map((c) => ({ value: c.value, label: c.title })),
          ]}
          onValueChange={(value) => patch({ chapter: value === ALL ? null : value })}
        />
        <Select
          label="유형"
          value={filters.questionType ?? ALL}
          disabled={disabled}
          options={[
            { value: ALL, label: '전체 유형' },
            ...QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] })),
          ]}
          onValueChange={(value) =>
            patch({
              questionType: value === ALL ? null : (value as (typeof QUESTION_TYPES)[number]),
            })
          }
        />
      </div>
      <fieldset className={styles.variations}>
        <legend className={styles.legendTitle}>풀이 상태</legend>
        <p className={styles.muted}>고르지 않으면 모든 상태에서 고릅니다.</p>
        {STUDY_STATUS_ORDER.map((status) => (
          <Checkbox
            key={status}
            label={STUDY_STATUS_LABELS[status]}
            checked={filters.statuses.includes(status)}
            disabled={disabled}
            onCheckedChange={(on) =>
              patch({
                statuses:
                  on === true
                    ? [...filters.statuses.filter((s) => s !== status), status]
                    : filters.statuses.filter((s) => s !== status),
              })
            }
          />
        ))}
        <Checkbox
          label="즐겨찾기만"
          checked={filters.favoriteOnly}
          disabled={disabled}
          onCheckedChange={(on) => patch({ favoriteOnly: on === true })}
        />
      </fieldset>
      <QuestionGenerationForm
        source={BATCH_SOURCE}
        canGenerate
        canShuffle={false}
        allowShuffle={false}
        busy={batch.starting}
        onShuffle={() => undefined}
        onGenerate={generate}
      />
      <BatchError message={problem ?? batch.error} />
    </div>
  );
}
