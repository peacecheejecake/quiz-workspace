// Dedicated worker for `hashFile` (sha256.ts): reads the file and digests it with WebCrypto off
// the main thread, so hashing a 50 MiB PDF never blocks rendering or input.
/// <reference lib="webworker" />
import { digestBlob, type HashRequest, type HashResponse } from './sha256-core';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<HashRequest>) => {
  const { id, blob } = event.data;
  let response: HashResponse;
  try {
    response = { id, hex: await digestBlob(blob) };
  } catch {
    response = { id, error: true };
  }
  scope.postMessage(response);
};
