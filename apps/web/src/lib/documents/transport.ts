// Direct browser → private Storage upload with the signed URL from upload-intent
// (docs/deployment.md §2): a single PUT for small files, TUS (resumable, tus-js-client) above
// RESUMABLE_THRESHOLD_BYTES. Both report progress and stop on `signal`; neither ever logs or
// persists the signed URL or the upload signature (TUS resume state stays in memory).
import type * as TusClient from 'tus-js-client';
import type { UploadIntent } from './client-api';
import { DocumentApiError } from './errors';
import { RESUMABLE_THRESHOLD_BYTES } from './validation';

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

export interface TransferOptions {
  readonly onProgress: (loaded: number, total: number) => void;
  readonly signal: AbortSignal;
}

/** A transfer that can be started again after a failure, resuming where possible. */
export interface Transfer {
  readonly resumable: boolean;
  run(options: TransferOptions): Promise<void>;
}

export type TransferFactory = (file: Blob, intent: UploadIntent) => Transfer;

export function createTransfer(file: Blob, intent: UploadIntent): Transfer {
  return file.size > RESUMABLE_THRESHOLD_BYTES
    ? tusTransfer(file, intent)
    : putTransfer(file, intent);
}

/** Storage answers a second PUT to an already written key with 400 + `statusCode: "409"`. */
export function isAlreadyStored(status: number, body: string): boolean {
  if (status === 409) return true;
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as { statusCode?: unknown; error?: unknown };
    return String(parsed.statusCode) === '409' || parsed.error === 'Duplicate';
  } catch {
    return false;
  }
}

export function putTransfer(
  file: Blob,
  intent: Pick<UploadIntent, 'upload_url' | 'upload_headers'>,
  createXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Transfer {
  return {
    resumable: false,
    run: ({ onProgress, signal }) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new UploadAbortedError());
        const xhr = createXhr();
        const onAbort = () => xhr.abort();
        const settle = (fn: () => void) => {
          signal.removeEventListener('abort', onAbort);
          fn();
        };
        xhr.open('PUT', intent.upload_url);
        for (const [name, value] of Object.entries(intent.upload_headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) => {
          onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
        };
        xhr.onload = () =>
          settle(() => {
            if (
              (xhr.status >= 200 && xhr.status < 300) ||
              isAlreadyStored(xhr.status, xhr.responseText)
            ) {
              onProgress(file.size, file.size);
              resolve();
            } else {
              reject(new DocumentApiError('storage', xhr.status));
            }
          });
        xhr.onerror = () => settle(() => reject(new DocumentApiError('network')));
        xhr.ontimeout = () => settle(() => reject(new DocumentApiError('network')));
        xhr.onabort = () => settle(() => reject(new UploadAbortedError()));
        signal.addEventListener('abort', onAbort, { once: true });
        xhr.send(file);
      }),
  };
}

/** Supabase Storage requires exactly 6 MiB TUS chunks. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

type TusModule = typeof TusClient;

export function tusTransfer(
  file: Blob,
  intent: Pick<UploadIntent, 'upload_id' | 'resumable'>,
  loadTus: () => Promise<TusModule> = () => import('tus-js-client'),
): Transfer {
  // One tus Upload per intent, kept in memory: a retry calls start() again and the client
  // resumes from the offset the server reports (HEAD), without re-sending stored chunks.
  let upload: InstanceType<TusModule['Upload']> | undefined;
  return {
    resumable: true,
    async run({ onProgress, signal }) {
      if (signal.aborted) throw new UploadAbortedError();
      const tus = await loadTus();
      // Cancelled while the module was loading: the abort event has already fired.
      if (signal.aborted) throw new UploadAbortedError();
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          void upload?.abort(false);
          reject(new UploadAbortedError());
        };
        const options = {
          endpoint: intent.resumable.endpoint,
          headers: { ...intent.resumable.headers },
          metadata: { ...intent.resumable.metadata },
          chunkSize: TUS_CHUNK_BYTES,
          uploadDataDuringCreation: true,
          // Automatic retries for short drops; after these the row offers "다시 시도".
          retryDelays: [0, 1000, 3000, 5000],
          // Resume state (upload URL) is per intent and stays in memory only.
          storeFingerprintForResuming: false,
          removeFingerprintOnSuccess: true,
          fingerprint: async () => `quiz-upload-${intent.upload_id}`,
          onProgress: (loaded: number, total: number) => onProgress(loaded, total),
          onSuccess: () => {
            signal.removeEventListener('abort', onAbort);
            onProgress(file.size, file.size);
            resolve();
          },
          onError: (error: Error) => {
            signal.removeEventListener('abort', onAbort);
            const status = (
              error as { originalResponse?: { getStatus(): number } | null }
            ).originalResponse?.getStatus();
            reject(
              status === undefined || status === 0
                ? new DocumentApiError('network')
                : new DocumentApiError('storage', status),
            );
          },
        };
        if (upload) Object.assign(upload.options, options);
        else upload = new tus.Upload(file, options);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          signal.removeEventListener('abort', onAbort);
          reject(new UploadAbortedError());
          return;
        }
        upload.start();
      });
    },
  };
}
