// Browser side of MOCK-01 (the 모의고사 dialog) and of a mock exam run (QuestionViewer sequence,
// `source=mock`, MOCK-P). Calls go to this app's own `/api/...` route handlers (src/app/api,
// lib/documents/bff.ts), which attach the session's access token server-side: browser code never
// holds a JWT. FastAPI stays the authority: membership and roles, archived = read-only, the range
// resolved to this workspace's live CONFIRMED questions, the limits, and no answers to viewers or
// before a submission (MOCK-01-C05, QVIEW-01-C03).
import type { Schemas } from '@quiz/api-client';
import type {
  PracticeSession,
  PracticeSubmission,
  SelfGradeResult,
  StudyActionResult,
  SubmitResult,
} from '@/lib/questions/practice-actions';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import type {
  MockExam,
  MockExamConfig,
  MockExamList,
  MockExamQuestion,
  MockRange,
} from './mock-exam-model';

const PROBLEM = 'urn:quiz-workspace:problem:';

/** Why a mock exam call failed, as the dialog tells it. */
export type MockFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'archived'
  | 'notFound'
  | 'noMatching'
  | 'running'
  | 'busy'
  | 'llmDisabled'
  | 'rateLimited'
  | 'staleRevision'
  | 'invalid'
  | 'unavailable';

export const MOCK_FAILURE_MESSAGES: Readonly<Record<MockFailureKind, string>> = {
  unauthenticated: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  forbidden: '편집 권한이 있어야 사용할 수 있습니다.',
  archived: '보관된 Workspace는 읽기 전용입니다.',
  notFound: '모의고사를 찾을 수 없습니다.',
  noMatching: '범위에 맞는 확정 문제가 없습니다.',
  running: '이 모의고사의 문제를 아직 만드는 중입니다. 끝난 뒤 다시 시도하세요.',
  busy: '이 Workspace에서 만드는 모의고사가 많습니다. 끝난 뒤 다시 시도하세요.',
  llmDisabled: '이 환경에서는 AI 변형을 쓸 수 없습니다.',
  rateLimited: '모의고사를 너무 자주 만들었습니다. 잠시 후 다시 시도하세요.',
  staleRevision: '다른 곳에서 이 문제가 바뀌었습니다. 다시 열어 최신 내용으로 편집하세요.',
  invalid: '입력한 내용을 확인해 주세요.',
  unavailable: '일시적인 오류로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export type MockResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: MockFailureKind; readonly message: string };

function problemType(body: unknown): string | undefined {
  const type = (body as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' ? type : undefined;
}

/** An API failure as the dialog tells it (RFC 9457 problems, MOCK-01-C05/C06). */
export function classifyMockFailure(status: number, body: unknown): MockFailureKind {
  const type = problemType(body);
  if (status === 401) return 'unauthenticated';
  if (status === 403) return type === `${PROBLEM}workspace-archived` ? 'archived' : 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) {
    if (type === `${PROBLEM}no-matching-questions`) return 'noMatching';
    if (type === `${PROBLEM}mock-generation-running`) return 'running';
    if (type === `${PROBLEM}generation-busy`) return 'busy';
    if (type === `${PROBLEM}mock-llm-disabled`) return 'llmDisabled';
    if (type === `${PROBLEM}stale-revision`) return 'staleRevision';
    return 'unavailable';
  }
  if (status === 422 || status === 400) return 'invalid';
  if (status === 429) return 'rateLimited';
  return 'unavailable';
}

export const MOCK_BFF_PATHS = {
  list: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/mock-exams`,
  exam: (id: string) => `/api/mock-exams/${encodeURIComponent(id)}`,
  generations: (id: string) => `/api/mock-exams/${encodeURIComponent(id)}/generations`,
  questions: (id: string, answers: boolean) =>
    `/api/mock-exams/${encodeURIComponent(id)}/questions${answers ? '?include=answers' : ''}`,
  question: (id: string) => `/api/mock-exam-questions/${encodeURIComponent(id)}`,
  session: (questionId: string) =>
    `/api/mock-exam-questions/${encodeURIComponent(questionId)}/practice-sessions`,
  submit: (sessionId: string) =>
    `/api/mock-practice-sessions/${encodeURIComponent(sessionId)}/submit`,
  selfGrade: (sessionId: string) =>
    `/api/mock-practice-sessions/${encodeURIComponent(sessionId)}/self-grade`,
} as const;

type FetchLike = typeof fetch;

interface CallInit {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly key?: string;
}

interface Raw {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

async function send(fetchImpl: FetchLike, path: string, init: CallInit): Promise<Raw | null> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.key ? { 'idempotency-key': init.key } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return null;
  }
  if (response.status === 204) return { ok: true, status: 204, body: undefined };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) return null;
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

export interface MockExamApi {
  list(): Promise<MockResult<MockExamList>>;
  get(id: string): Promise<MockResult<MockExam>>;
  create(
    body: { title: string; config: MockExamConfig; range: MockRange },
    key: string,
  ): Promise<MockResult<MockExam>>;
  /** 설정 바꾸기 (new config and range), 다시 만들기 / 다시 시도 (nothing). */
  regenerate(
    id: string,
    body: { config?: MockExamConfig; range?: MockRange },
    key: string,
  ): Promise<MockResult<MockExam>>;
  rename(id: string, title: string): Promise<MockResult<MockExam>>;
  remove(id: string): Promise<MockResult<null>>;
  questions(id: string, answers: boolean): Promise<MockResult<readonly MockExamQuestion[]>>;
  editQuestion(
    id: string,
    body: Schemas['MockExamQuestionUpdate'],
  ): Promise<MockResult<MockExamQuestion>>;
  removeQuestion(id: string): Promise<MockResult<null>>;
}

/** The mock exam API of `workspaceId` through the BFF (another workspace's is not found). */
export function createMockExamApi(
  workspaceId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): MockExamApi {
  async function call<T>(path: string, init: CallInit = {}): Promise<MockResult<T>> {
    const raw = await send(fetchImpl, path, init);
    if (raw === null) return failed('unavailable');
    if (!raw.ok) return failed(classifyMockFailure(raw.status, raw.body));
    return { ok: true, data: raw.body as T };
  }
  function failed<T>(kind: MockFailureKind): MockResult<T> {
    return { ok: false, kind, message: MOCK_FAILURE_MESSAGES[kind] };
  }
  /** A mock exam of another workspace is never shown on this home. */
  function own(result: MockResult<MockExam>): MockResult<MockExam> {
    if (result.ok && result.data.workspace_id.toLowerCase() !== workspaceId.toLowerCase()) {
      return failed('notFound');
    }
    return result;
  }
  return {
    list: () => call<MockExamList>(MOCK_BFF_PATHS.list(workspaceId)),
    get: async (id) => own(await call<MockExam>(MOCK_BFF_PATHS.exam(id))),
    create: async (body, key) =>
      own(await call<MockExam>(MOCK_BFF_PATHS.list(workspaceId), { method: 'POST', body, key })),
    regenerate: async (id, body, key) =>
      own(await call<MockExam>(MOCK_BFF_PATHS.generations(id), { method: 'POST', body, key })),
    rename: async (id, title) =>
      own(await call<MockExam>(MOCK_BFF_PATHS.exam(id), { method: 'PATCH', body: { title } })),
    remove: async (id) => {
      const result = await call<unknown>(MOCK_BFF_PATHS.exam(id), { method: 'DELETE' });
      return result.ok ? { ok: true, data: null } : result;
    },
    questions: async (id, answers) => {
      const result = await call<{ items: MockExamQuestion[] }>(
        MOCK_BFF_PATHS.questions(id, answers),
      );
      return result.ok
        ? { ok: true, data: [...result.data.items].sort((a, b) => a.position - b.position) }
        : result;
    },
    editQuestion: (id, body) =>
      call<MockExamQuestion>(MOCK_BFF_PATHS.question(id), { method: 'PATCH', body }),
    removeQuestion: async (id) => {
      const result = await call<unknown>(MOCK_BFF_PATHS.question(id), { method: 'DELETE' });
      return result.ok ? { ok: true, data: null } : result;
    },
  };
}

// --- mock exam practice (MOCK-P) ------------------------------------------------------------------

export type MockPracticeSession = Schemas['MockPracticeSession'];
export type MockSubmitResult = Schemas['MockSubmitResult'];

function studyFailure(status: number, body: unknown): QuestionFailureKind {
  const type = problemType(body);
  if (status === 401) return 'unauthenticated';
  if (status === 403) return type === `${PROBLEM}workspace-archived` ? 'archived' : 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) {
    if (type === `${PROBLEM}practice-session-not-pending`) return 'notPending';
    return 'alreadySubmitted';
  }
  if (status === 422 || status === 400) return 'invalid';
  return 'unavailable';
}

function studyFailed<T>(kind: QuestionFailureKind): StudyActionResult<T> {
  return { ok: false, kind, message: QUESTION_FAILURE_MESSAGES[kind] };
}

/** A mock session as the run's solve step reads a practice session (the same fields). */
export function sessionFromMock(s: MockPracticeSession): PracticeSession {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    question_id: s.mock_exam_question_id,
    question_revision_id: s.revision_id,
    question_number: null,
    question_type: s.question_type,
    chapter_id: null,
    stem: s.stem,
    stem_tables: s.stem_tables,
    is_multi_answer: s.is_multi_answer,
    displayed_option_ids: s.displayed_option_ids,
    options: s.options,
    state: s.state,
    opened_at: s.opened_at,
    practice_run_id: s.practice_run_id ?? null,
    run_position: s.run_position ?? null,
  };
}

export function submitFromMock(r: MockSubmitResult): SubmitResult {
  return {
    attempt_id: r.attempt_id,
    practice_session_id: r.practice_session_id,
    question_revision_id: r.revision_id,
    state: r.state,
    result: r.result,
    correct_option_ids: r.correct_option_ids ?? null,
    accepted_answers: r.accepted_answers ?? null,
    explanation: r.explanation ?? null,
    rubric: r.rubric ?? null,
  };
}

export interface MockPracticeApi {
  openStandaloneSession(
    questionId: string,
    key: string,
  ): Promise<StudyActionResult<PracticeSession>>;
  openSession(
    questionId: string,
    runId: string,
    position: number,
    key: string,
  ): Promise<StudyActionResult<PracticeSession>>;
  submit(sessionId: string, answer: PracticeSubmission): Promise<StudyActionResult<SubmitResult>>;
  selfGrade(
    sessionId: string,
    result: 'correct' | 'incorrect',
  ): Promise<StudyActionResult<SelfGradeResult>>;
}

export function createMockPracticeApi(
  workspaceId: string,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): MockPracticeApi {
  async function call<T>(path: string, init: CallInit): Promise<StudyActionResult<T>> {
    const raw = await send(fetchImpl, path, init);
    if (raw === null) return studyFailed('unavailable');
    if (!raw.ok) return studyFailed(studyFailure(raw.status, raw.body));
    return { ok: true, data: raw.body as T };
  }
  async function open(
    questionId: string,
    key: string,
    body: object,
  ): Promise<StudyActionResult<PracticeSession>> {
    const result = await call<MockPracticeSession>(MOCK_BFF_PATHS.session(questionId), {
      method: 'POST',
      body,
      key,
    });
    if (!result.ok) return result;
    if (result.data.workspace_id.toLowerCase() !== workspaceId.toLowerCase())
      return studyFailed('notFound');
    return { ok: true, data: sessionFromMock(result.data) };
  }
  return {
    openStandaloneSession: (questionId, key) => open(questionId, key, {}),
    async openSession(questionId, runId, position, key) {
      return open(questionId, key, { practice_run_id: runId, run_position: position });
    },
    async submit(sessionId, answer) {
      const result = await call<MockSubmitResult>(MOCK_BFF_PATHS.submit(sessionId), {
        method: 'POST',
        body: answer,
      });
      if (!result.ok) return result;
      if (result.data.practice_session_id !== sessionId) return studyFailed('notFound');
      return { ok: true, data: submitFromMock(result.data) };
    },
    async selfGrade(sessionId, grade) {
      const result = await call<SelfGradeResult>(MOCK_BFF_PATHS.selfGrade(sessionId), {
        method: 'POST',
        body: { result: grade },
      });
      if (!result.ok) return result;
      if (result.data.practice_session_id !== sessionId) return studyFailed('notFound');
      return result;
    },
  };
}
