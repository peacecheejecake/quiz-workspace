// WS-VIEW-01 address-bar state (pure, unit-tested): `/share/{id}` is the shared workspace home,
// `?document=<id>&page=<n>&block=<id>` opens one shared document at a page/block, and
// `?panel=fork` is the WS-FORK-01 entry. Only ids and numbers ever go into this URL — never the
// link secret (that lives in the `#k=` fragment until the exchange removes it).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCK_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const MAX_PAGE = 100_000;

export interface SharedViewState {
  readonly documentId: string | null;
  readonly page: number | null;
  readonly blockId: string | null;
  readonly forkPanel: boolean;
}

type RawParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function parseSharedViewParams(params: RawParams): SharedViewState {
  const documentId = first(params.document);
  const validDocument = documentId !== undefined && UUID.test(documentId) ? documentId : null;
  const rawPage = first(params.page);
  const page = rawPage !== undefined && /^[0-9]{1,6}$/.test(rawPage) ? Number(rawPage) : null;
  const blockId = first(params.block);
  return {
    documentId: validDocument,
    page: validDocument && page !== null && page >= 1 && page <= MAX_PAGE ? page : null,
    blockId: validDocument && blockId !== undefined && BLOCK_ID.test(blockId) ? blockId : null,
    forkPanel: first(params.panel) === 'fork',
  };
}

export function sharePath(shareId: string): string {
  return `/share/${encodeURIComponent(shareId)}`;
}

/** Link to a shared document (optionally at a page and block) inside the share view. */
export function sharedDocumentHref(
  shareId: string,
  documentId: string,
  at: { readonly page?: number | null; readonly blockId?: string | null } = {},
): string {
  const query = new URLSearchParams({ document: documentId });
  if (at.page != null) query.set('page', String(at.page));
  if (at.blockId) query.set('block', at.blockId);
  return `${sharePath(shareId)}?${query.toString()}`;
}

export function forkPanelHref(shareId: string): string {
  return `${sharePath(shareId)}?panel=fork`;
}
