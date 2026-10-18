// Single source of truth for the screens in docs/screens/index.md. Each page under src/app
// renders its entry by ID; test/screens.test.ts keeps this table, the doc and the page files in
// sync. Screens that are a query state of another route (`?question=`, `?panel=fork`) share that
// route's page file and are listed with the `query` that activates them.

export interface ScreenSpec {
  readonly id: string;
  /** Korean screen name, exactly as in docs/screens/index.md. */
  readonly name: string;
  /** App Router path with `[param]` segments, without the query string. */
  readonly path: string;
  /** Query parameter that turns the base route into this screen. */
  readonly query?: { readonly param: string; readonly value?: string };
}

export const SCREENS = [
  { id: 'AUTH-01', name: '로그인', path: '/login' },
  { id: 'AUTH-02', name: '회원가입', path: '/signup' },
  { id: 'AUTH-03', name: '이메일 인증 대기', path: '/auth/verify' },
  { id: 'AUTH-04', name: '인증 콜백', path: '/auth/callback' },
  { id: 'AUTH-05', name: '비밀번호 재설정 요청', path: '/forgot-password' },
  { id: 'AUTH-06', name: '새 비밀번호 설정', path: '/reset-password' },
  { id: 'AUTH-07', name: '인증 오류 안내', path: '/auth/error' },
  { id: 'ACCOUNT-01', name: '계정 보안 설정', path: '/settings/security' },
  { id: 'WS-01', name: 'Workspace 홈', path: '/workspaces' },
  { id: 'DOC-01', name: 'Documents 목록·업로드', path: '/workspaces/[workspaceId]/documents' },
  {
    id: 'DOC-02',
    name: 'PDF 열람·원문 교정',
    path: '/workspaces/[workspaceId]/documents/[documentId]',
  },
  { id: 'SEARCH-01', name: '다국어 원문 검색', path: '/workspaces/[workspaceId]/search' },
  { id: 'QOV-01', name: 'Questions Heatmap 홈', path: '/workspaces/[workspaceId]/questions' },
  { id: 'QBANK-01', name: '문제은행 목록·편집', path: '/workspaces/[workspaceId]/questions/bank' },
  {
    id: 'QPLAY-01',
    name: '문제 풀이 Floating Side Panel',
    path: '/workspaces/[workspaceId]/questions',
    query: { param: 'question' },
  },
  {
    id: 'QIMPORT-01',
    name: '문제 PDF 가져오기',
    path: '/workspaces/[workspaceId]/questions/import',
  },
  { id: 'QGEN-01', name: '문제 변형 출제', path: '/workspaces/[workspaceId]/questions/generate' },
  { id: 'HISTORY-01', name: '작업·변경·풀이 이력', path: '/workspaces/[workspaceId]/history' },
  {
    id: 'WS-SHARE-01',
    name: 'Workspace 공유 관리 (Owner)',
    path: '/workspaces/[workspaceId]/settings/sharing',
  },
  { id: 'WS-VIEW-01', name: '공유 Workspace 조회 (Guest)', path: '/share/[shareId]' },
  {
    id: 'WS-FORK-01',
    name: '공유 Workspace Fork (Recipient)',
    path: '/share/[shareId]',
    query: { param: 'panel', value: 'fork' },
  },
] as const satisfies readonly ScreenSpec[];

export type ScreenId = (typeof SCREENS)[number]['id'];

export function getScreen(id: ScreenId): ScreenSpec {
  const screen = SCREENS.find((s) => s.id === id);
  if (!screen) throw new Error(`Unknown screen ${id}`);
  return screen;
}

type SearchParamValue = string | string[] | undefined;

/** True when `searchParams` activate the query-state screen (e.g. QPLAY-01 on QOV-01). */
export function isQueryStateActive(
  screen: ScreenSpec,
  searchParams: Readonly<Record<string, SearchParamValue>>,
): boolean {
  if (!screen.query) return false;
  const raw = searchParams[screen.query.param];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return false;
  return screen.query.value === undefined || value === screen.query.value;
}
