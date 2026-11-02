// Browser history of the workspace home's dialogs and panels (UX7-BACK, UX7-BACK-2, docs/screens/
// questions-overview.md "뒤로가기", QOV-01-AC14). The rule: a closed dialog is never in the
// history, in either direction; while dialogs are open each Back closes one of them; closing
// returns to the address before the open, keeping what changed meanwhile (filters, searches),
// whether by a close button or by Back (UX7 확인 7). Dialogs a first load opens (deep links) count
// as opened one by one (expandFirstLoad).
//
// Opening a dialog (or moving the practice panel to another question) pushes an entry, so Back
// while it is open undoes the open. Browsers cannot drop forward entries except by writing a new
// one, so every close ends with a push that truncates them:
// - A close button (or Escape, save, delete) at depth d first goes back d entries to the base
//   (the entry before the first open), or, closing the top-most opened dialog while others stay,
//   only to the entry before its open (each entry records the depth its dialogs were opened at):
//   Chromium renders a traversed entry before its popstate arrives, so passing an entry without
//   the dialogs that stay would remount them. A Back that closes a dialog lands on the entry before its
//   open. Either way that entry is rewritten to the closed URL (what changed while the dialog was
//   open kept), then becomes a "skip" entry under a copy of it, or, after a close button with
//   dialogs still open, stays under one entry for those (Back then closes them).
// The rewrite goes through Next's router when filters or searches differ (it reads that page, so
// the entry's saved Next tree matches its address; a plain write would make Next reload it); a
// change of dialog keys only is a plain write. Back onto a skip entry goes on back (`skip`
// entries: the run of skip entries below it included), Forward onto it goes on forward. Our
// popstate listener stops Next's when it runs first (WebKit runs capture listeners first;
// Chromium runs window listeners in registration order, so Next may render it for a moment).
// Landing on one from another document, or with nowhere further back, stays on it. Without a
// forward entry to drop (Navigation API `canGoForward`), a close at depth 0 just rewrites the
// entry. When the base belongs to another document (the page was reloaded with a dialog open),
// the rewind loads it: the close is handed over in sessionStorage and finished there. Likewise a
// browser Back into another document of the home (no BFCache after a reload): each document
// records on pagehide the entry and the address (path and query only) it was on, and the next
// one (attach, or pageshow from the BFCache) closes behind that Back as onPopState does
// (closeBehind), keeping what changed while the dialog was open.
//
// A close can carry an open (close(url, open)): the practice panel and the range run panel are
// exclusive (QVIEW-01-AC09), so opening one over the other first closes it as above and then
// pushes the open where the close lands, instead of truncating (the push drops the forward entries
// just as well). The closed panel is then in neither direction; Back from the opened one closes it.
//
// Each entry of ours records in `history.state` (beside Next's keys) its position (`pos`, to tell
// Back from Forward), its depth (entries above its base) and, on a skip entry, how far to skip.
// Next's patched pushState/replaceState copy its internals into the object we pass, and its
// Back/Forward restores keep custom state; router navigations (router.replace/refresh) drop it, so
// the home stamps it back (stamp) after renders and before every push.

import { closeDialog, openDialogs, withoutPanels } from './home';

export const PANEL_POS_KEY = '__quizPanelPos';
export const PANEL_DEPTH_KEY = '__quizPanelDepth';
/** On a real entry: how many skip entries lie directly below it. */
export const PANEL_UNDER_KEY = '__quizPanelUnder';
/** On a skip entry: how many entries Back onto it goes on back. */
export const PANEL_SKIP_KEY = '__quizPanelSkip';
/** The depth each open dialog was opened at (closing the top one rewinds only to below it). */
export const PANEL_OPENED_KEY = '__quizPanelOpened';
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
  /** Open dialog → the depth of the entry that opened it (missing: unknown). */
  readonly opened?: Readonly<Record<string, number>>;
}

function readOpened(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, number> = {};
  for (const [dialog, depth] of Object.entries(value as Record<string, unknown>)) {
    if (typeof depth === 'number' && Number.isInteger(depth) && depth >= 0) out[dialog] = depth;
  }
  return out;
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
      opened: readOpened(record[PANEL_OPENED_KEY]),
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
  out[PANEL_OPENED_KEY] = { ...(mark.opened ?? {}) };
  if (skip > 0) out[PANEL_SKIP_KEY] = skip;
  return out;
}

/** The home's dialog URL helpers (home.ts), bound to the page's current content search. */
export interface DialogUrls {
  /** The open dialogs of `search` (openDialogs). */
  open(search: string): readonly string[];
  /** `search` with `dialog` closed, as its close button does it (closeDialog). */
  close(search: string, dialog: string): string;
  /** `search` with every dialog closed (withoutPanels). */
  closeAll(search: string): string;
  /**
   * Rewrites the current entry to `url` through the router (router.replace: it reads the page).
   * Used when a close lands on an entry whose page (filters, searches) differs from the closed
   * URL: a plain history write would leave the entry's saved Next tree under another address,
   * which Next then reloads in full.
   */
  read?(url: string): void;
}

export const DEFAULT_DIALOG_URLS: DialogUrls = {
  open: openDialogs,
  close: (search, dialog) => closeDialog(search, dialog),
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
  /** Whether this document was loaded by Back/Forward (performance navigation type). */
  arrivedByTraversal?(): boolean;
}

/** Where a document of the home was when it unloaded. */
interface Leave {
  readonly pos: number;
  /**
   * The address it rested on: path and query only (never a fragment), as in the address bar. It
   * stays in sessionStorage (this tab), is read once and expires; it is never logged.
   */
  readonly address: string;
}

/** `url` without its fragment (share links carry their secret there: never stored). */
function withoutFragment(url: string): string {
  const at = url.indexOf('#');
  return at === -1 ? url : url.slice(0, at);
}

/** Same path and the same query parameters, whatever their order. */
function sameAddress(a: string, b: string): boolean {
  const x = splitUrl(a);
  const y = splitUrl(b);
  if (x.path !== y.path) return false;
  const sorted = (search: string) => {
    const params = new URLSearchParams(search);
    params.sort();
    return params.toString();
  };
  return sorted(x.search) === sorted(y.search);
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
      typeof value.address === 'string' &&
      value.address.startsWith('/') &&
      !value.address.includes('#')
    ) {
      return { pos: value.pos, address: value.address };
    }
  } catch {
    // A malformed value is no record.
  }
  return null;
}

/** A close waiting for its rewind to land on the base, or below the closed dialog (`pos`). */
interface Rewind {
  readonly pos: number;
  /** The target with every dialog closed. */
  readonly base: string;
  /** Pushed above the base when dialogs stay open. */
  readonly reopen: string | null;
  /**
   * Set when the rewind lands on the entry before the closed (top-most) dialog's open instead of
   * the base: that entry, which shows exactly the dialogs that stay, is rewritten to this target.
   */
  readonly below: string | null;
  /** Pushed once the close landed (close(url, open)). */
  readonly open: string | null;
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
      (typeof value.reopen === 'string' || value.reopen === null) &&
      (typeof value.below === 'string' || value.below === null) &&
      (typeof value.open === 'string' || value.open === null || value.open === undefined)
    ) {
      return {
        pos: value.pos,
        base: value.base,
        reopen: value.reopen,
        below: value.below,
        open: value.open ?? null,
      };
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
  /** A close waiting for the router to read the page of its entry (onPage). */
  private reading: { readonly url: string; readonly then: () => void } | null = null;
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
      // A close's rewind loaded this document (its landing entry): finish the close here.
      this.mark = { ...entry.mark, pos: handover.pos };
      this.land(handover);
    } else if (entry.ours) {
      this.arrive(entry, leave);
    } else {
      this.expandFirstLoad();
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
      this.reading = null;
    };
  }

  /** Puts the marks back on the current entry when a router navigation dropped them. */
  stamp(): void {
    if (this.pending) return;
    const state: unknown = this.win.history.state;
    const entry = readEntry(state);
    const reading = this.reading;
    if (reading) {
      // The router's write of the closed page (Next's state only, none of our marks): finish.
      if (entry.ours || !sameAddress(this.current(), reading.url)) return;
      this.reading = null;
      this.win.history.replaceState(markState(state, this.mark), '');
      reading.then();
      return;
    }
    const { mark } = this;
    // Another entry of ours whose popstate has not come yet (a render can run in between):
    // leave it, and what the page rested on, to onPopState.
    if (entry.ours && entry.mark.pos !== mark.pos) return;
    this.resting = this.current();
    if (
      entry.ours &&
      entry.skip === 0 &&
      entry.mark.depth === mark.depth &&
      entry.mark.under === mark.under &&
      JSON.stringify(entry.mark.opened ?? {}) === JSON.stringify(mark.opened ?? {})
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
    const depth = this.mark.depth + 1;
    // Dialogs open already keep the depth they were opened at; the new one is opened here.
    const opened: Record<string, number> = {};
    const before = this.getDialogs().open(this.win.location.search);
    for (const dialog of this.getDialogs().open(splitUrl(target).search)) {
      const known = this.mark.opened?.[dialog];
      opened[dialog] = before.includes(dialog) ? (known ?? 0) : depth;
    }
    this.mark = { pos: this.mark.pos + 1, depth, under: 0, opened };
    this.win.history.pushState(markState(null, this.mark), '', target);
    this.resting = target;
  }

  /** Rewrites the current entry (filters, searches): no new entry, same marks. */
  replace(url: string): void {
    this.win.history.replaceState(markState(null, this.mark), '', url);
    this.resting = this.current();
  }

  /**
   * Closes to `url` (see the module comment), then, with `open`, opens that on a new entry where
   * the close lands (one panel replacing another, QVIEW-01-AC09).
   */
  close(url: string, open: string | null = null): void {
    if (this.pending) return;
    const target = pathAndQuery(url, this.win.location.href);
    const then = open === null ? null : pathAndQuery(open, this.win.location.href);
    if (target === this.current()) {
      if (then !== null) this.push(then);
      return;
    }
    const { path, search } = splitUrl(target);
    const base = `${path}${this.getDialogs().closeAll(search)}`;
    const reopen = base === target ? null : target;
    if (this.mark.depth > 0) {
      const steps = this.rewindSteps(target);
      const below = steps < this.mark.depth ? target : null;
      const rewind: Rewind = { pos: this.mark.pos - steps, base, reopen, below, open: then };
      const pending: Pending = { kind: 'rewind', ...rewind, fallback: target, timer: 0 };
      pending.timer = this.win.setTimeout(() => {
        // The traversal never came: close in place rather than leave the dialog open.
        if (this.pending !== pending) return;
        this.pending = null;
        this.takeRewind();
        this.replace(pending.fallback);
        if (pending.open !== null) this.push(pending.open);
      }, TRAVERSAL_TIMEOUT_MS);
      this.pending = pending;
      this.storeRewind(rewind);
      this.win.history.go(-steps);
      return;
    }
    if (reopen === null && this.win.navigation?.canGoForward === false) {
      this.replace(target);
      if (then !== null) this.push(then);
      return;
    }
    this.settle(base, reopen, then);
  }

  /**
   * How far a close to `target` goes back. Closing the top-most opened dialog (the others were
   * open before it) goes only to the entry before its open, which shows exactly the dialogs that
   * stay: passing through an entry without them would unmount them (Chromium renders a traversed
   * entry before its popstate arrives), and they would lose state and focus. Otherwise: the base.
   */
  private rewindSteps(target: string): number {
    const dialogs = this.getDialogs();
    const stay = dialogs.open(splitUrl(target).search);
    const closed = dialogs.open(this.win.location.search).filter((d) => !stay.includes(d));
    const opened = this.mark.opened ?? {};
    const [dialog] = closed;
    if (closed.length !== 1 || dialog === undefined || stay.length === 0) return this.mark.depth;
    const at = opened[dialog];
    if (at === undefined || at < 2 || at > this.mark.depth) return this.mark.depth;
    if (!stay.every((d) => opened[d] !== undefined && (opened[d] ?? at) < at)) {
      return this.mark.depth;
    }
    return this.mark.depth - (at - 1);
  }

  /** Where a close's rewind landed: the base (settle) or the entry below the closed dialog. */
  private land(rewind: Rewind): void {
    const { below, open } = rewind;
    if (below !== null) {
      // The open's push drops the forward entries as a truncate would.
      this.onPage(below, () => (open !== null ? this.push(open) : this.truncate()));
      this.resting = open ?? below;
      return;
    }
    this.settle(rewind.base, rewind.reopen, open);
  }

  /**
   * On the base entry: rewrite it to `base`, then push the dialogs still open, or a copy of it
   * (the base becomes a skip entry); then `open` on its own entry, which drops the forward
   * entries itself (no copy then).
   */
  private settle(base: string, reopen: string | null, open: string | null = null): void {
    this.mark = { ...this.mark, depth: 0 };
    this.onPage(base, () => {
      if (reopen) {
        const opened = Object.fromEntries(
          this.getDialogs()
            .open(splitUrl(reopen).search)
            .map((d) => [d, 1]),
        );
        this.mark = { pos: this.mark.pos + 1, depth: 1, under: 0, opened };
        // Only dialog keys differ from the base: Next syncs its URL from the plain write.
        this.win.history.pushState(markState(null, this.mark), '', reopen);
        this.resting = this.current();
      } else if (open === null) {
        this.truncate();
      }
      if (open !== null) this.push(open);
    });
    this.resting = open ?? reopen ?? base;
  }

  /**
   * Runs `then` once the current entry shows `url`: rewritten at once when only dialog keys
   * differ (Next syncs its URL), else through the router, which reads the page first (stamp()
   * finishes when its write lands). The router call waits for the popstate dispatch this may run
   * in: a router action dispatched before Next's own Back/Forward restore would be overridden by
   * it (WebKit runs our listener first).
   */
  private onPage(url: string, then: () => void): void {
    const dialogs = this.getDialogs();
    const samePage =
      dialogs.closeAll(splitUrl(url).search) === dialogs.closeAll(this.win.location.search);
    const read = dialogs.read;
    if (samePage || !read) {
      if (url !== this.current()) {
        this.win.history.replaceState(markState(null, this.mark), '', url);
      }
      then();
      return;
    }
    this.reading = { url, then };
    this.win.setTimeout(() => read(url), 0);
  }

  /**
   * Makes the current entry a skip entry and pushes a copy of it, dropping every forward entry
   * (the closed dialog). Neither write changes the address: Next is not told.
   */
  private truncate(): void {
    const { history } = this.win;
    const skip = this.mark.under + 1;
    history.replaceState(markState(history.state, this.mark, skip), '');
    const dialogs = this.getDialogs().open(this.win.location.search);
    const known = this.mark.opened ?? {};
    const opened: Record<string, number> = {};
    for (const dialog of dialogs) {
      const at = known[dialog];
      if (at !== undefined) opened[dialog] = at;
    }
    this.mark = {
      pos: this.mark.pos + 1,
      depth: dialogs.length > 0 ? this.mark.depth + 1 : 0,
      under: skip,
      opened,
    };
    history.pushState(markState(history.state, this.mark), '');
    this.resting = this.current();
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
    if (!leave || !entry.ours || entry.mark.pos >= leave.pos) return;
    this.closeBehind(leave.address);
  }

  /**
   * After a Back from `from` (path and query) onto the current entry: when that Back closed
   * dialogs (not one that changed the practice panel's question), rewrites the entry to `from`
   * with those dialogs closed, keeping what changed while they were open (UX7 확인 7), and drops
   * the forward entry. Within one document (onPopState) and across documents (arrive).
   */
  private closeBehind(from: string): void {
    const dialogs = this.getDialogs();
    const now = dialogs.open(this.win.location.search);
    const fromUrl = splitUrl(from);
    if (fromUrl.path !== this.win.location.pathname) return;
    const closed = dialogs.open(fromUrl.search).filter((d) => !now.includes(d));
    if (closed.length === 0) return;
    let search = fromUrl.search;
    for (const dialog of closed) search = dialogs.close(search, dialog);
    const target = `${fromUrl.path}${search}`;
    this.onPage(sameAddress(target, this.current()) ? this.current() : target, () =>
      this.truncate(),
    );
    this.resting = target;
  }

  /**
   * A first load (an entry not ours) with dialogs open, a deep link: rewrites the entry to the
   * address with every dialog closed and pushes one entry per dialog in opening order, so each
   * Back closes one (UX7 확인 7). Only dialog keys differ between these entries, which Next shows
   * from the same page: it is not told (it already shows the top one). Skipped for a Back/Forward
   * arrival or with entries ahead, which a push would drop.
   */
  private expandFirstLoad(): void {
    const traversal = this.win.arrivedByTraversal?.() ?? false;
    if (traversal || this.win.navigation?.canGoForward === true) return;
    const dialogs = this.getDialogs();
    const { path, search } = splitUrl(this.current());
    const open = dialogs.open(search);
    if (open.length === 0) return;
    const chain = [this.current()];
    let closing = search;
    for (let i = open.length - 1; i >= 0; i--) {
      const dialog = open[i];
      if (dialog === undefined) continue;
      closing = dialogs.close(closing, dialog);
      chain.unshift(`${path}${closing}`);
    }
    const { history } = this.win;
    chain.forEach((url, depth) => {
      const opened = Object.fromEntries(open.slice(0, depth).map((d, i) => [d, i + 1]));
      this.mark = { pos: depth, depth, under: 0, opened };
      const state = markState(history.state, this.mark);
      if (depth === 0) history.replaceState(state, '', url);
      else history.pushState(state, '', url);
    });
    this.resting = this.current();
  }

  private storeLeave(): void {
    try {
      const record = {
        pos: this.mark.pos,
        address: withoutFragment(this.resting),
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
    this.reading = null;
    const pending = this.pending;
    if (pending) {
      this.win.clearTimeout(pending.timer);
      this.pending = null;
    }
    const entry = readEntry(event.state);
    if (pending?.kind === 'rewind') {
      // Landed (Next restores the entry): finish the close there.
      this.takeRewind();
      this.mark = entry.mark;
      this.land(pending);
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
    if (back) this.closeBehind(from);
  }
}
