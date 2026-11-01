// Browser history of the workspace home's dialogs and panels (UX7-BACK, docs/screens/
// questions-overview.md "뒤로가기", QOV-01-AC14).
//
// Opening a dialog (or moving the practice panel to another question) pushes an entry, so Back
// while it is open undoes the open. Closing one must not leave those entries behind, or Back
// after the close would reopen it. Every entry the home pushes records its depth: how many of
// our entries lie above the entry the home was on before the first open (the base, depth 0).
// A close at depth d goes back d entries to the base, writes the closed URL there (everything
// that changed meanwhile, e.g. filters, survives), and pushes one entry again when other dialogs
// are still open, so Back then closes those. At depth 0 (a deep link, or after a reload without
// entries of ours) there is nothing to undo: the close rewrites the current entry.
//
// The depth lives in `history.state` beside Next's own keys: Next's patched pushState/replaceState
// copy its internals into the object we pass, and Back/Forward restores keep custom state. Router
// navigations (router.replace/refresh) rewrite the state without it, so the home stamps it back
// (stamp) after renders and before every push.

export const PANEL_DEPTH_KEY = '__quizPanelDepth';

/** How long a close waits for the Back traversal it started before rewriting in place. */
export const REWIND_TIMEOUT_MS = 1000;

/** The depth an entry's state records (0 when it has none). */
export function entryDepth(state: unknown): number {
  if (typeof state !== 'object' || state === null) return 0;
  const value = (state as Record<string, unknown>)[PANEL_DEPTH_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** What closing to `target` does to the history. */
export type ClosePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'replace'; readonly url: string }
  | {
      readonly kind: 'rewind';
      readonly steps: number;
      /** Written onto the base entry: `target` with every dialog closed. */
      readonly base: string;
      /** Pushed again after the base when dialogs remain open in `target`. */
      readonly reopen: string | null;
    };

/**
 * The plan for closing from `current` to `target` (both path + query) at `depth`. `base` is
 * `target` with every dialog and panel closed.
 */
export function planClose(current: string, target: string, depth: number, base: string): ClosePlan {
  if (target === current) return { kind: 'none' };
  if (depth <= 0) return { kind: 'replace', url: target };
  return { kind: 'rewind', steps: depth, base, reopen: base === target ? null : target };
}

export interface PanelHistoryWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
  readonly location: Pick<Location, 'pathname' | 'search' | 'href'>;
  addEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
  removeEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

interface Rewind {
  readonly base: string;
  readonly reopen: string | null;
  readonly fallback: string;
  timer: number;
}

/** Path + query of `url` (resolved against `href`). */
function pathAndQuery(url: string, href: string): string {
  const parsed = new URL(url, href);
  return `${parsed.pathname}${parsed.search}`;
}

export class PanelHistory {
  private depth = 0;
  private rewind: Rewind | null = null;

  constructor(
    /** The browser window (a getter: the home also renders on the server). */
    private readonly getWindow: () => PanelHistoryWindow,
  ) {}

  private get win(): PanelHistoryWindow {
    return this.getWindow();
  }

  /** Follows Back/Forward; returns the detach function. */
  attach(): () => void {
    this.depth = entryDepth(this.win.history.state);
    const onPopState = (event: PopStateEvent) => this.onPopState(event);
    this.win.addEventListener('popstate', onPopState);
    return () => {
      this.win.removeEventListener('popstate', onPopState);
      if (this.rewind) this.win.clearTimeout(this.rewind.timer);
      this.rewind = null;
    };
  }

  private current(): string {
    return `${this.win.location.pathname}${this.win.location.search}`;
  }

  /** Puts the depth back on the current entry when a router navigation dropped it. */
  stamp(): void {
    if (this.rewind) return;
    const state: unknown = this.win.history.state;
    if (entryDepth(state) === this.depth) return;
    // Next's own keys are in `state`: its patched replaceState passes the write straight through.
    const base = typeof state === 'object' && state !== null ? state : {};
    this.win.history.replaceState({ ...base, [PANEL_DEPTH_KEY]: this.depth }, '');
  }

  /** Opens a dialog or moves a panel on a new entry (Back undoes it). */
  push(url: string): void {
    if (this.rewind) return;
    const target = pathAndQuery(url, this.win.location.href);
    if (target === this.current()) return;
    this.stamp();
    this.depth += 1;
    this.win.history.pushState({ [PANEL_DEPTH_KEY]: this.depth }, '', target);
  }

  /** Rewrites the current entry (filters, searches): no new entry, same depth. */
  replace(url: string): void {
    this.win.history.replaceState({ [PANEL_DEPTH_KEY]: this.depth }, '', url);
  }

  /**
   * Closes to `url`: undoes the entries pushed since the base (see the module comment).
   * `withoutPanels` gives a query with every dialog and panel closed (home.ts withoutPanels).
   */
  close(url: string, withoutPanels: (search: string) => string): void {
    if (this.rewind) return;
    const href = this.win.location.href;
    const target = pathAndQuery(url, href);
    const parsed = new URL(target, href);
    const base = `${parsed.pathname}${withoutPanels(parsed.search)}`;
    const plan = planClose(this.current(), target, this.depth, base);
    if (plan.kind === 'none') return;
    if (plan.kind === 'replace') {
      this.replace(plan.url);
      return;
    }
    const rewind: Rewind = { base: plan.base, reopen: plan.reopen, fallback: target, timer: 0 };
    rewind.timer = this.win.setTimeout(() => {
      // The traversal never came: close in place rather than leave the dialog open.
      if (this.rewind !== rewind) return;
      this.rewind = null;
      this.replace(rewind.fallback);
    }, REWIND_TIMEOUT_MS);
    this.rewind = rewind;
    this.win.history.go(-plan.steps);
  }

  private onPopState(event: PopStateEvent): void {
    const rewind = this.rewind;
    if (!rewind) {
      this.depth = entryDepth(event.state);
      return;
    }
    // Landed on the base (Next's listener has already started restoring it): write the closed
    // URL there, then one entry for the dialogs that stay open.
    this.rewind = null;
    this.win.clearTimeout(rewind.timer);
    this.depth = 0;
    this.win.history.replaceState({ [PANEL_DEPTH_KEY]: 0 }, '', rewind.base);
    if (rewind.reopen) {
      this.depth = 1;
      this.win.history.pushState({ [PANEL_DEPTH_KEY]: 1 }, '', rewind.reopen);
    }
  }
}
