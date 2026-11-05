// AIEXPL-01 AI 해설 area: pure view-model helpers (docs/screens/ai-explanations.md "레이아웃 및
// 컴포넌트", "화면 상태"). No I/O here; components/questions/ai-explanation renders what these return.
import type {
  Explanation,
  ExplanationFailureKind,
  ExplanationSource,
  ExplanationState,
} from './client';

export const EXPL_TEXT = {
  title: 'AI 해설',
  create: 'AI 해설',
  show: 'AI 해설 보기',
  working: 'AI 해설을 만드는 중',
  started: 'AI 해설을 만드는 중입니다',
  ready: 'AI 해설이 준비되었습니다',
  badge: 'AI 생성',
  notice: 'AI가 만든 해설입니다. 정답과 기존 해설이 기준이며, 틀릴 수 있습니다.',
  disabled: '이 환경에서는 AI 해설을 사용할 수 없습니다.',
  archived: '보관된 Workspace에서는 새 AI 해설을 만들 수 없습니다.',
  regenerate: '다시 만들기',
  retry: '다시 시도',
  ask: 'AI 질문하기',
  truncated: '(해설이 길어 잘렸습니다)',
  outdated: '이 출처는 이전 발행본입니다.',
  loading: 'AI 해설을 불러오는 중입니다.',
  loadFailed: 'AI 해설을 불러오지 못했습니다.',
  summary: '정답과 이유',
  options: '보기별 설명',
  points: '채점 기준과 흔한 오답',
  concepts: '관련 개념',
} as const;

export const TERMINAL_STATUSES = new Set<Explanation['status']>(['succeeded', 'failed']);
export const isLive = (explanation: Pick<Explanation, 'status'> | null | undefined) =>
  explanation != null && !TERMINAL_STATUSES.has(explanation.status);

/** A failed explanation's reason (AIEXPL-01 "실패"; never the provider's own text). */
export function explanationErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'llm_unavailable':
    case 'llm_timeout':
      return 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';
    case 'explanation_answer_mismatch':
      return '정답과 맞지 않는 해설이 나와 보여 주지 않았습니다. 다시 시도하세요.';
    case 'llm_refused':
      return '이 문제에는 AI 해설을 만들 수 없습니다.';
    case 'sources_unavailable':
      return '근거 문서가 바뀌었습니다. 다시 시도하세요.';
    case 'question_unavailable':
      return '문제가 바뀌어 AI 해설을 만들지 못했습니다.';
    case 'workspace_unavailable':
      return 'Workspace를 사용할 수 없습니다.';
    default:
      return 'AI 해설을 만들지 못했습니다. 다시 시도하세요.';
  }
}

export function rateLimitText(seconds: number | undefined): string {
  return `잠시 후 다시 시도하세요 (${Math.max(1, Math.ceil(seconds ?? 60))}초)`;
}

/** Why making (or re-making) one was refused (the request's problem). */
export function explanationFailureText(
  kind: ExplanationFailureKind,
  retryAfterSeconds?: number,
): string {
  switch (kind) {
    case 'rateLimited':
      return rateLimitText(retryAfterSeconds);
    case 'dailyLimit':
      return '오늘 만들 수 있는 AI 해설을 모두 만들었습니다.';
    case 'regenerateLimit':
      return '오늘은 이 문제의 해설을 더 다시 만들 수 없습니다.';
    case 'budget':
      return '이번 달 AI 해설 사용량을 모두 썼습니다.';
    case 'disabled':
      return EXPL_TEXT.disabled;
    case 'archived':
      return EXPL_TEXT.archived;
    case 'insufficientRole':
      return '편집 권한이 있어야 다시 만들 수 있습니다.';
    case 'beforeSubmit':
      return '답을 제출한 뒤에 AI 해설을 볼 수 있습니다.';
    case 'unavailable':
      return '이 문제에는 AI 해설이 없습니다.';
    case 'notFound':
      return '문제를 찾을 수 없습니다.';
    case 'unauthenticated':
      return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    case 'network':
      return '네트워크 연결을 확인한 뒤 다시 시도하세요.';
    default:
      return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
  }
}

/** What the area shows when there is no explanation to read. */
export type EmptyMode = 'create' | 'disabled' | 'archived';

/** No explanation yet: make one, or why that is not possible here (the environment first). */
export function emptyMode(state: Pick<ExplanationState, 'available' | 'can_create'>): EmptyMode {
  if (state.can_create) return 'create';
  return state.available ? 'archived' : 'disabled';
}

/** A `출처` line: "[1] <문서 제목> · <장> · p.2". */
export function sourceLine(source: ExplanationSource): string {
  return [`[${source.n}] ${source.document_title}`, source.chapter_title, `p.${source.page}`]
    .filter(Boolean)
    .join(' · ');
}

/** The meta line: "<생성 시각>" and, for a regenerated one, " · 버전 k". */
export function metaText(
  explanation: Pick<Explanation, 'version' | 'created_at' | 'finished_at'>,
  formatDate: (iso: string) => string,
): string {
  const when = formatDate(explanation.finished_at ?? explanation.created_at);
  return explanation.version >= 2 ? `${when} · 버전 ${explanation.version}` : when;
}

/** An option's label in the body: "2. <보기 글>" by its stored order (never the shuffled one). */
export function optionLabel(
  options: readonly { readonly id: string; readonly text: string }[],
  optionId: string,
): string {
  const index = options.findIndex((o) => o.id === optionId);
  const option = options[index];
  return option ? `${index + 1}. ${option.text}` : '보기';
}
