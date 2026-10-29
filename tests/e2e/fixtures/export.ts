// DOC-03 full-text export (DOCTXT.0): the export API call, downloads, the clipboard capture and
// the UI label contract of the 텍스트 내보내기 menus (docs/screens/documents-text-export.md).
// tests/integration/documents/conftest.py mirrors the API half; keep both in sync.
//
// Grounded in the spec: GET /api/v1/documents/{id}/text; `revision=draft` for the unpublished
// correction draft (editors only, viewer 403, none → 404 `draft-not-found`); not ready → 409
// `document-not-ready`; other workspace / deleted → 404; share session only → 401; headers
// `Cache-Control: private, no-store`, `Content-Disposition: attachment` (RFC 5987 `filename*`),
// `X-Content-Type-Options: nosniff`, `text/markdown|text/plain; charset=utf-8`; file names
// `<title>.md|.txt`, draft `<title> (초안).md`; UTF-8 without BOM, LF, byte-identical repeats.
//
// NOT in the spec (DOCTXT.0 assumptions, to confirm or change in DOCTXT):
//   D1 The format is the query parameter `format=md|txt` (named after the file extensions); the
//      default revision is the published one, `revision=draft` selects the draft.
//   D2 The browser download is a real download event (an attachment response or a blob saved
//      through an <a download>), so Playwright's `download.suggestedFilename()` is the file name.
//   D3 `전체 복사` writes through `navigator.clipboard.writeText` (or `write` with a text/plain
//      item); tests capture it with an init script instead of reading the OS clipboard, which
//      WebKit does not grant to automation.
//   D4 UI contract (Korean first, English accepted):
//      - DOC-01 row: icon menu button named "<title> 텍스트 내보내기" (tooltip "텍스트 내보내기").
//      - DOC-02 header: text menu button "텍스트 내보내기".
//      - Radix DropdownMenu (role=menu) with menuitems "Markdown (.md)", "텍스트 (.txt)" and, in
//        DOC-02, "전체 복사"; with a draft for an editor two role=group elements named
//        "발행본" / "교정 중 초안" (aria-labelledby their DropdownMenu.Label), each with both
//        file items. Copy result: role=status "복사했습니다".
//   D5 (pytest) `book_core.export.render_revision(revision, format, *, title)`.
//   D6 A document is held in `processing` with the DB superuser (fixtures/db.ts use 6).
//
// Exported book text never reaches a Playwright artifact (AC03): the spec runs with traces,
// screenshots and videos off, file contents are compared with boolean assertions (a failing
// `toContain` would print the body into the report), and nothing is attached.
import { readFile } from 'node:fs/promises';
import type { Download, Locator, Page } from '@playwright/test';
import { API_PREFIX } from './api.ts';
import { localEndpoints } from './local-env.ts';
import { main } from './workspace-ui.ts';
import type { Member } from './workspaces.ts';

export type ExportFormat = 'md' | 'txt';

export const DOCUMENT_NOT_READY = 'urn:quiz-workspace:problem:document-not-ready';
export const DRAFT_NOT_FOUND = 'urn:quiz-workspace:problem:draft-not-found';
/** Trace, screenshot and video off for the whole export spec (see the file comment). */
export const NO_BODY_ARTIFACTS = { trace: 'off', screenshot: 'off', video: 'off' } as const;

export function exportPath(
  documentId: string,
  format: ExportFormat = 'md',
  revision?: 'draft',
): string {
  return `/documents/${documentId}/text?format=${format}${revision ? `&revision=${revision}` : ''}`;
}

export interface ExportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly text: string;
  /** Problem `type` of an error response, if any. */
  readonly problemType?: string;
}

/**
 * GET /documents/{id}/text through Node fetch (tokens and the body stay out of traces), as
 * `member` (Bearer) or with only a `cookie` (share session, no JWT).
 */
export async function requestExport(
  as: { member?: Member; cookie?: string },
  documentId: string,
  format: ExportFormat = 'md',
  revision?: 'draft',
): Promise<ExportResponse> {
  const path = exportPath(documentId, format, revision);
  const headers: Record<string, string> = {};
  if (as.member) headers.authorization = `Bearer ${as.member.session.accessToken}`;
  if (as.cookie) headers.cookie = as.cookie;
  let res: Response;
  try {
    res = await fetch(`${localEndpoints().apiUrl}${API_PREFIX}${path}`, { headers });
  } catch {
    throw new Error(`GET ${API_PREFIX}/documents/{id}/text: API unreachable`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  let problemType: string | undefined;
  if (/json/.test(res.headers.get('content-type') ?? '')) {
    try {
      problemType = (JSON.parse(text) as { type?: string }).type;
    } catch {
      problemType = undefined;
    }
  }
  return { status: res.status, headers: res.headers, bytes, text, problemType };
}

/** Fails with "… not implemented (404)" for FastAPI's unknown-route answer (RED evidence). */
export function expectExportStatus(res: ExportResponse, expected: number, what: string): void {
  if (res.status === expected) return;
  let missing = res.status === 405;
  if (res.status === 404) {
    try {
      missing = !(JSON.parse(res.text) as { detail?: unknown }).detail;
    } catch {
      missing = true;
    }
  }
  if (missing) {
    throw new Error(`GET ${API_PREFIX}/documents/{id}/text not implemented (${res.status})`);
  }
  throw new Error(`${what}: expected HTTP ${expected}, got ${res.status}`);
}

/** RFC 5987 `filename*` of an attachment Content-Disposition, decoded; undefined otherwise. */
export function attachmentFilename(headers: Headers): string | undefined {
  const header = headers.get('content-disposition') ?? '';
  if (!/^attachment/i.test(header)) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name?.toLowerCase() === 'filename*' && /^utf-8''/i.test(value)) {
      return decodeURIComponent(value.slice("utf-8''".length));
    }
  }
  return undefined;
}

export interface DownloadedFile {
  readonly name: string;
  readonly bytes: Buffer;
  readonly text: string;
}

/** Waits for the download that `action` starts and reads the saved file. */
export async function download(page: Page, action: () => Promise<void>): Promise<DownloadedFile> {
  const [event] = await Promise.all([page.waitForEvent('download'), action()]);
  return readDownload(event);
}

async function readDownload(event: Download): Promise<DownloadedFile> {
  const failure = await event.failure();
  if (failure) throw new Error(`download failed: ${failure}`);
  const path = await event.path();
  const bytes = await readFile(path);
  return { name: event.suggestedFilename(), bytes, text: bytes.toString('utf8') };
}

/** Records clipboard writes of the page (assumption D3); read them with copiedTexts(). */
export async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = window as unknown as { __e2eCopied: string[] };
    store.__e2eCopied = [];
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return;
    clipboard.writeText = async (text: string) => {
      store.__e2eCopied.push(text);
    };
    clipboard.write = async (items: ClipboardItems) => {
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          store.__e2eCopied.push(await (await item.getType('text/plain')).text());
        }
      }
    };
  });
}

export async function copiedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __e2eCopied?: string[] }).__e2eCopied ?? []);
}

const MD_ITEM = /^(markdown|마크다운)\s*\(\.md\)$/i;
const TXT_ITEM = /^(텍스트|plain text|text)\s*\(\.txt\)$/i;
const COPY_ITEM = /^(전체 복사|copy all)$/i;
const EXPORT_BUTTON = /텍스트 내보내기|export text/i;

export const exportUi = {
  /** DOC-01 row icon button "<title> 텍스트 내보내기". */
  rowButton: (row: Locator) => row.getByRole('button', { name: EXPORT_BUTTON }),
  /** DOC-02 header text button "텍스트 내보내기". */
  headerButton: (page: Page) =>
    main(page).getByRole('button', { name: /^(텍스트 내보내기|export text)$/i }),
  /** Any export entry point on the page (none for share-link guests). */
  anyEntry: (page: Page) =>
    page
      .getByRole('button', { name: EXPORT_BUTTON })
      .or(page.getByRole('menuitem', { name: COPY_ITEM })),
  /** The open export menu (portalled to <body>). */
  menu: (page: Page) => page.getByRole('menu'),
  item: (scope: Page | Locator, item: 'md' | 'txt' | 'copy') =>
    scope.getByRole('menuitem', { name: { md: MD_ITEM, txt: TXT_ITEM, copy: COPY_ITEM }[item] }),
  publishedGroup: (page: Page) =>
    exportUi.menu(page).getByRole('group', { name: /^(발행본|published)/i }),
  draftGroup: (page: Page) =>
    exportUi.menu(page).getByRole('group', { name: /^(교정 중 초안|draft)/i }),
  copied: (page: Page) => page.getByRole('status').filter({ hasText: /복사했습니다|copied/i }),
};

/** Book-ko lines every export of the published revision contains (from its truth file). */
export const BOOK_KO_EXPORT = {
  chapter1: '1장 물의 순환',
  section11: '1.1 증발과 응결',
  chapter2: '2장 정수 처리',
  section21: '2.1 응집과 침전',
  tableHeader: ['단계', '주요 작용', '예시 체류 시간'] as const,
  tableFirstRow: ['응집', '미세 입자 결합', '약 30분'] as const,
  figure: '[그림 p.2]',
} as const;

export function linesOf(text: string): string[] {
  return text.split('\n');
}

/** The nearest non-blank line before line `index`. */
export function previousNonBlank(lines: readonly string[], index: number): string {
  for (let i = index - 1; i >= 0; i--) if (lines[i]?.trim()) return lines[i] ?? '';
  return '';
}
