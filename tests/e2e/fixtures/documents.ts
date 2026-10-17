// Per-test documents (synthetic PDFs from tests/fixtures/pdfs) through the public upload flow,
// plus job polling and search calls for server-side assertions.
//
// Flow (docs/deployment.md §2 "파일 업로드·검색 세부 흐름"): upload-intent → direct upload of the
// bytes to the private Storage bucket with the returned short-lived URL → complete-upload (202 +
// job id) → worker parses and indexes. Contract assumed by M3.0 for M3.2a/M3.2b/M3.4/M3.6a:
//   POST /workspaces/{id}/documents/upload-intent {filename, size_bytes, content_type, sha256}
//        → 201 {upload_id, upload_url, upload_headers?}   (upload_url: PUT the raw bytes)
//   POST /documents/complete-upload {upload_id, sha256}     → 202 {document_id, job_id}
//   GET  /jobs/{id}                                        → 200 {id, status: queued|running|succeeded|failed|cancelled}
//   GET  /workspaces/{id}/documents                        → 200 {items: [{id, title, filename, status}]}
//   GET  /documents/{id}/outline                           → 200 {items: OutlineNode[]}
//        OutlineNode = {id, title, level, page, children: OutlineNode[]}  (id = chapter_ids value)
//   POST /documents/{id}/publish                           → 202 {job_id}
//   POST /workspaces/{id}/search {query, mode, document_ids?, chapter_ids?}
//        → 200 {items: [{document_id, revision_id, block_id, page, text, ...}]}
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { assertLocalUrl, REPO_ROOT } from './local-env.ts';
import type { Member } from './workspaces.ts';

export const PDF_DIR = join(REPO_ROOT, 'tests/fixtures/pdfs');
/** Generous: parse + index of a 4-page fixture with fake adapters on a cold worker. */
export const JOB_TIMEOUT_MS = 120_000;
/** Assumed upload limit (Storage `file_size_limit = "50MiB"` in supabase/config.toml). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type BookId = 'book-ko' | 'book-en';

interface TruthBlock {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly section_id: string;
  readonly parts: readonly { readonly page: number }[];
}

interface TruthSection {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly page: number;
}

export interface BookFixture {
  readonly id: BookId;
  readonly file: string;
  readonly path: string;
  readonly title: string;
  readonly sha256: string;
  readonly size: number;
  readonly sections: readonly TruthSection[];
  readonly blocks: readonly TruthBlock[];
}

export function book(id: BookId): BookFixture {
  const truth = JSON.parse(readFileSync(join(PDF_DIR, `${id}.truth.json`), 'utf8')) as {
    file: string;
    title: string;
    sha256: string;
    sections: TruthSection[];
    blocks: TruthBlock[];
  };
  const path = join(PDF_DIR, truth.file);
  return {
    id,
    file: truth.file,
    path,
    title: truth.title,
    sha256: truth.sha256,
    size: statSync(path).size,
    sections: truth.sections,
    blocks: truth.blocks,
  };
}

export function section(fixture: BookFixture, id: string): TruthSection {
  const found = fixture.sections.find((s) => s.id === id);
  if (!found) throw new Error(`fixture ${fixture.id} has no section ${id}`);
  return found;
}

export function block(fixture: BookFixture, id: string): TruthBlock {
  const found = fixture.blocks.find((b) => b.id === id);
  if (!found) throw new Error(`fixture ${fixture.id} has no block ${id}`);
  return found;
}

/** Leading words of a block, short enough to match one line in the UI. */
export function snippet(text: string, length = 24): string {
  return text.slice(0, length);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface UploadedDocument {
  readonly documentId: string;
  readonly jobId: string;
}

export interface DocumentSummary {
  readonly id: string;
  readonly title?: string;
  readonly filename?: string;
  readonly status?: string;
}

export interface Job {
  readonly id: string;
  readonly status: string;
}

export interface SearchRequest {
  readonly query: string;
  readonly mode: 'keyword' | 'semantic' | 'hybrid';
  readonly document_ids?: readonly string[];
  readonly chapter_ids?: readonly string[];
}

export interface SearchItem {
  readonly document_id: string;
  readonly revision_id?: string;
  readonly block_id?: string;
  readonly chapter_id?: string;
  readonly page: number;
  readonly text: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The upload-relevant facts of any synthetic PDF fixture (books and question papers). */
export interface PdfFile {
  readonly file: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export async function uploadBook(
  owner: Member,
  workspaceId: string,
  id: BookId,
): Promise<UploadedDocument> {
  return uploadPdf(owner, workspaceId, book(id));
}

/** upload-intent → direct Storage upload → complete-upload for any synthetic PDF fixture. */
export async function uploadPdf(
  owner: Member,
  workspaceId: string,
  fixture: PdfFile,
): Promise<UploadedDocument> {
  const bytes = readFileSync(fixture.path);
  const intent = await owner.api.ok<{
    upload_id: string;
    upload_url: string;
    upload_headers?: Record<string, string>;
  }>(
    'POST',
    `/workspaces/${workspaceId}/documents/upload-intent`,
    {
      filename: fixture.file,
      size_bytes: fixture.size,
      content_type: 'application/pdf',
      sha256: fixture.sha256,
    },
    [200, 201],
  );
  // The signed upload URL must stay on the local stack; it is never logged.
  const uploadUrl = assertLocalUrl(intent.upload_url, 'upload_url');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf', ...intent.upload_headers },
    body: bytes,
  });
  await put.body?.cancel();
  if (!put.ok) throw new Error(`direct Storage upload failed: HTTP ${put.status}`);
  const done = await owner.api.ok<{ document_id: string; job_id: string }>(
    'POST',
    '/documents/complete-upload',
    { upload_id: intent.upload_id, sha256: fixture.sha256 },
    [202],
  );
  return { documentId: done.document_id, jobId: done.job_id };
}

/** Polls `GET /jobs/{id}` (expect.poll, no sleeps) until terminal; asserts it succeeded. */
export async function waitForJob(member: Member, jobId: string): Promise<void> {
  let last = '';
  await expect
    .poll(
      async () => {
        last = (await member.api.ok<Job>('GET', `/jobs/${jobId}`, undefined, [200])).status;
        return TERMINAL.has(last);
      },
      { message: 'job reaches a terminal status', timeout: JOB_TIMEOUT_MS },
    )
    .toBe(true);
  expect(last, 'job status').toBe('succeeded');
}

/** Upload through the public flow and wait until parsing + indexing finished. */
export async function uploadReadyBook(
  owner: Member,
  workspaceId: string,
  id: BookId,
): Promise<string> {
  const { documentId, jobId } = await uploadBook(owner, workspaceId, id);
  await waitForJob(owner, jobId);
  return documentId;
}

export async function listDocuments(
  member: Member,
  workspaceId: string,
): Promise<DocumentSummary[]> {
  const body = await member.api.ok<{ items: DocumentSummary[] }>(
    'GET',
    `/workspaces/${workspaceId}/documents`,
    undefined,
    [200],
  );
  return body.items;
}

export async function search(
  member: Member,
  workspaceId: string,
  request: SearchRequest,
): Promise<SearchItem[]> {
  const body = await member.api.ok<{ items: SearchItem[] }>(
    'POST',
    `/workspaces/${workspaceId}/search`,
    request,
    [200],
  );
  return body.items;
}

export interface OutlineNode {
  readonly id: string;
  readonly title: string;
  readonly level?: number;
  readonly page?: number;
  readonly children?: readonly OutlineNode[];
}

/** Server id of the outline node (chapter/section) titled `title` in the document's outline. */
export async function outlineNodeId(
  member: Member,
  documentId: string,
  title: string,
): Promise<string> {
  const body = await member.api.ok<{ items: OutlineNode[] }>(
    'GET',
    `/documents/${documentId}/outline`,
    undefined,
    [200],
  );
  const queue = [...body.items];
  for (let node = queue.shift(); node; node = queue.shift()) {
    if (node.title.trim() === title) return node.id;
    queue.push(...(node.children ?? []));
  }
  throw new Error(`outline of the document has no node titled "${title}"`);
}

/**
 * Text that the E2E fake embedding adapter must refuse to index (M3.4 assumption, never in the
 * production adapter): lets DOC-02-AC04 make a reindex fail deterministically without touching
 * the shared Qdrant.
 */
export const INDEX_FAILURE_MARKER = 'E2E-FAIL-INDEXING';
