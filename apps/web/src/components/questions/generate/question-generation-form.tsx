'use client';

// QuestionGenerationForm (docs/design-system.md component list, docs/questions.md §5): choose
// the variation(s) of the source question, the number of candidates per variation and an
// optional target difficulty, then "생성". 보기 섞기 is exclusive with the LLM variations: it
// opens the original's practice panel instead of starting a run (no new question, no new dot).
//
// Accessibility: the variations are a labelled group of checkboxes ("변형 유형"), each with a
// description; an unavailable variation stays visible, disabled, with the reason as text.
import { Button, Checkbox, Input, Select } from '@quiz/ui';
import { useId, useState, type FormEvent } from 'react';
import type {
  GenerationCreate,
  GenerationDifficulty,
  VariationType,
} from '@/lib/questions/generation-client';
import {
  CANDIDATE_COUNT_MAX,
  CANDIDATE_COUNT_MIN,
  DIFFICULTY_LABELS,
  generationRequest,
  toggleVariation,
  VARIATION_DESCRIPTIONS,
  VARIATION_LABELS,
  VARIATION_ORDER,
  variationBlocker,
  type GenerationSourceFacts,
} from '@/lib/questions/generation-model';
import styles from './question-generation.module.css';

export interface QuestionGenerationFormProps {
  readonly source: GenerationSourceFacts;
  /** No LLM variations (viewer, archived workspace); shuffling stays available unless archived. */
  readonly canGenerate: boolean;
  readonly canShuffle: boolean;
  /** A run is being started or followed. */
  readonly busy: boolean;
  readonly onShuffle: () => void;
  readonly onGenerate: (body: GenerationCreate) => void;
}

const SAME_DIFFICULTY = 'none';

export function QuestionGenerationForm({
  source,
  canGenerate,
  canShuffle,
  busy,
  onShuffle,
  onGenerate,
}: QuestionGenerationFormProps) {
  const [selected, setSelected] = useState<VariationType[]>([]);
  const [count, setCount] = useState('1');
  const [difficulty, setDifficulty] = useState<GenerationDifficulty | null>(null);
  const [error, setError] = useState<{ field: 'variations' | 'count'; message: string } | null>(
    null,
  );
  const errorId = useId();
  const shuffling = selected.includes('OPTION_SHUFFLE');

  function blocker(type: VariationType): string | null {
    const reason = variationBlocker(type, source);
    if (reason) return reason;
    if (type === 'OPTION_SHUFFLE')
      return canShuffle ? null : '보관된 Workspace에서는 풀 수 없습니다.';
    return canGenerate ? null : '편집 권한이 있어야 변형 초안을 만들 수 있습니다.';
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const request = generationRequest(selected, count, difficulty);
    if (request.kind === 'invalid') {
      setError({ field: request.field, message: request.message });
      return;
    }
    setError(null);
    if (request.kind === 'shuffle') onShuffle();
    else onGenerate(request.body);
  }

  const anyAvailable = VARIATION_ORDER.some((t) => blocker(t) === null);

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <fieldset
        className={styles.variations}
        aria-describedby={error?.field === 'variations' ? errorId : undefined}
      >
        <legend className={styles.legendTitle}>변형 유형</legend>
        {VARIATION_ORDER.map((type) => {
          const reason = blocker(type);
          return (
            <Checkbox
              key={type}
              label={VARIATION_LABELS[type]}
              description={reason ?? VARIATION_DESCRIPTIONS[type]}
              checked={selected.includes(type)}
              disabled={reason !== null || busy}
              onCheckedChange={(checked) => {
                setSelected((s) => toggleVariation(s, type, checked === true));
                setError(null);
              }}
            />
          );
        })}
      </fieldset>

      <div className={styles.formRow}>
        <Input
          label="변형별 후보 수"
          type="number"
          inputMode="numeric"
          min={CANDIDATE_COUNT_MIN}
          max={CANDIDATE_COUNT_MAX}
          value={count}
          disabled={shuffling || busy || !canGenerate}
          description={`${CANDIDATE_COUNT_MIN}~${CANDIDATE_COUNT_MAX}개`}
          error={error?.field === 'count' ? error.message : undefined}
          onChange={(event) => {
            setCount(event.target.value);
            if (error?.field === 'count') setError(null);
          }}
          fieldClassName={styles.countField}
        />
        <Select
          label="난이도"
          value={difficulty ?? SAME_DIFFICULTY}
          disabled={shuffling || busy || !canGenerate}
          options={[
            { value: SAME_DIFFICULTY, label: '지정 안 함' },
            ...(Object.keys(DIFFICULTY_LABELS) as GenerationDifficulty[]).map((value) => ({
              value,
              label: DIFFICULTY_LABELS[value],
            })),
          ]}
          onValueChange={(value) =>
            setDifficulty(value === SAME_DIFFICULTY ? null : (value as GenerationDifficulty))
          }
          fieldClassName={styles.difficultyField}
        />
      </div>

      {error?.field === 'variations' ? (
        <p id={errorId} role="alert" className={styles.alert}>
          {error.message}
        </p>
      ) : null}

      <div className={styles.formActions}>
        <Button type="submit" variant="primary" disabled={!anyAvailable || busy} loading={busy}>
          생성
        </Button>
        <p className={styles.muted}>
          {shuffling
            ? '원본 문제를 섞인 보기 순서로 엽니다. 풀이 기록은 원본 문제에 남습니다.'
            : '만든 변형은 초안으로만 저장됩니다. 검토하고 승인한 초안만 문제은행에 등록됩니다.'}
        </p>
      </div>
    </form>
  );
}
