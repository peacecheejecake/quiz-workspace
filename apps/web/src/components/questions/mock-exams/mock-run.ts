'use client';

// A mock exam's `풀기` (MOCK-01, QVIEW-01 call site 8): the home's range run panel (QuestionViewer
// sequence) with `source=mock`. The run API is the bank's (`/practice-runs`, MOCK-P); what differs
// is the range step (the questions the mock exam lists now grouped by source chapter, no filters,
// all selected; a whole chapter goes out as question ids), the start
// (`source=mock` + `mock_exam_id`), and the positions' sessions and submissions (the mock practice
// routes). Only the range step's URL says which source a run is (`?practice=new&source=mock`):
// later steps learn it from the run itself (GET /practice-runs/{id} → `source`), so a reload or a
// link of a mock run position keeps practising the mock exam.
import { useEffect, useMemo, useState } from 'react';
import { createPracticeRunApi, RUN_BFF_PATHS } from '@/lib/questions/practice-run-client';
import {
  classifyRunFailure,
  RUN_FAILURE_MESSAGES,
  type RunActionResult,
} from '@/lib/questions/practice-run-problems';
import type { PracticeRun, RunRange, RunSource, RunUrlState } from '@/lib/questions/practice-runs';
import type { QuestionOverview } from '@/lib/questions/overview-data';
import { bankRunClient, type RunClient } from '../viewer/question-viewer';
import { createMockExamApi, createMockPracticeApi } from './mock-exam-client';
import type { MockExamQuestion } from './mock-exam-model';

/** The range step's group of the questions whose source has no chapter (or was deleted). */
export const MOCK_NO_CHAPTER_TITLE = '챕터 없음';

/**
 * A mock exam's questions as the range step reads a Heatmap overview (QVIEW-01 "진입 (mock)"):
 * grouped by their source chapter (`source.chapter`) in the generation plan's chapter rank, the
 * questions without one (no chapter, deleted source) last; each question keeps its number in the
 * mock exam ("문제 k", k in mock exam order) and its order within its group.
 */
export function mockRangeOverview(
  questions: readonly MockExamQuestion[],
): Pick<QuestionOverview, 'chapters' | 'items'> {
  const numbered = questions.map((q, i) => ({ q, k: i + 1, chapter: q.source.chapter ?? null }));
  interface Group {
    id: string | null;
    rank: number;
    first: number;
    title: string;
    number: number | null;
    count: number;
  }
  const groups = new Map<string | null, Group>();
  for (const { chapter, k } of numbered) {
    const id = chapter?.id ?? null;
    const group = groups.get(id);
    if (group) {
      group.count += 1;
      if (chapter && chapter.rank < group.rank) group.rank = chapter.rank;
      continue;
    }
    groups.set(id, {
      id,
      rank: chapter ? chapter.rank : Number.POSITIVE_INFINITY,
      first: k,
      title: chapter ? chapter.title : MOCK_NO_CHAPTER_TITLE,
      number: chapter?.number ?? null,
      count: 1,
    });
  }
  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank || a.first - b.first);
  return {
    chapters: ordered.map((g) => ({
      id: g.id,
      title: g.title,
      number: g.number,
      document_id: null,
      question_count: g.count,
    })),
    items: numbered.map(({ q, k, chapter }) => ({
      question_id: q.id,
      chapter_id: chapter?.id ?? null,
      question_number: k,
      question_type: q.question_type,
      preview: q.stem,
      status: 'unseen',
      is_favorite: false,
      needs_retry: false,
      is_pending_grading: false,
      last_graded_result: null,
    })),
  };
}

type FetchLike = typeof fetch;

/** A run's source and mock exam, learnt from its creation or a read of it. */
export interface RunInfo {
  readonly source: RunSource;
  readonly mockExamId: string | null;
}

/** What this page learnt of each run. */
const runInfos = new Map<string, RunInfo>();

export function rememberRun(run: Pick<PracticeRun, 'id' | 'source' | 'mock_exam_id'>): void {
  runInfos.set(run.id.toLowerCase(), {
    source: run.source,
    mockExamId: run.mock_exam_id ?? null,
  });
}

export function knownRun(runId: string): RunInfo | undefined {
  return runInfos.get(runId.toLowerCase());
}

/**
 * Which source each practice session of this page belongs to. Page-wide, not per client: the run
 * panel replaces its client when a reloaded run's mock exam becomes known, while a position read
 * by the earlier client still decides where its pending session is self-graded.
 */
const sessionSources = new Map<string, RunSource>();

/**
 * The run client of the home's run panel: the bank's, except that a mock run lists, starts,
 * opens and submits through the mock exam routes. `mockExamId` is the mock exam a new run starts
 * from (the range step's, or the shown run's for `처음부터 다시`); positions follow their run's
 * own `source`.
 */
export function homeRunClient(
  workspaceId: string,
  mockExamId: string | null,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): RunClient {
  const bank = bankRunClient(workspaceId);
  const runs = createPracticeRunApi(workspaceId, fetchImpl);
  const exams = createMockExamApi(workspaceId, fetchImpl);
  const mock = createMockPracticeApi(workspaceId, fetchImpl);

  async function sourceOf(runId: string): Promise<RunSource> {
    const known = knownRun(runId);
    if (known) return known.source;
    const run = await runs.getRun(runId);
    if (!run.ok) return 'bank';
    rememberRun(run.data);
    return run.data.source;
  }

  async function createMockRun(
    examId: string,
    range: RunRange,
    randomOrder: boolean,
    key: string,
  ): Promise<RunActionResult<PracticeRun>> {
    let response: Response;
    try {
      response = await fetchImpl(RUN_BFF_PATHS.create(workspaceId), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          source: 'mock',
          mock_exam_id: examId,
          range,
          random_order: randomOrder,
        }),
      });
    } catch {
      return { ok: false, kind: 'unavailable', message: RUN_FAILURE_MESSAGES.unavailable };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const kind = classifyRunFailure(response.status, body);
      return { ok: false, kind, message: RUN_FAILURE_MESSAGES[kind] };
    }
    const run = body as PracticeRun;
    if (run.workspace_id?.toLowerCase() !== workspaceId.toLowerCase()) {
      return { ok: false, kind: 'notFound', message: RUN_FAILURE_MESSAGES.notFound };
    }
    return { ok: true, data: run };
  }

  return {
    ...bank,
    async listRange(filters) {
      if (!mockExamId) return bank.listRange(filters);
      const result = await exams.questions(mockExamId, false);
      if (result.ok) return { ok: true, data: mockRangeOverview(result.data) };
      const kind = result.kind === 'notFound' ? 'notFound' : 'unavailable';
      return { ok: false, kind, message: RUN_FAILURE_MESSAGES[kind] };
    },
    async create(range, randomOrder, key, shuffleOptions) {
      const result = mockExamId
        ? await createMockRun(mockExamId, range, randomOrder, key)
        : await bank.create(range, randomOrder, key, shuffleOptions);
      if (result.ok) rememberRun(result.data);
      return result;
    },
    async getRun(runId) {
      const result = await bank.getRun(runId);
      if (result.ok) rememberRun(result.data);
      return result;
    },
    async getItem(runId, position) {
      const result = await bank.getItem(runId, position);
      if (result.ok && result.data.practice_session_id) {
        sessionSources.set(result.data.practice_session_id, await sourceOf(runId));
      }
      return result;
    },
    async openSession(questionId, runId, position, key) {
      if ((await sourceOf(runId)) === 'bank') {
        return bank.openSession(questionId, runId, position, key);
      }
      const result = await mock.openSession(questionId, runId, position, key);
      if (result.ok) {
        sessionSources.set(result.data.id, 'mock');
        return result;
      }
      // The run panel tells session failures in its run words.
      const kind =
        result.kind === 'alreadySubmitted'
          ? 'alreadySubmitted'
          : result.kind === 'notFound'
            ? 'notFound'
            : result.kind === 'archived'
              ? 'archived'
              : 'unavailable';
      return { ok: false, kind, message: RUN_FAILURE_MESSAGES[kind] };
    },
    submit: (sessionId, answer) =>
      sessionSources.get(sessionId) === 'mock'
        ? mock.submit(sessionId, answer)
        : bank.submit(sessionId, answer),
    selfGrade: (sessionId, grade) =>
      sessionSources.get(sessionId) === 'mock'
        ? mock.selfGrade(sessionId, grade)
        : bank.selfGrade(sessionId, grade),
    reopenPosition: (runId, position) => bank.reopenPosition(runId, position),
    async openRetrySession(runId, position, key, epoch) {
      const result = await bank.openRetrySession(runId, position, key, epoch);
      if (result.ok) sessionSources.set(result.data.id, await sourceOf(runId));
      return result;
    },
  };
}

export interface HomeRun {
  /** The run's source: the range step's URL, else the run's own (`bank` until it is known). */
  readonly source: RunSource;
  readonly client: RunClient;
  /** The range step's title: "<모의고사 이름> 풀기" for a mock exam. */
  readonly pickerTitle: string | undefined;
}

/** The run panel's source, client and title for the URL's run state (see the module comment). */
export function useHomeRun(workspaceId: string, state: RunUrlState | null): HomeRun {
  const pickerMock = state?.step === 'picker' && state.source === 'mock' ? state.mockExamId : null;
  const runId = state?.step === 'solve' || state?.step === 'results' ? state.runId : null;

  // A run's source when this page did not create or read it yet (a reload, a link).
  const [learnt, setLearnt] = useState<RunInfo & { runId: string }>();
  useEffect(() => {
    if (!runId || knownRun(runId)) return;
    let live = true;
    void createPracticeRunApi(workspaceId)
      .getRun(runId)
      .then((run) => {
        if (!live || !run.ok) return;
        rememberRun(run.data);
        setLearnt({ runId, source: run.data.source, mockExamId: run.data.mock_exam_id ?? null });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, runId]);
  const info = runId
    ? (knownRun(runId) ?? (learnt?.runId === runId ? learnt : undefined))
    : undefined;
  const startMock = pickerMock ?? (info?.source === 'mock' ? info.mockExamId : null);
  const client = useMemo(() => homeRunClient(workspaceId, startMock), [workspaceId, startMock]);

  // The mock exam's name for the range step's title.
  const [title, setTitle] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!pickerMock) return;
    let live = true;
    void createMockExamApi(workspaceId)
      .get(pickerMock)
      .then((exam) => {
        if (live && exam.ok) setTitle({ id: pickerMock, title: exam.data.title });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, pickerMock]);

  const source: RunSource = state?.step === 'picker' ? state.source : (info?.source ?? 'bank');
  const pickerTitle =
    state?.step === 'picker' && state.source === 'mock'
      ? `${title && title.id === pickerMock ? title.title : '모의고사'} 풀기`
      : undefined;
  return { source, client, pickerTitle };
}
