// Browser history of the workspace home's dialogs and panels (UX7-BACK, UX7-BACK-2, docs/screens/
// questions-overview.md "뒤로가기", QOV-01-AC14). The rule: a closed dialog is never in the
// history, in either direction; while dialogs are open each Back closes one of them; closing
// returns to the address before the open, keeping what changed meanwhile (filters, searches).
//
// Opening a dialog (or moving the practice panel to another question) pushes an entry, so Back
// while it is open undoes the open. Browsers cannot drop forward entries except by writing a new
// one, so every close ends with a push that truncates them:
// - A close button (or Escape, save, delete) at depth d first goes back d entries to the base
//   (the entry before the first open), writes the closed URL there, and then either pushes one
//   entry for the dialogs still open (Back then closes those) or, with none left, marks the base
//   "skip" and pushes the closed URL again.
// - A Back that closes a dialog lands on the entry before its open: that entry is marked "skip"
//   and the closed URL (the address before the Back with that dialog closed) is pushed again.
// A skip entry duplicates the entry above it: Back onto it goes on back (`skip` entries, the run
// of skip entries below it included) and Forward onto it goes on forward, before Next renders it
// (our listener runs in the capture phase and stops Next's). Without a forward entry to drop
// (Navigation API `canGoForward`), a close at depth 0 just rewrites the entry.
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

/** How long a close (or a skip) waits for the traversal it started before settling in place. */
export const REWIND_TIMEOUT_MS = 1000;

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
  /** `search` with `dialog` closed (closeDialog). */
  close(search: string, dialog: string): string;
  /** `search` with every dialog closed (withoutPanels). */
  closeAll(search: string): string;
}

export const DEFAULT_DIALOG_URLS: DialogUrls = {
  open: openDialogs,
  close: (search, dialog) => closeDialog(search, dialog),
  closeAll: (search) => withoutPanels(search),
};

export interface PanelHistoryWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
  readonly location: Pick<Location, 'pathname' | 'search' | 'href'>;
  /** The Navigation API where the browser has it. */
  readonly navigation?: { readonly canGoForward: boolean } | undefined;
  addEventListener(
    type: 'popstate',
    listener: (event: PopStateEvent) => void,
    options: { capture: boolean },
  ): void;
  removeEventListener(
    type: 'popstate',
    listener: (event: PopStateEvent) => void,
    options: { capture: boolean },
  ): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

type Pending =
  | {
      readonly kind: 'rewind';
      /** Written onto the base: the target with every dialog closed. */
      readonly base: string;
      /** Pushed after the base when dialogs stay open. */
      readonly reopen: string | null;
      readonly fallback: string;
      timer: number;
    }
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
    // Arrived on a skip entry (a reload, or Forward from another document): stay on it.
    if (entry.skip > 0) this.rest(this.current());
    const onPopState = (event: PopStateEvent) => this.onPopState(event);
    this.win.addEventListener('popstate', onPopState, CAPTURE);
    return () => {
      this.win.removeEventListener('popstate', onPopState, CAPTURE);
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
      entry.mark.pos === mark.pos &&
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
      const pending: Pending = { kind: 'rewind', base, reopen, fallback: target, timer: 0 };
      pending.timer = this.win.setTimeout(() => {
        // The traversal never came: close in place rather than leave the dialog open.
        if (this.pending !== pending) return;
        this.pending = null;
        this.replace(pending.fallback);
      }, REWIND_TIMEOUT_MS);
      this.pending = pending;
      this.win.history.go(-this.mark.depth);
      return;
    }
    if (reopen === null && this.win.navigation?.canGoForward === false) {
      this.replace(target);
      return;
    }
    this.settle(base, reopen);
  }

  /** On the base entry: write `base`, then the dialogs still open or a truncating copy. */
  private settle(base: string, reopen: string | null): void {
    this.mark = { ...this.mark, depth: 0 };
    this.win.history.replaceState(markState(null, this.mark), '', base);
    if (reopen) {
      this.mark = { pos: this.mark.pos + 1, depth: 1, under: 0 };
      this.win.history.pushState(markState(null, this.mark), '', reopen);
    } else {
      this.truncate(base);
    }
    this.resting = this.current();
  }

  /**
   * Rewrites the current entry to `url` as a skip entry and pushes a copy above it, dropping every
   * forward entry (the closed dialog). Only an address change is Next's to render; the copy is
   * pushed without telling it. The skip entry carries `url` too: a page that lands on it from
   * another document (Forward from the page before the home) shows the closed address.
   */
  private truncate(url: string): void {
    const { history } = this.win;
    const skip = this.mark.under + 1;
    if (url === this.current()) {
      history.replaceState(markState(history.state, this.mark, skip), '');
    } else {
      history.replaceState(markState(null, this.mark, skip), '', url);
    }
    const dialogs = this.getDialogs().open(splitUrl(url).search);
    this.mark = {
      pos: this.mark.pos + 1,
      depth: dialogs.length > 0 ? this.mark.depth + 1 : 0,
      under: skip,
    };
    history.pushState(markState(history.state, this.mark), '');
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

  private onPopState(event: PopStateEvent): void {
    const pending = this.pending;
    if (pending) {
      this.win.clearTimeout(pending.timer);
      this.pending = null;
    }
    const entry = readEntry(event.state);
    if (pending?.kind === 'rewind') {
      // Landed on the base: write the closed URL there (Next then restores what we wrote).
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
      }, REWIND_TIMEOUT_MS);
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
    // forward entry, keeping what changed while they were open.
    const dialogs = this.getDialogs();
    const now = dialogs.open(this.win.location.search);
    const fromUrl = splitUrl(from);
    if (fromUrl.path !== this.win.location.pathname) return;
    const closed = dialogs.open(fromUrl.search).filter((d) => !now.includes(d));
    if (closed.length === 0) return;
    let search = fromUrl.search;
    for (const dialog of closed) search = dialogs.close(search, dialog);
    const target = `${fromUrl.path}${search}`;
    this.truncate(sameAddress(target, this.current()) ? this.current() : target);
    this.resting = this.current();
  }
}
