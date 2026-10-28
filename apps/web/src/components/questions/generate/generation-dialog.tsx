'use client';

// QGEN-01-AC05 "문제 생성" dialog body (docs/screens/questions-generation.md, UX3c): opens at once
// and loads the workspace's CONFIRMED questions (skeleton meanwhile); picking one shows the
// generation form for it in the same dialog. "생성" starts the run (Idempotency-Key per settings)
// and goes to the review page `?source=&run=`, where progress, diffs, validation and
// registration continue — the review overlays its own compare drawer and editor, which do not fit
// inside a dialog. 보기 섞기 starts no run: the home opens the original's practice panel.
// QGEN-MULTI: tabs `한 문제` (the flow above, default) · `여러 문제` · `임의 선택` start a batch (one
// run per source) and go to the batch results page.
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listQuestionsAction } from '@/lib/questions/actions';
import { DEFAULT_FILTERS } from '@/lib/questions/filters';
import { QUESTION_TYPE_LABELS, type Question } from '@/lib/questions/form';
import {
  createGenerationClient,
  GenerationApiError,
  generatePath,
  type GenerationCreate,
} from '@/lib/questions/generation-client';
import { bodyKey } from '@/lib/questions/generation-model';
import type { ChapterChoice } from '@/lib/questions/overview-data';
import { MultiSourcePicker, RandomSourcePicker } from './generation-batch-pickers';
import { QuestionGenerationForm } from './question-generation-form';
import styles from './question-generation.module.css';

export interface GenerationDialogProps {
  readonly workspaceId: string;
  /** Archived workspaces cannot practise either (no shuffle). */
  readonly archived: boolean;
  /** 보기 섞기: open `questionId`'s practice panel on the home. */
  readonly onShuffle: (questionId: string) => void;
  /** Chapters of the workspace for the random pick's chapter filter. */
  readonly chapters?: readonly ChapterChoice[];
}

type Mode = 'one' | 'many' | 'random';
const NO_CHAPTERS: readonly ChapterChoice[] = [];

type Candidates =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly items: readonly Question[]; readonly more: boolean }
  | { readonly status: 'failed'; readonly message: string };

export function GenerationDialog({
  workspaceId,
  archived,
  onShuffle,
  chapters = NO_CHAPTERS,
}: GenerationDialogProps) {
  const [mode, setMode] = useState<Mode>('one');
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => setMode(value as Mode)}
      className={styles.modeTabs}
    >
      <TabsList aria-label="원본 고르는 방법">
        <TabsTrigger value="one">한 문제</TabsTrigger>
        <TabsTrigger value="many">여러 문제</TabsTrigger>
        <TabsTrigger value="random">임의 선택</TabsTrigger>
      </TabsList>
      <TabsContent value="one">
        <SingleSource workspaceId={workspaceId} archived={archived} onShuffle={onShuffle} />
      </TabsContent>
      <TabsContent value="many">
        <SourceList workspaceId={workspaceId}>
          {(items) => (
            <MultiSourcePicker
              workspaceId={workspaceId}
              candidates={items}
              returnTo={`/workspaces/${workspaceId}?panel=generate`}
            />
          )}
        </SourceList>
      </TabsContent>
      <TabsContent value="random">
        <RandomSourcePicker
          workspaceId={workspaceId}
          chapters={chapters}
          returnTo={`/workspaces/${workspaceId}?panel=generate`}
        />
      </TabsContent>
    </Tabs>
  );
}

function useCandidates(workspaceId: string) {
  const [candidates, setCandidates] = useState<Candidates>({ status: 'loading' });
  const load = useCallback(async () => {
    setCandidates({ status: 'loading' });
    try {
      const result = await listQuestionsAction(workspaceId, DEFAULT_FILTERS, null);
      setCandidates(
        result.ok
          ? { status: 'ok', items: result.data.items, more: result.data.nextCursor !== null }
          : { status: 'failed', message: result.message },
      );
    } catch {
      setCandidates({ status: 'failed', message: '문제 목록을 불러오지 못했습니다.' });
    }
  }, [workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  return { candidates, load } as const;
}

/** Loading / failure / empty states of the CONFIRMED question list; `children` renders the list. */
function SourceList({
  workspaceId,
  children,
}: {
  readonly workspaceId: string;
  readonly children: (items: readonly Question[]) => ReactNode;
}) {
  const { candidates, load } = useCandidates(workspaceId);
  const bank = `/workspaces/${workspaceId}/questions/bank`;

  if (candidates.status === 'loading') {
    return (
      <div aria-busy="true" className={styles.dialogBody}>
        <p role="status" className="qz-visually-hidden">
          문제 목록을 불러오는 중입니다.
        </p>
        <Skeleton shape="rect" height="3.5rem" />
        <Skeleton shape="rect" height="3.5rem" />
        <Skeleton shape="rect" height="3.5rem" />
      </div>
    );
  }

  if (candidates.status === 'failed') {
    return (
      <div role="alert" className={styles.failure}>
        <p>{candidates.message}</p>
        <Button size="sm" onClick={() => void load()}>
          다시 불러오기
        </Button>
      </div>
    );
  }

  if (candidates.items.length === 0) {
    return (
      <EmptyState
        headingLevel={3}
        title="변형할 확정 문제가 없습니다"
        description="전체 문제에서 문제를 등록하고 확정하면 여기에서 변형할 수 있습니다."
        action={
          <Button asChild variant="primary">
            <Link href={bank}>전체 문제로 이동</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className={styles.dialogBody}>
      {children(candidates.items)}
      {candidates.more ? (
        <p className={styles.muted}>
          최근 문제만 보여 줍니다. 다른 문제는 <Link href={bank}>전체 문제</Link>에서 찾아
          &lsquo;변형 출제&rsquo;를 누르거나 여러 문제를 골라 변형해 주세요.
        </p>
      ) : null}
    </div>
  );
}

function SingleSource({
  workspaceId,
  archived,
  onShuffle,
}: {
  readonly workspaceId: string;
  readonly archived: boolean;
  readonly onShuffle: (questionId: string) => void;
}) {
  const router = useRouter();
  const client = useMemo(() => createGenerationClient(), []);
  const [source, setSource] = useState<Question | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startKeys = useRef(new Map<string, string>());

  async function generate(body: GenerationCreate) {
    if (!source || starting) return;
    const keyOf = `${source.id}:${bodyKey(body)}`;
    let key = startKeys.current.get(keyOf);
    if (!key) {
      key = crypto.randomUUID();
      startKeys.current.set(keyOf, key);
    }
    setStarting(true);
    setError(null);
    try {
      const run = await client.startGeneration(source.id, body, key);
      startKeys.current.delete(keyOf);
      router.push(generatePath(workspaceId, source.id, run.id));
    } catch (failure) {
      setStarting(false);
      if (failure instanceof GenerationApiError && failure.kind === 'idempotencyKeyReused') {
        startKeys.current.delete(keyOf);
      }
      setError(
        `변형 생성을 시작하지 못했습니다. ${
          failure instanceof GenerationApiError ? failure.message : '다시 시도해 주세요.'
        }`,
      );
    }
  }

  if (source) {
    return (
      <div className={styles.dialogBody}>
        <Button
          size="sm"
          variant="ghost"
          className={styles.backButton}
          disabled={starting}
          onClick={() => {
            setSource(null);
            setError(null);
          }}
        >
          다른 문제 선택
        </Button>
        <section className={styles.source} aria-labelledby="qgen-dialog-source">
          <div className={styles.sourceHeader}>
            <h3 id="qgen-dialog-source" className={styles.sectionTitle}>
              원본 문제
            </h3>
            {source.question_number ? <Badge>{source.question_number}번</Badge> : null}
            <Badge>{QUESTION_TYPE_LABELS[source.question_type]}</Badge>
            {source.chapter ? <Badge>{source.chapter.title}</Badge> : null}
          </div>
          <p className={styles.sourceStem}>{source.revision.stem}</p>
        </section>
        <QuestionGenerationForm
          source={{
            questionType: source.question_type,
            confirmed: source.publication_status === 'CONFIRMED',
          }}
          canGenerate
          canShuffle={!archived}
          busy={starting}
          onShuffle={() => onShuffle(source.id)}
          onGenerate={(body) => void generate(body)}
        />
        {error ? (
          <p role="alert" className={styles.alert}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <SourceList workspaceId={workspaceId}>
      {(items) => (
        <>
          <p className={styles.muted}>
            변형할 확정 문제를 고르세요. 만든 변형은 원본과 비교해 검토하고 승인한 초안만 새 문제로
            등록됩니다.
          </p>
          <ul aria-label="원본으로 쓸 문제" className={styles.pickList}>
            {items.map((q) => (
              <li key={q.id}>
                <button type="button" className={styles.pickItem} onClick={() => setSource(q)}>
                  <span className={styles.pickMeta}>
                    {q.question_number ? <Badge>{q.question_number}번</Badge> : null}
                    <Badge>{QUESTION_TYPE_LABELS[q.question_type]}</Badge>
                    {q.chapter ? <span className={styles.muted}>{q.chapter.title}</span> : null}
                  </span>
                  <span className={styles.pickStem}>{q.revision.stem}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </SourceList>
  );
}
