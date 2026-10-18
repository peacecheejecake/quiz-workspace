// SHA-256 of an upload, declared in upload-intent and re-verified by complete-upload. Computed in
// a dedicated Web Worker; if a worker cannot start (old browser, blocked script) it falls back
// to WebCrypto on the main thread, which is asynchronous as well.
import { digestBlob, type HashRequest, type HashResponse } from './sha256-core';

export class HashAbortedError extends Error {
  constructor() {
    super('Hashing was cancelled');
    this.name = 'HashAbortedError';
  }
}

export interface WorkerLike {
  postMessage(message: HashRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<HashResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type WorkerFactory = () => WorkerLike | null;

function defaultWorkerFactory(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    const worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' });
    return worker as unknown as WorkerLike;
  } catch {
    return null;
  }
}

let nextId = 0;

/** Hex SHA-256 of `blob`; rejects with `HashAbortedError` when `signal` aborts. */
export async function hashFile(
  blob: Blob,
  signal?: AbortSignal,
  createWorker: WorkerFactory = defaultWorkerFactory,
): Promise<string> {
  if (signal?.aborted) throw new HashAbortedError();
  const worker = createWorker();
  if (!worker) return abortable(digestBlob(blob), signal);
  const id = ++nextId;
  const hex = await new Promise<string | null>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new HashAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      if (event.data.id !== id) return;
      finish();
      resolve('hex' in event.data ? event.data.hex : null);
    };
    worker.onerror = () => {
      finish();
      resolve(null);
    };
    worker.postMessage({ id, blob });
  });
  return hex ?? abortable(digestBlob(blob), signal);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HashAbortedError());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
