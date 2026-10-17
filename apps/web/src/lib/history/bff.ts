// Query parameters the HISTORY-01 relays forward to FastAPI: a page size and the opaque keyset
// cursor (URL-safe base64, as FastAPI encodes it). Anything else — e.g. a `user_id` — is dropped.
export const HISTORY_QUERY: Readonly<Record<string, RegExp>> = {
  limit: /^\d{1,3}$/,
  cursor: /^[A-Za-z0-9_-]{1,200}$/,
};
