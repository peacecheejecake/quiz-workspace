// DOC-01 — Documents 목록·PDF 업로드 (`/workspaces/:workspaceId/documents`),
// docs/screens/documents-library.md; upload flow docs/deployment.md §2.
//
// Per-test owner + workspace (public API). The browser uploads `book-ko.pdf` (synthetic) through
// the real UI: upload-intent → direct upload to the private Storage bucket → complete-upload →
// parse/index job. Storage upload requests are intercepted only to hold or drop them (progress,
// cancel, network interruption); nothing is faked. Job state is awaited with expect.poll / web-first
// assertions, never sleeps. The worker and fake model adapters must run for READY (M3.2b).
import { truncateSync, writeFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { sha256 } from '../fixtures/documents.ts';
import { localEndpoints } from '../fixtures/local-env.ts';
import {
  book,
  docUi,
  expect,
  JOB_TIMEOUT_MS,
  listDocuments,
  MAX_UPLOAD_BYTES,
  signInAs,
  test,
  type Member,
  type Problem,
  uploadReadyBook,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const BOOK = book('book-ko');
const BOOK_TITLE = /book-ko|물의 순환과 정수 처리/;

/** Direct browser → Storage upload requests (standard or TUS), never GET/HEAD/OPTIONS. */
function isStorageUpload(route: Route): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method());
}

async function openLibrary(page: Page, owner: Member, workspaceId: string): Promise<void> {
  await signInAs(page, owner.user);
  await page.goto(`/workspaces/${workspaceId}/documents`);
}

async function chooseFile(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await docUi.uploadButton(page).click();
  await (await chooser).setFiles(file);
}

/** Records upload-intent calls (the first server step of every upload). */
function recordUploadIntents(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (/\/documents\/upload-intent\b/.test(new URL(req.url()).pathname)) seen.push(req.method());
  });
  return seen;
}

test(
  'DOC-01-AC01 an active workspace without PDFs shows the empty state and an upload button',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc01-ac01');
    const ws = await workspaceFactory.create(owner);
    expect(await listDocuments(owner, ws.id)).toEqual([]);

    await openLibrary(page, owner, ws.id);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/문서|documents/i);
    await expect(docUi.emptyState(page)).toBeVisible();
    await expect(docUi.uploadButton(page)).toBeEnabled();
    // One upload button only: the empty state's; the header button is hidden meanwhile (UX1).
    await expect(docUi.uploadButtons(page)).toHaveCount(1);
    // The drag-and-drop hint is the empty state's description, shown once (UX2).
    const dropHint = /끌어다 놓아도 업로드|drag (and drop|a pdf)/i;
    await expect(docUi.emptyState(page).locator('xpath=following-sibling::p[1]')).toHaveText(
      dropHint,
    );
    await expect(page.getByRole('main').getByText(dropHint)).toHaveCount(1);
  },
);

test(
  'DOC-01-AC02 uploading a valid PDF shows upload and parse/index progress, then READY',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('doc01-ac02');
    const ws = await workspaceFactory.create(owner);
    await openLibrary(page, owner, ws.id);

    // Hold the Storage upload so the in-flight progress is observable, then let it through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`${localEndpoints().supabaseUrl}/storage/v1/**`, async (route) => {
      if (!isStorageUpload(route)) return route.fallback();
      await gate;
      await route.continue();
    });

    await chooseFile(page, BOOK.path);
    const row = docUi.item(page, BOOK_TITLE);
    await expect(docUi.uploadProgress(row)).toBeVisible();
    release();

    await expect(docUi.processing(row).first()).toBeVisible();
    await expect(docUi.ready(row)).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expect(docUi.emptyState(page)).toHaveCount(0);

    await expect
      .poll(async () => (await listDocuments(owner, ws.id)).map((d) => d.status), {
        timeout: JOB_TIMEOUT_MS,
      })
      .toEqual(['ready']);
  },
);

test(
  'DOC-01-AC03 unsupported types and oversized files are rejected in the browser and by the server',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc01-ac03');
    const ws = await workspaceFactory.create(owner);
    await openLibrary(page, owner, ws.id);
    const intents = recordUploadIntents(page);

    await chooseFile(page, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a pdf'),
    });
    await expect(docUi.alert(page)).toContainText(/pdf/i);

    const tooLarge = test.info().outputPath('too-large.pdf');
    writeFileSync(tooLarge, '%PDF-1.7\n');
    truncateSync(tooLarge, MAX_UPLOAD_BYTES + 1); // sparse file, no 50 MiB write
    await chooseFile(page, tooLarge);
    await expect(docUi.alert(page)).toContainText(/50\s?MB|50\s?MiB|크기|용량|too large|size/i);
    expect(intents, 'the browser never asked the API for an upload URL').toEqual([]);

    // The server enforces the same rules on a direct call and says why. The bodies are otherwise
    // valid (the M3.2a API requires `sha256`), so the rejection is about the type and the size.
    const txt = await owner.api.request('POST', `/workspaces/${ws.id}/documents/upload-intent`, {
      filename: 'notes.txt',
      size_bytes: 9,
      content_type: 'text/plain',
      sha256: sha256(Buffer.from('not a pdf')),
    });
    expect([415, 422]).toContain(txt.status);
    expect((txt.body as Problem).detail).toMatch(/pdf/i);
    const big = await owner.api.request('POST', `/workspaces/${ws.id}/documents/upload-intent`, {
      filename: 'too-large.pdf',
      size_bytes: MAX_UPLOAD_BYTES + 1,
      content_type: 'application/pdf',
      sha256: 'f'.repeat(64),
    });
    expect([413, 422]).toContain(big.status);
    expect((big.body as Problem).detail).toBeTruthy();
    expect(await listDocuments(owner, ws.id)).toEqual([]);
    await expect(docUi.emptyState(page)).toBeVisible();
  },
);

test(
  'DOC-01-AC04 an upload interrupted by the network can be retried without a duplicate document',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('doc01-ac04');
    const ws = await workspaceFactory.create(owner);
    await openLibrary(page, owner, ws.id);

    let dropped = 0;
    await page.route(`${localEndpoints().supabaseUrl}/storage/v1/**`, async (route) => {
      if (!isStorageUpload(route) || dropped > 0) return route.fallback();
      dropped += 1;
      await route.abort('internetdisconnected');
    });

    await chooseFile(page, BOOK.path);
    const row = docUi.item(page, BOOK_TITLE);
    await expect(docUi.retry(row)).toBeVisible();
    await expect(row.getByText(/중단|실패|오류|interrupted|failed|error/i).first()).toBeVisible();
    expect(dropped).toBe(1);

    await docUi.retry(row).click();
    await expect(docUi.ready(row)).toBeVisible({ timeout: JOB_TIMEOUT_MS });
    await expect(docUi.item(page, BOOK_TITLE)).toHaveCount(1);
    const docs = await listDocuments(owner, ws.id);
    expect(docs).toHaveLength(1);

    await page.reload();
    await expect(docUi.item(page, BOOK_TITLE)).toHaveCount(1);
  },
);

test(
  'DOC-01-AC05 a document this tab does not follow shows its job stage from the list, then the elapsed time and a hint',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    test.setTimeout(2 * JOB_TIMEOUT_MS + 60_000);
    const owner = await workspaceFactory.member('doc01-ac05');
    const ws = await workspaceFactory.create(owner);
    const target = await uploadReadyBook(owner, ws.id, 'book-ko');
    await openLibrary(page, owner, ws.id);
    const row = docUi.item(page, BOOK_TITLE);
    await expect(docUi.ready(row)).toBeVisible();

    // A cold worker (minutes of model loading) cannot be produced on demand with the fake
    // adapters, and their jobs finish in seconds. So the library's own list request (BFF → API,
    // real response) gets the target's job state replaced by what the API returns during a cold
    // start: running, stage `preparing`, started 90 s ago. The API and worker side of that state
    // are covered by tests/integration/workspaces/test_document_parse_job.py (UX3-JOB).
    const listPath = `/api/workspaces/${ws.id}/documents`;
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    await page.route(
      (url) => url.pathname === listPath,
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = (await response.json()) as { items: Record<string, unknown>[] };
        for (const item of body.items) {
          if (item.id !== target) continue;
          item.status = 'processing';
          item.processing_job = {
            id: crypto.randomUUID(),
            status: 'running',
            stage: 'preparing',
            progress: 2,
            created_at: startedAt,
            started_at: startedAt,
          };
        }
        await route.fulfill({ response, json: body });
      },
    );

    // Another upload through the UI: once its job ends the library re-reads the list.
    await chooseFile(page, book('book-en').path);
    await expect(docUi.ready(docUi.item(page, /book-en/))).toBeVisible({ timeout: JOB_TIMEOUT_MS });

    await expect(row.getByText(/처리 준비 중|preparing/i)).toBeVisible();
    await expect(row.getByText(/\d+분 \d+초째 처리 중/)).toBeVisible();
    await expect(row.getByText(/첫 처리나 큰 PDF는 몇 분 걸릴 수 있습니다/)).toBeVisible();
    await expect(docUi.ready(row)).toHaveCount(0);

    // Back to the real list (polled while the document is processing): READY again.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await expect(docUi.ready(row)).toBeVisible();
    await expect(row.getByText(/첫 처리나 큰 PDF/)).toHaveCount(0);
  },
);

test(
  'DOC-01-AC04 cancelling an upload in progress leaves no document behind',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('doc01-ac04-cancel');
    const ws = await workspaceFactory.create(owner);
    await openLibrary(page, owner, ws.id);

    // Hold the upload (never forwarded); the cancel button must end it.
    await page.route(`${localEndpoints().supabaseUrl}/storage/v1/**`, async (route) => {
      if (!isStorageUpload(route)) return route.fallback();
      await new Promise<never>(() => undefined);
    });

    await chooseFile(page, BOOK.path);
    const row = docUi.item(page, BOOK_TITLE);
    await expect(docUi.uploadProgress(row)).toBeVisible();
    await docUi.cancel(row).click();

    await expect(docUi.item(page, BOOK_TITLE)).toHaveCount(0);
    await expect(docUi.emptyState(page)).toBeVisible();
    await expect.poll(async () => (await listDocuments(owner, ws.id)).length).toBe(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
);
