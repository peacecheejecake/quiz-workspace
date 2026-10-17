// Browser side of the DOC-01 data flow. Calls go to this app's own `/api/...` route handlers
// (src/app/api, `bff.ts`), which attach the session's access token server-side: the Supabase
// session cookies are HttpOnly, so browser code never holds a JWT. Only the short-lived signed
// Storage upload URL reaches the browser, for the direct upload.
import type { Schemas } from '@quiz/api-client';
import { DocumentApiError, errorFromResponse } from './errors';

export type DocumentSummary = Schemas['DocumentSummary'];
export type DocumentType = DocumentSummary['document_type'];
export type UploadIntent = Schemas['UploadIntent'];
export type UploadCompleted = Schemas['UploadCompleted'];
export type Job = Schemas['Job'];

export interface UploadIntentRequest {
  readonly filename: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly sha256: string;
  readonly document_type?: DocumentType;
}

type FetchLike = typeof fetch;

export interface DocumentsClient {
  createUploadIntent(
    workspaceId: string,
    body: UploadIntentRequest,
    signal?: AbortSignal,
  ): Promise<UploadIntent>;
  completeUpload(uploadId: string, sha256: string, signal?: AbortSignal): Promise<UploadCompleted>;
  listDocuments(workspaceId: string, signal?: AbortSignal): Promise<DocumentSummary[]>;
  deleteDocument(documentId: string): Promise<void>;
  getJob(jobId: string, signal?: AbortSignal): Promise<Job>;
}

export const BFF_PATHS = {
  uploadIntent: (workspaceId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/upload-intent`,
  documents: (workspaceId: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/documents`,
  completeUpload: () => '/api/documents/complete-upload',
  document: (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}`,
  job: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`,
  jobEvents: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/events`,
} as const;

export function createDocumentsClient(
  fetchImpl: FetchLike = (...a) => fetch(...a),
): DocumentsClient {
  async function call<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new DocumentApiError('network');
    }
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw errorFromResponse(response.status, body);
    return body as T;
  }

  return {
    createUploadIntent: (workspaceId, body, signal) =>
      call(BFF_PATHS.uploadIntent(workspaceId), {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    completeUpload: (uploadId, sha256, signal) =>
      call(BFF_PATHS.completeUpload(), {
        method: 'POST',
        body: JSON.stringify({ upload_id: uploadId, sha256 }),
        signal,
      }),
    listDocuments: async (workspaceId, signal) =>
      (await call<{ items: DocumentSummary[] }>(BFF_PATHS.documents(workspaceId), { signal }))
        .items,
    deleteDocument: (documentId) => call(BFF_PATHS.document(documentId), { method: 'DELETE' }),
    getJob: (jobId, signal) => call(BFF_PATHS.job(jobId), { signal }),
  };
}
