// Document summary (DOCSUM-01) fixtures: the summary API helpers, the feature-off stack for
// DOCSUM-01-AC05, fault/latency markers of the APP_ENV=test fake summarizer, and the DOCSUM-01
// UI label contract. DOCSUM.0 keeps every assumption about DOCSUM-B / DOCSUM-W in this header
// (mirrored by tests/integration/documents/test_document_summary_contract.py).
//
// Grounded in the docs (docs/screens/documents-summary.md, docs/architecture.md §5–§6,
// docs/workspace-sharing.md §8): routes GET/POST /documents/{id}/summary,
// POST …/summary/retry, DELETE …/summary/auto, GET /shared/{shareId}/documents/{docId}/summary;
// job `document.summarize {run_id}`; run status queued|running|succeeded|failed|superseded,
// trigger manual|publish|retry, error codes llm_unavailable|llm_timeout|llm_invalid_output|
// summary_too_large|document_unavailable; usage {tokens, cost_usd, reused_units,
// generated_units}; progress {chapters_done, chapters_total}; unit body {title, summary_md,
// key_points[{text, pages}]}; activities `document.summary_enabled` /
// `document.summary_auto_disabled` (ids only); worker setting `WORKER_DOCUMENT_SUMMARY`;
// APP_ENV=test uses a deterministic extractive fake (leading sentences of the blocks) and the
// failure marker `E2E-FAIL-SUMMARY`.
//
// NOT in the docs (DOCSUM.0 assumptions, to confirm or change in DOCSUM-B / DOCSUM-W):
//   D1 GET /documents/{id}/summary → 200 SummaryState, any member (archived workspace too):
//      {document_id, available: bool, enabled: bool, published_revision_id: string|null,
//       run: SummaryRun|null, summary: Summary|null, stale: bool}
//      `available` = this environment can create summaries (WORKER_DOCUMENT_SUMMARY on and an LLM,
//      the fake under APP_ENV=test); `enabled` = summary_enabled_at is set (auto refresh on);
//      `run` = the newest run of the CURRENT published revision (any status) or null;
//      `summary` = the newest succeeded summary of any revision; `stale` = summary is not of the
//      current published revision.
//      SummaryRun = {id, revision_id, status, trigger, job_id, error_code: string|null,
//                    progress: {chapters_done, chapters_total}|null,
//                    usage: {reused_units, generated_units, input_tokens?, output_tokens?,
//                            cost_usd?}|null, created_at}
//      Summary = {run_id, revision_id, published_at, usage: SummaryRun.usage,
//                 document: SummaryUnit, chapters: ChapterSummary[]} (chapters in outline order,
//                 one per top-level chapter)
//      SummaryUnit = {title, summary_md, key_points: [{text, pages: {from, to}|null}]}
//      ChapterSummary = SummaryUnit + {section_key, page_from, page_to}
//      Never in any response: prompts, raw LLM output, provider error messages.
//   D2 POST /documents/{id}/summary (optional `Idempotency-Key`) → 202 SummaryState with a queued
//      run (opt-in: enabled true), or 200 when the current revision already has a succeeded
//      summary (enabling only, no run). Same key → the same run. Errors (RFC 9457 problem types
//      urn:quiz-workspace:problem:<slug>): 403 insufficient-role / workspace-archived, 404,
//      409 summary-not-applicable (문제지), document-not-ready, summary-disabled (feature off).
//   D3 POST /documents/{id}/summary/retry → 202 SummaryState (a NEW run of the same revision,
//      trigger retry); 409 summary-not-failed unless the current revision's run failed.
//   D4 DELETE /documents/{id}/summary/auto → 204 (idempotent); 403 / 404 like D2.
//   D5 GET /shared/{shareId}/documents/{docId}/summary (share cookie) → 200 SharedSummary =
//      Summary without run_id / usage (no cost, status or error data) only when the current
//      published revision has a succeeded summary; otherwise the share API's one 404 body.
//   D6 Workspace jobs (GET /workspaces/{id}/jobs, H2): job_type `document.summarize`,
//      target_type `document`, target_id = the document. History labels: job "문서 요약";
//      activities "요약 만들기" (document.summary_enabled), "자동 갱신 끄기"
//      (document.summary_auto_disabled), both without body text.
//   D7 Fault/latency markers of the APP_ENV=test fake summarizer (never in production):
//      - SUMMARY_FAILURE_MARKER in a chapter's input text (put there by a block correction) makes
//        that run fail with error_code `llm_invalid_output` (every attempt, retries included).
//      - SUMMARY_SLOW_MARKER in the document's upload file name makes each run of that document
//        hold SLOW_SUMMARY_STEP_S seconds while queued (before it turns running) and before each
//        unit it generates, so the transient states of DOCSUM-01-AC01/AC02 are observable with a
//        fake that otherwise finishes in milliseconds. Units reused by hash do not wait.
//   D8 Feature-off stack (DOCSUM-01-AC05): an API, a Celery worker and a `next start` of the same
//      web build, started by startSummaryOffStack() with WORKER_DOCUMENT_SUMMARY=false on their
//      own ports (E2E_SUMMARY_OFF_WEB_PORT / E2E_SUMMARY_OFF_API_PORT, default: the main ports
//      + 40) and their own Celery broker (E2E_SUMMARY_OFF_REDIS_URL, default: REDIS_URL with the
//      next Redis DB index), sharing Postgres, Storage, Qdrant prefix and APP_ENV with the main
//      stack. The off web relays to the off API (API_INTERNAL_BASE_URL); the session cookie of
//      the main web is valid there (cookies are not port-scoped). The main E2E stack itself runs
//      with WORKER_DOCUMENT_SUMMARY=true (API and worker).
//
// UI contract (Korean first, English accepted; AGENTS.md §5):
//   문서 관리 row: text button "<title> 요약" on ready 교재 / 교재+문제 rows only; text "요약 중"
//     next to it while a run is queued/running.
//   Panel (FloatingSidePanel, non-modal role=dialog inside <main>) named "문서 요약": subtitle =
//     document title, badge text "AI 생성", meta line "<발행 시각> 발행본 기준 · 장 n개", close
//     button "문서 요약 닫기". h3 "전체 요약" with the summary and a list "핵심" whose page links
//     are named "<from>–<to>쪽 열기" / "<n>쪽 열기"; h3 "장별 요약" with one disclosure button per
//     top-level chapter (name starts with the chapter title, aria-expanded, collapsed at first).
//     States as text: "아직 요약이 없습니다.", "요약 대기 중", "요약을 만드는 중 · 장별 요약 k/n"
//     + progressbar "요약 진행률", alert "요약을 만들지 못했습니다" + reason + "다시 시도";
//     role=status stale notice "이전 발행본 기준 요약입니다." (+ " 새 발행본의 요약을 만드는
//     중입니다." / " 새 요약을 만들지 못했습니다."); auto row "자동 갱신 켜짐 …" + button
//     "자동 갱신 끄기" (alertdialog "자동 갱신을 끌까요?" with "끄기" / "취소"), "자동 갱신 꺼짐";
//     button "요약 만들기" (aria-disabled + description "이 환경에서는 AI 요약을 사용할 수
//     없습니다." when unavailable); "문서를 찾을 수 없습니다." for a foreign/deleted document.
//   DOC-02 header link "요약"; share page: "<title> 요약" button per document with a current
//     summary.
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { scanLog, startLogged, stop } from '../../../scripts/e2e-log-audit.ts';
import { API_PREFIX, apiError, type ApiResponse } from './api.ts';
import { book, JOB_TIMEOUT_MS, type BookFixture, type PdfFile } from './documents.ts';
import { listWorkspaceJobs, type WorkspaceJob } from './history.ts';
import { localEndpoints } from './local-env.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export const SUMMARY_FAILURE_MARKER = 'E2E-FAIL-SUMMARY';
export const SUMMARY_SLOW_MARKER = 'E2E-SLOW-SUMMARY';
export const SLOW_SUMMARY_STEP_S = 4;
export const SUMMARY_JOB_TYPE = 'document.summarize';
/** Upload/parse plus a slow-marker summary run (3 held units + the queued hold) and slack. */
export const SUMMARY_TIMEOUT_MS = JOB_TIMEOUT_MS;

export const SUMMARY_PROBLEMS = {
  notApplicable: 'urn:quiz-workspace:problem:summary-not-applicable',
  notReady: 'urn:quiz-workspace:problem:document-not-ready',
  disabled: 'urn:quiz-workspace:problem:summary-disabled',
  notFailed: 'urn:quiz-workspace:problem:summary-not-failed',
} as const;

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded';

export interface SummaryUsage {
  readonly reused_units: number;
  readonly generated_units: number;
  readonly cost_usd?: number;
}

export interface SummaryRun {
  readonly id: string;
  readonly revision_id: string;
  readonly status: RunStatus;
  readonly trigger: 'manual' | 'publish' | 'retry';
  readonly job_id: string;
  readonly error_code: string | null;
  readonly progress: { readonly chapters_done: number; readonly chapters_total: number } | null;
  readonly usage: SummaryUsage | null;
}

export interface KeyPoint {
  readonly text: string;
  readonly pages: { readonly from: number; readonly to: number } | null;
}

export interface SummaryUnit {
  readonly title: string;
  readonly summary_md: string;
  readonly key_points: readonly KeyPoint[];
}

export interface ChapterSummary extends SummaryUnit {
  readonly section_key: string;
  readonly page_from: number;
  readonly page_to: number;
}

export interface Summary {
  readonly run_id: string;
  readonly revision_id: string;
  readonly published_at: string;
  readonly usage: SummaryUsage | null;
  readonly document: SummaryUnit;
  readonly chapters: readonly ChapterSummary[];
}

export interface SummaryState {
  readonly document_id: string;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly published_revision_id: string | null;
  readonly run: SummaryRun | null;
  readonly summary: Summary | null;
  readonly stale: boolean;
}

/** book-ko under a file name carrying SUMMARY_SLOW_MARKER (same bytes, D7). */
export function slowSummaryBook(): BookFixture & PdfFile {
  const base = book('book-ko');
  return { ...base, file: `book-ko-${SUMMARY_SLOW_MARKER}.pdf` };
}

export function summaryPath(documentId: string): string {
  return `/documents/${documentId}/summary`;
}

export async function getSummary(member: Member, documentId: string): Promise<SummaryState> {
  return member.api.ok<SummaryState>('GET', summaryPath(documentId), undefined, [200]);
}

/** `요약 만들기` through the API (D2); raw response, any status. */
export function requestSummary(
  member: Member,
  documentId: string,
  idempotencyKey?: string,
): Promise<ApiResponse<SummaryState>> {
  return member.api.request<SummaryState>(
    'POST',
    summaryPath(documentId),
    {},
    idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  );
}

export async function startSummary(member: Member, documentId: string): Promise<SummaryState> {
  const res = await requestSummary(member, documentId);
  if (res.status !== 202) throw apiError('POST', summaryPath(documentId), res);
  return res.body as SummaryState;
}

export function retrySummary(member: Member, documentId: string): Promise<ApiResponse> {
  return member.api.request('POST', `${summaryPath(documentId)}/retry`, {});
}

export function disableAutoSummary(member: Member, documentId: string): Promise<ApiResponse> {
  return member.api.request('DELETE', `${summaryPath(documentId)}/auto`);
}

/**
 * Polls GET …/summary (no sleeps) until the current published revision's run is terminal with
 * `status` (and, when given, belongs to `revisionId`); returns that state.
 */
export async function waitForSummaryRun(
  member: Member,
  documentId: string,
  status: 'succeeded' | 'failed',
  revisionId?: string,
): Promise<SummaryState> {
  let state: SummaryState | undefined;
  await expect
    .poll(
      async () => {
        state = await getSummary(member, documentId);
        const run = state.run;
        if (!run || (revisionId && run.revision_id !== revisionId)) return 'no run yet';
        return ['succeeded', 'failed', 'superseded'].includes(run.status) ? run.status : 'running';
      },
      { message: `summary run reaches ${status}`, timeout: SUMMARY_TIMEOUT_MS },
    )
    .toBe(status);
  if (!state) throw new Error('no summary state');
  return state;
}

/** Polls until the current published revision differs from `previousRevisionId`. */
export async function waitForPublishedRevision(
  member: Member,
  documentId: string,
  previousRevisionId: string,
): Promise<string> {
  let current: string | null = null;
  await expect
    .poll(
      async () => {
        current = (await getSummary(member, documentId)).published_revision_id;
        return current !== null && current !== previousRevisionId;
      },
      { message: 'a new revision is published', timeout: JOB_TIMEOUT_MS },
    )
    .toBe(true);
  return current as unknown as string;
}

/** `document.summarize` jobs of one document (D6). */
export async function summaryJobs(
  member: Member,
  workspaceId: string,
  documentId: string,
): Promise<WorkspaceJob[]> {
  return (await listWorkspaceJobs(member, workspaceId)).filter(
    (job) => job.job_type === SUMMARY_JOB_TYPE && job.target_id === documentId,
  );
}

// ---------------------------------------------------------------------------------------------
// Feature-off stack (D8)
// ---------------------------------------------------------------------------------------------

function portOf(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

function offRedisUrl(): string {
  const explicit = process.env.E2E_SUMMARY_OFF_REDIS_URL?.trim();
  if (explicit) return explicit;
  const url = new URL(process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379/0');
  const db = Number(url.pathname.replace(/^\//, '') || '0');
  url.pathname = `/${(db + 1) % 16}`;
  return url.toString();
}

async function waitUp(url: string, child: ChildProcess, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null) throw new Error(`${name} exited with ${child.exitCode}`);
        try {
          const res = await fetch(url);
          await res.body?.cancel();
          return res.status < 500;
        } catch {
          return false;
        }
      },
      { message: `${name} comes up`, timeout: 90_000, intervals: [250] },
    )
    .toBe(true);
}

export interface SummaryOffStack {
  /** Web origin of the feature-off stack (navigate the browser here with absolute URLs). */
  readonly webUrl: string;
  /** FastAPI of the feature-off stack. */
  readonly apiUrl: string;
  /** Calls the off API as `member` (Bearer from the member's session). */
  request<T = unknown>(member: Member, method: string, path: string): Promise<ApiResponse<T>>;
  /** Stops the three processes and fails if their logs hold a secret (log-audit patterns). */
  stop(): Promise<void>;
}

/** Starts API + worker + web with WORKER_DOCUMENT_SUMMARY=false (D8). */
export async function startSummaryOffStack(): Promise<SummaryOffStack> {
  const main = localEndpoints();
  const webPort = Number(process.env.E2E_SUMMARY_OFF_WEB_PORT || portOf(main.baseUrl) + 40);
  const apiPort = Number(process.env.E2E_SUMMARY_OFF_API_PORT || portOf(main.apiUrl) + 40);
  const webUrl = `http://127.0.0.1:${webPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const dir = mkdtempSync(join(tmpdir(), 'quiz-summary-off-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKER_DOCUMENT_SUMMARY: 'false',
    REDIS_URL: offRedisUrl(),
    LOG_LEVEL: 'INFO',
    PYTHONUNBUFFERED: '1',
  };
  const supabaseUrl = main.supabaseUrl;
  const logs = {
    api: join(dir, 'api.log'),
    worker: join(dir, 'worker.log'),
    web: join(dir, 'web.log'),
  };
  const children: ChildProcess[] = [];
  const stopAll = async (): Promise<void> => {
    for (const child of children) stop(child);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  try {
    const api = startLogged(
      'uv',
      ['run', 'python', '-m', 'quiz_api.serve', '--port', String(apiPort)],
      {
        ...env,
        CORS_ALLOWED_ORIGINS: webUrl,
        SUPABASE_JWT_ISSUER: process.env.SUPABASE_JWT_ISSUER || `${supabaseUrl}/auth/v1`,
        SUPABASE_JWKS_URL:
          process.env.SUPABASE_JWKS_URL || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      },
      logs.api,
    );
    children.push(api);
    const worker = startLogged(
      'uv',
      ['run', 'python', '-m', 'quiz_worker.serve'],
      env,
      logs.worker,
    );
    children.push(worker);
    const web = startLogged(
      'pnpm',
      [
        '--filter',
        '@quiz/web',
        'exec',
        'next',
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(webPort),
      ],
      { ...env, API_INTERNAL_BASE_URL: apiUrl, E2E_BASE_URL: webUrl },
      logs.web,
    );
    children.push(web);
    await waitUp(`${apiUrl}/health/live`, api, 'summary-off API');
    await waitUp(`${webUrl}/login`, web, 'summary-off web');
    await expect
      .poll(() => /ready\./i.test(readFileSync(logs.worker, 'utf8')), {
        message: 'summary-off worker is ready',
        timeout: 90_000,
      })
      .toBe(true);
  } catch (error) {
    await stopAll();
    throw error;
  }
  return {
    webUrl,
    apiUrl,
    async request<T>(member: Member, method: string, path: string): Promise<ApiResponse<T>> {
      const res = await fetch(`${apiUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${member.session.accessToken}`,
          accept: 'application/json',
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      const text = await res.text();
      let body: T | undefined;
      try {
        body = text ? (JSON.parse(text) as T) : undefined;
      } catch {
        body = undefined;
      }
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', body, text };
    },
    async stop(): Promise<void> {
      await stopAll();
      const findings = Object.values(logs).flatMap((file) =>
        scanLog(file, readFileSync(file, 'utf8')),
      );
      expect(findings, 'summary-off stack logs hold no secrets').toEqual([]);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// UI (DOCSUM-01)
// ---------------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The home with the summary panel of `documentId` open. */
export function summaryPanelPath(workspaceId: string, documentId: string): string {
  return `/workspaces/${workspaceId}?panel=document-summary&document=${documentId}`;
}

/** Page-link name for a key point: "12–14쪽 열기" / "4쪽 열기" (any dash). */
export const PAGE_LINK = /(\d+)(?:\s*[–-]\s*(\d+))?\s*쪽 열기|open pages? (\d+)/i;

export const summaryUi = {
  /** The 문서 관리 row's "<title> 요약" button. */
  rowButton: (scope: Page | Locator, title: string) =>
    scope.getByRole('button', { name: new RegExp(`^${escape(title)} (요약|summary)$`, 'i') }),
  rowBusy: (row: Locator) => row.getByText(/^(요약 중|summarizing)$/i),
  panel: (page: Page) => page.getByRole('dialog', { name: /^(문서 요약|document summary)$/i }),
  close: (panel: Locator) =>
    panel.getByRole('button', { name: /문서 요약 닫기|close( summary)?$/i }),
  aiBadge: (panel: Locator) => panel.getByText(/^(AI 생성|AI generated)$/i),
  meta: (panel: Locator) => panel.getByText(/발행본 기준\s*·\s*장\s*\d+개|published version/i),
  empty: (panel: Locator) => panel.getByText(/아직 요약이 없습니다|no summary yet/i),
  sendNotice: (panel: Locator) =>
    panel.getByText(/본문이 AI 서비스로 전송됩니다|text is sent to an AI service/i),
  createButton: (panel: Locator) =>
    panel.getByRole('button', { name: /^(요약 만들기|create summary)$/i }),
  queued: (panel: Locator) => panel.getByText(/요약 대기 중|summary queued/i),
  running: (panel: Locator) =>
    panel.getByText(
      /요약을 만드는 중\s*·\s*장별 요약\s*\d+\s*\/\s*\d+|summarizing .*\d+\s*\/\s*\d+/i,
    ),
  progress: (panel: Locator) =>
    panel.getByRole('progressbar', { name: /요약 진행률|summary progress/i }),
  overallHeading: (panel: Locator) =>
    panel.getByRole('heading', { level: 3, name: /^(전체 요약|overall summary)$/i }),
  chaptersHeading: (panel: Locator) =>
    panel.getByRole('heading', { level: 3, name: /^(장별 요약|chapter summaries)$/i }),
  keyPoints: (panel: Locator) => panel.getByRole('list', { name: /^(핵심|key points)$/i }),
  pageLinks: (scope: Locator) => scope.getByRole('link', { name: PAGE_LINK }),
  chapter: (panel: Locator, title: string) =>
    panel.getByRole('button', { name: new RegExp(`^${escape(title)}`) }),
  stale: (panel: Locator) =>
    panel
      .getByRole('status')
      .filter({ hasText: /이전 발행본 기준 요약입니다|previous published/i }),
  staleRunning: /새 발행본의 요약을 만드는 중입니다|summarizing the new/i,
  staleFailed: /새 요약을 만들지 못했습니다|new summary failed/i,
  failure: (panel: Locator) =>
    panel.getByRole('alert').filter({ hasText: /요약을 만들지 못했습니다|summary failed/i }),
  invalidOutputReason: /요약을 만들지 못했습니다\. 다시 시도하세요|try again/i,
  retry: (panel: Locator) => panel.getByRole('button', { name: /^(다시 시도|retry)$/i }),
  autoOn: (panel: Locator) => panel.getByText(/자동 갱신 켜짐|auto refresh on/i),
  autoOff: (panel: Locator) => panel.getByText(/자동 갱신 꺼짐|auto refresh off/i),
  disableAuto: (panel: Locator) =>
    panel.getByRole('button', { name: /^(자동 갱신 끄기|turn off auto refresh)$/i }),
  confirm: (page: Page) =>
    page.getByRole('alertdialog', { name: /자동 갱신을 끌까요|turn off auto refresh/i }),
  confirmOff: (dialog: Locator) => dialog.getByRole('button', { name: /^(끄기|turn off)$/i }),
  confirmCancel: (dialog: Locator) => dialog.getByRole('button', { name: /^(취소|cancel)$/i }),
  unavailableReason:
    /이 환경에서는 AI 요약을 사용할 수 없습니다|not available in this environment/i,
  notFound: (panel: Locator) => panel.getByText(/문서를 찾을 수 없습니다|document not found/i),
  /** DOC-02 header link to the home's summary panel. */
  editorLink: (page: Page) => main(page).getByRole('link', { name: /^(요약|summary)$/i }),
};
