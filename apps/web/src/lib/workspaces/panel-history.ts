// Browser history of the workspace home's dialogs and panels (UX7-BACK, UX7-BACK-2, docs/screens/
// questions-overview.md "뒤로가기", QOV-01-AC14). The rule: a closed dialog is never in the
// history, in either direction; while dialogs are open each Back closes one of them; closing
// returns to the address before the open (a close button keeps what changed meanwhile: filters,
// searches; a Back restores that address as it was).
//
// Opening a dialog (or moving the practice panel to another question) pushes an entry, so Back
// while it is open undoes the open. Browsers cannot drop forward entries except by writing a new
// one, so every close ends with a push that truncates them:
// - A close button (or Escape, save, delete) at depth d first goes back d entries to the base
//   (the entry before the first open; Next shows it), then pushes the closed URL: one entry for
//   the dialogs still open (Back then closes those), or, with none left, the closed home above
//   the base, which becomes a "skip" entry.
// - A Back that closes a dialog lands on the entry before its open (its address, as Back restores
//   it: SEARCH-01-AC09): that entry becomes a skip entry and a copy is pushed above it.
// A skip entry keeps its own address (Next's saved tree must match it), the closed address before
// the open; the entry above it is what it stands for. Back onto it goes on back (`skip` entries:
// the run of skip entries below it included), Forward onto it goes on forward. Our popstate
// listener stops Next's when it runs first (WebKit runs capture listeners first; Chromium runs
// window listeners in registration order, so Next may render the skip entry for a moment there).
// Landing on one from another document, or with nowhere further back, stays on it. Without a
// forward entry to drop (Navigation API `canGoForward`), a close at depth 0 just rewrites the
// entry. When the base belongs to another document (the page was reloaded with a dialog open),
// the rewind loads it: the close is handed over in sessionStorage and finished there. Likewise a
// browser Back into another document of the home (no BFCache after a reload): each document
// records on pagehide the entry it was on and its dialogs, and the next one (attach, or pageshow
// from the BFCache) drops the forward entry when that Back closed a dialog.
//
// Each entry of ours records in `history.state` (beside Next's keys) its position (`pos`, to tell
// Back from Forward), its depth (entries above its base) and, on a skip entry, how far to skip.
// Next's patched pushState/replaceState copy its internals into the object we pass, and its
// Back/Forward restores keep custom state; router navigations (router.replace/refresh) drop it, so
// the home stamps it back (stamp) after renders and before every push.

import { openDialogs, withoutPanels } from './home';

export const PANEL_POS_KEY = '__quizPanelPos';
export const PANEL_DEPTH_KEY = '__quizPanelDepth';
/** On a real entry: how many skip entries lie directly below it. */
export const PANEL_UNDER_KEY = '__quizPanelUnder';
/** On a skip entry: how many entries Back onto it goes on back. */
export const PANEL_SKIP_KEY = '__quizPanelSkip';
/** sessionStorage: a close whose rewind left the document (see the module comment). */
export const PANEL_CLOSE_KEY = '__quizPanelClose';
/** sessionStorage: the entry a document of the home was on when it unloaded (pagehide). */
export const PANEL_LEAVE_KEY = '__quizPanelLeave';
/** How old a pagehide record may be when the next document reads it (a slow page load). */
export const LEAVE_MAX_AGE_MS = 30_000;

/**
 * How long a close or a skip waits for the traversal it started before settling in place. A
 * traversal to another document never reports back here, and settling (a Next navigation) while
 * it loads would cancel it in WebKit: keep this well above a page load.
 */
export const TRAVERSAL_TIMEOUT_MS = 5000;

export interface EntryMark {
  readonly pos: number;
  readonly depth: number;
  readonly under: number;
}

export interface PanelEntry {
  /** Whether the entry was written by the home (else: another page, or a fresh arrival). */
  readonly ours: boolean;
  readonly mark: EntryMark;
  /** 0 for a real entry. */
  readonly skip: number;
}

function count(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** What an entry's state records. */
export function readEntry(state: unknown): PanelEntry {
  const record =
    typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  return {
    ours: PANEL_POS_KEY in record || PANEL_DEPTH_KEY in record,
    mark: {
      pos: count(record, PANEL_POS_KEY),
      depth: count(record, PANEL_DEPTH_KEY),
      under: count(record, PANEL_UNDER_KEY),
    },
    skip: count(record, PANEL_SKIP_KEY),
  };
}

/** `state` (Next's keys kept) carrying `mark`, and `skip` when positive. */
export function markState(state: unknown, mark: EntryMark, skip = 0): Record<string, unknown> {
  const base =
    typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  const out = Object.fromEntries(Object.entries(base).filter(([key]) => key !== PANEL_SKIP_KEY));
  out[PANEL_POS_KEY] = mark.pos;
  out[PANEL_DEPTH_KEY] = mark.depth;
  out[PANEL_UNDER_KEY] = mark.under;
  if (skip > 0) out[PANEL_SKIP_KEY] = skip;
  return out;
}

/** The home's dialog URL helpers (home.ts), bound to the page's current content search. */
export interface DialogUrls {
  /** The open dialogs of `search` (openDialogs). */
  open(search: string): readonly string[];
  /** `search` with every dialog closed (withoutPanels). */
  closeAll(search: string): string;
  /**
   * Pushes `url` through the router (it reads the page for it). Used when a close lands on an
   * entry whose page (filters, searches) differs from the closed URL: a plain pushState would
   * carry the entry's saved Next tree under the new address, which Next then reloads in full.
   */
  navigate?(url: string): void;
}

export const DEFAULT_DIALOG_URLS: DialogUrls = {
  open: openDialogs,
  closeAll: (search) => withoutPanels(search),
};

export type PageEventType = 'popstate' | 'pagehide' | 'pageshow';

export interface PanelHistoryWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
  readonly location: Pick<Location, 'pathname' | 'search' | 'href'>;
  /** The Navigation API where the browser has it. */
  readonly navigation?: { readonly canGoForward: boolean } | undefined;
  readonly sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** `popstate` (with capture), `pagehide` and `pageshow` (PageTransitionEvent). */
  addEventListener(
    type: PageEventType,
    listener: (event: never) => void,
    options?: { capture: boolean },
  ): void;
  removeEventListener(
    type: PageEventType,
    listener: (event: never) => void,
    options?: { capture: boolean },
  ): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Epoch milliseconds (Date.now). */
  now(): number;
}

/** Where a document of the home was when it unloaded. */
interface Leave {
  readonly pos: number;
  readonly path: string;
  readonly dialogs: readonly string[];
}

function parseLeave(raw: string | null, now: number): Leave | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Leave> & { at?: unknown };
    if (
      typeof value.at === 'number' &&
      now - value.at >= 0 &&
      now - value.at <= LEAVE_MAX_AGE_MS &&
      typeof value.pos === 'number' &&
      typeof value.path === 'string' &&
      Array.isArray(value.dialogs) &&
      value.dialogs.every((d) => typeof d === 'string')
    ) {
      return { pos: value.pos, path: value.path, dialogs: value.dialogs };
    }
  } catch {
    // A malformed value is no record.
  }
  return null;
}

/** A close waiting for its rewind to land on the base (`pos`). */
interface Rewind {
  readonly pos: number;
  /** The target with every dialog closed. */
  readonly base: string;
  /** Pushed above the base when dialogs stay open. */
  readonly reopen: string | null;
}

type Pending =
  | ({ readonly kind: 'rewind'; readonly fallback: string; timer: number } & Rewind)
  | { readonly kind: 'skip'; timer: number };

/** Path + query of `url` (resolved against `href`). */
function pathAndQuery(url: string, href: string): string {
  const parsed = new URL(url, href);
  return `${parsed.pathname}${parsed.search}`;
}

function splitUrl(url: string): { path: string; search: string } {
  const at = url.indexOf('?');
  return at === -1 ? { path: url, search: '' } : { path: url.slice(0, at), search: url.slice(at) };
}

function parseRewind(raw: string | null, now: number): Rewind | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Rewind> & { at?: unknown };
    if (
      typeof value.at === 'number' &&
      now - value.at >= 0 &&
      now - value.at <= TRAVERSAL_TIMEOUT_MS &&
      typeof value.pos === 'number' &&
      typeof value.base === 'string' &&
      (typeof value.reopen === 'string' || value.reopen === null)
    ) {
      return { pos: value.pos, base: value.base, reopen: value.reopen };
    }
  } catch {
    // A malformed value is no handover.
  }
  return null;
}

const NO_MARK: EntryMark = { pos: 0, depth: 0, under: 0 };
const CAPTURE = { capture: true };

export class PanelHistory {
  private mark: EntryMark = NO_MARK;
  /** The address the page rests on (last write or render): what a Back starts from. */
  private resting = '';
  private pending: Pending | null = null;
  /** False after landing on another page's entry: the next traversal's direction is unknown. */
  private known = true;

  constructor(
    /** The browser window (a getter: the home also renders on the server). */
    private readonly getWindow: () => PanelHistoryWindow,
    private readonly getDialogs: () => DialogUrls = () => DEFAULT_DIALOG_URLS,
  ) {}

  private get win(): PanelHistoryWindow {
    return this.getWindow();
  }

  private current(): string {
    return `${this.win.location.pathname}${this.win.location.search}`;
  }

  /** Follows Back/Forward; returns the detach function. */
  attach(): () => void {
    const entry = readEntry(this.win.history.state);
    this.mark = entry.mark;
    this.resting = this.current();
    const leave = this.takeLeave();
    const handover = this.takeRewind();
    const basePath = handover ? splitUrl(handover.base).path : null;
    if (
      handover &&
      basePath === this.win.location.pathname &&
      (!entry.ours || entry.mark.pos === handover.pos)
    ) {
      // A close's rewind loaded this document (the base): finish the close here.
      this.mark = { ...entry.mark, pos: handover.pos };
      this.settle(handover.base, handover.reopen);
    } else {
      this.arrive(entry, leave);
    }
    const onPopState = (event: PopStateEvent) => this.onPopState(event);
    const onPageHide = () => this.storeLeave();
    const onPageShow = (event: PageTransitionEvent) => {
      // Restored from the BFCache: like a load, but this document's state is still here.
      if (!event.persisted) return;
      if (this.pending) this.win.clearTimeout(this.pending.timer);
      this.pending = null;
      this.known = true;
      this.arrive(readEntry(this.win.history.state), this.takeLeave());
    };
    this.win.addEventListener('popstate', onPopState, CAPTURE);
    this.win.addEventListener('pagehide', onPageHide);
    this.win.addEventListener('pageshow', onPageShow);
    return () => {
      this.win.removeEventListener('popstate', onPopState, CAPTURE);
      this.win.removeEventListener('pagehide', onPageHide);
      this.win.removeEventListener('pageshow', onPageShow);
      if (this.pending) this.win.clearTimeout(this.pending.timer);
      this.pending = null;
    };
  }

  /** Puts the marks back on the current entry when a router navigation dropped them. */
  stamp(): void {
    if (this.pending) return;
    const state: unknown = this.win.history.state;
    const entry = readEntry(state);
    const { mark } = this;
    // Another entry of ours whose popstate has not come yet (a render can run in between):
    // leave it, and what the page rested on, to onPopState.
    if (entry.ours && entry.mark.pos !== mark.pos) return;
    this.resting = this.current();
    if (
      entry.ours &&
      entry.skip === 0 &&
      entry.mark.depth === mark.depth &&
      entry.mark.under === mark.under
    ) {
      return;
    }
    // Next's own keys are in `state`: its patched replaceState passes the write straight through.
    this.win.history.replaceState(markState(state, mark), '');
  }

  /** Opens a dialog or moves a panel on a new entry (Back undoes it). */
  push(url: string): void {
    if (this.pending) return;
    const target = pathAndQuery(url, this.win.location.href);
    if (target === this.current()) return;
    this.stamp();
    this.mark = { pos: this.mark.pos + 1, depth: this.mark.depth + 1, under: 0 };
    this.win.history.pushState(markState(null, this.mark), '', target);
    this.resting = target;
  }

  /** Rewrites the current entry (filters, searches): no new entry, same marks. */
  replace(url: string): void {
    this.win.history.replaceState(markState(null, this.mark), '', url);
    this.resting = this.current();
  }

  /** Closes to `url` (see the module comment). */
  close(url: string): void {
    if (this.pending) return;
    const target = pathAndQuery(url, this.win.location.href);
    if (target === this.current()) return;
    const { path, search } = splitUrl(target);
    const base = `${path}${this.getDialogs().closeAll(search)}`;
    const reopen = base === target ? null : target;
    if (this.mark.depth > 0) {
      const rewind: Rewind = { pos: this.mark.pos - this.mark.depth, base, reopen };
      const pending: Pending = { kind: 'rewind', ...rewind, fallback: target, timer: 0 };
      pending.timer = this.win.setTimeout(() => {
        // The traversal never came: close in place rather than leave the dialog open.
        if (this.pending !== pending) return;
        this.pending = null;
        this.takeRewind();
        this.replace(pending.fallback);
      }, TRAVERSAL_TIMEOUT_MS);
      this.pending = pending;
      this.storeRewind(rewind);
      this.win.history.go(-this.mark.depth);
      return;
    }
    if (reopen === null && this.win.navigation?.canGoForward === false) {
      this.replace(target);
      return;
    }
    this.settle(base, reopen);
  }

  /**
   * On the base entry: push the dialogs still open, or the closed home (the base becomes a skip
   * entry). A base with dialogs (a deep link: nothing to rewind) is first rewritten closed.
   */
  private settle(base: string, reopen: string | null): void {
    this.mark = { ...this.mark, depth: 0 };
    if (this.getDialogs().open(this.win.location.search).length > 0) {
      this.win.history.replaceState(markState(null, this.mark), '', base);
    }
    if (reopen) {
      this.mark = { pos: this.mark.pos + 1, depth: 1, under: 0 };
      this.pushAddress(reopen);
    } else {
      this.truncate(base);
    }
    this.resting = reopen ?? base;
  }

  /**
   * Makes the current entry a skip entry (its address stays) and pushes `url` above it, dropping
   * every forward entry (the closed dialog). The same address is pushed without telling Next.
   */
  private truncate(url: string): void {
    const { history } = this.win;
    const skip = this.mark.under + 1;
    history.replaceState(markState(history.state, this.mark, skip), '');
    const dialogs = this.getDialogs().open(splitUrl(url).search);
    this.mark = {
      pos: this.mark.pos + 1,
      depth: dialogs.length > 0 ? this.mark.depth + 1 : 0,
      under: skip,
    };
    this.pushAddress(url);
  }

  /**
   * Pushes `url` as the entry `this.mark` describes. The same address is pushed without telling
   * Next; another page (filters, searches) goes through the router, whose entry stamp() marks
   * once it is written; a change of dialogs only is a plain pushState (Next syncs its URL).
   */
  private pushAddress(url: string): void {
    const { history } = this.win;
    if (url === this.current()) {
      history.pushState(markState(history.state, this.mark), '');
      return;
    }
    const dialogs = this.getDialogs();
    const samePage =
      dialogs.closeAll(splitUrl(url).search) === dialogs.closeAll(this.win.location.search);
    if (!samePage && dialogs.navigate) {
      dialogs.navigate(url);
      return;
    }
    history.pushState(markState(null, this.mark), '', url);
  }

  /**
   * Stays on the current (skip) entry as a real one. `shown` is the address Next shows: when the
   * entry's differs (Next's popstate handling was stopped), Next is told to show it.
   */
  private rest(shown: string): void {
    const { history } = this.win;
    this.mark = readEntry(history.state).mark;
    if (shown === this.current()) {
      history.replaceState(markState(history.state, this.mark), '');
    } else {
      history.replaceState(markState(null, this.mark), '', this.current());
    }
    this.resting = this.current();
  }

  /**
   * This document arrived on the current entry from another one (a load, or a BFCache restore).
   * A skip entry is stayed on. A Back from a document of the home (its pagehide record) that
   * closed dialogs drops the forward entry, as onPopState does within one document.
   */
  private arrive(entry: PanelEntry, leave: Leave | null): void {
    this.mark = entry.mark;
    this.resting = this.current();
    if (entry.skip > 0) {
      this.rest(this.current());
      return;
    }
    if (!leave || !entry.ours || leave.path !== this.win.location.pathname) return;
    if (entry.mark.pos >= leave.pos) return;
    const now = this.getDialogs().open(this.win.location.search);
    if (leave.dialogs.every((d) => now.includes(d))) return;
    this.truncate(this.current());
    this.resting = this.current();
  }

  private storeLeave(): void {
    try {
      const { path, search } = splitUrl(this.resting);
      const record = {
        pos: this.mark.pos,
        path,
        dialogs: this.getDialogs().open(search),
        at: this.win.now(),
      };
      this.win.sessionStorage?.setItem(PANEL_LEAVE_KEY, JSON.stringify(record));
    } catch {
      // Without storage a Back across documents leaves the forward entry.
    }
  }

  private takeLeave(): Leave | null {
    try {
      const storage = this.win.sessionStorage;
      if (!storage) return null;
      const leave = parseLeave(storage.getItem(PANEL_LEAVE_KEY), this.win.now());
      storage.removeItem(PANEL_LEAVE_KEY);
      return leave;
    } catch {
      return null;
    }
  }

  private storeRewind(rewind: Rewind): void {
    try {
      const at = this.win.now();
      this.win.sessionStorage?.setItem(PANEL_CLOSE_KEY, JSON.stringify({ ...rewind, at }));
    } catch {
      // Without storage a rewind into another document leaves the forward entries.
    }
  }

  private takeRewind(): Rewind | null {
    try {
      const storage = this.win.sessionStorage;
      if (!storage) return null;
      const rewind = parseRewind(storage.getItem(PANEL_CLOSE_KEY), this.win.now());
      storage.removeItem(PANEL_CLOSE_KEY);
      return rewind;
    } catch {
      return null;
    }
  }

  private onPopState(event: PopStateEvent): void {
    const pending = this.pending;
    if (pending) {
      this.win.clearTimeout(pending.timer);
      this.pending = null;
    }
    const entry = readEntry(event.state);
    if (pending?.kind === 'rewind') {
      // Landed on the base (Next restores it): push the closed URL above it.
      this.takeRewind();
      this.mark = entry.mark;
      this.settle(pending.base, pending.reopen);
      return;
    }
    if (!entry.ours) {
      // Another page's entry (the home is being left).
      this.mark = NO_MARK;
      this.known = false;
      this.resting = this.current();
      return;
    }
    if (entry.skip > 0 && !this.known) {
      // Came from another page's entry: which way is unknown, so stay (it shows the closed home).
      this.known = true;
      this.rest(this.current());
      return;
    }
    if (entry.skip > 0) {
      // Not Next's to render: go on to the entry it stands for.
      event.stopImmediatePropagation();
      const shown = this.resting;
      const skipping: Pending = { kind: 'skip', timer: 0 };
      skipping.timer = this.win.setTimeout(() => {
        // The traversal never came (no entry that far back): stay here.
        if (this.pending !== skipping) return;
        this.pending = null;
        this.rest(shown);
      }, TRAVERSAL_TIMEOUT_MS);
      this.pending = skipping;
      // Forward only when it surely came from below: a skip entry always has its copy above it.
      this.win.history.go(entry.mark.pos > this.mark.pos ? 1 : -entry.skip);
      return;
    }
    const from = this.resting;
    const back = this.known && entry.mark.pos < this.mark.pos;
    this.known = true;
    this.mark = entry.mark;
    this.resting = this.current();
    if (!back) return;
    // A Back that closed dialogs (not one that changed the practice panel's question): drop the
    // forward entry. The page stays on the address before the open, as Back restores it (what
    // changed while the dialog was open goes with it: SEARCH-01-AC09).
    const dialogs = this.getDialogs();
    const now = dialogs.open(this.win.location.search);
    const fromUrl = splitUrl(from);
    if (fromUrl.path !== this.win.location.pathname) return;
    if (dialogs.open(fromUrl.search).every((d) => now.includes(d))) return;
    this.truncate(this.current());
    this.resting = this.current();
  }
}
