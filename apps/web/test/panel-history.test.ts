// UX7-BACK, UX7-BACK-2 (QOV-01-AC14): the workspace home's dialog history. Opening pushes an
// entry; every close (button or Back) drops the closed dialog's entries, so neither Back nor
// Forward reopens it.
import { describe, expect, it } from 'vitest';
import { openDialogs, withoutPanels } from '../src/lib/workspaces/home';
import {
  markState,
  PANEL_DEPTH_KEY,
  PANEL_POS_KEY,
  PANEL_SKIP_KEY,
  PANEL_UNDER_KEY,
  PanelHistory,
  readEntry,
  type PanelHistoryWindow,
} from '../src/lib/workspaces/panel-history';

const ORIGIN = 'http://home.test';

interface Entry {
  url: string;
  state: unknown;
}

/**
 * A session history with Next's patched methods reduced to plain entry writes. `go` is delivered
 * by `traverse` (the browser does it asynchronously) and ignored out of range, as browsers do.
 * A stand-in for Next's popstate listener (registered first, not in the capture phase) counts the
 * entries Next would render.
 */
function fakeWindow(
  start: string,
  opts: {
    startState?: unknown;
    navigation?: boolean;
    firstEntry?: boolean;
    storage?: Map<string, string>;
  } = {},
) {
  const storage = opts.storage ?? new Map<string, string>();
  let clock = 1_000_000;
  const entries: Entry[] = [
    ...(opts.firstEntry ? [] : [{ url: '/workspaces', state: null }]),
    { url: start, state: opts.startState ?? { __NA: true } },
  ];
  let index = entries.length - 1;
  const entry = (i = index): Entry => {
    const found = entries[i];
    if (!found) throw new Error(`no entry ${i}`);
    return found;
  };
  const capture = new Set<(event: PopStateEvent) => void>();
  /** Page lifecycle listeners (pagehide, pageshow) of the current document. */
  const lifecycle = new Map<string, Set<(event: Event) => void>>();
  const rendered: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let pendingGo: number | null = null;
  const at = () => new URL(entry().url, ORIGIN);
  const win: PanelHistoryWindow = {
    history: {
      get state() {
        return entry().state;
      },
      pushState(state: unknown, _unused: string, url?: string | URL | null) {
        const target = String(url ?? entry().url);
        entries.splice(index + 1);
        entries.push({ url: target, state });
        index += 1;
      },
      replaceState(state: unknown, _unused: string, url?: string | URL | null) {
        entries[index] = { url: String(url ?? entry().url), state };
      },
      go(delta?: number) {
        pendingGo = delta ?? 0;
      },
    },
    location: {
      get pathname() {
        return at().pathname;
      },
      get search() {
        return at().search;
      },
      get href() {
        return at().href;
      },
    },
    get navigation() {
      return opts.navigation ? { canGoForward: index < entries.length - 1 } : undefined;
    },
    addEventListener: (type, listener, options) => {
      if (type === 'popstate') {
        expect(options).toEqual({ capture: true });
        capture.add(listener as (event: PopStateEvent) => void);
        return;
      }
      const set = lifecycle.get(type) ?? new Set();
      set.add(listener as (event: Event) => void);
      lifecycle.set(type, set);
    },
    removeEventListener: (type, listener) => {
      if (type === 'popstate') capture.delete(listener as (event: PopStateEvent) => void);
      else lifecycle.get(type)?.delete(listener as (event: Event) => void);
    },
    setTimeout: (handler) => {
      timers.set(nextTimer, handler);
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
    now: () => clock,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  /** Delivers the traversal a `go` started; false when there was none (or out of range). */
  function traverseOnce(beforeEvent?: () => void): boolean {
    if (pendingGo === null) return false;
    const target = index + pendingGo;
    pendingGo = null;
    if (target < 0 || target >= entries.length) return false;
    index = target;
    beforeEvent?.();
    let stopped = false;
    const event = {
      state: entry().state,
      stopImmediatePropagation: () => {
        stopped = true;
      },
    } as PopStateEvent;
    for (const listener of capture) listener(event);
    if (!stopped) rendered.push(entry().url);
    return true;
  }
  return {
    win,
    url: () => entry().url,
    urls: () => entries.map((e) => e.url),
    index: () => index,
    skips: () => entries.map((e) => readEntry(e.state).skip),
    /** URLs Next's listener got to render. */
    rendered,
    /** Delivers traversals until the page rests (our skips start further ones). */
    /** `beforeEvent` runs once the address changed, before popstate (a render in between). */
    traverse(beforeEvent?: () => void) {
      for (let i = 0; i < 10 && traverseOnce(i === 0 ? beforeEvent : undefined); i++);
    },
    back() {
      win.history.go(-1);
      this.traverse();
    },
    forward() {
      win.history.go(1);
      this.traverse();
    },
    storage,
    tick(ms: number) {
      clock += ms;
    },
    /**
     * The traversal a `go` started, into another document: no popstate (the page unloads and
     * its listeners and timers go with it). Attach a new PanelHistory to continue.
     */
    traverseToDocument() {
      if (pendingGo === null) return;
      this.leaveDocument();
      index += pendingGo;
      pendingGo = null;
    },
    /** The current document unloads (pagehide), taking its listeners and timers with it. */
    leaveDocument() {
      for (const listener of lifecycle.get('pagehide') ?? []) {
        listener({ persisted: false } as PageTransitionEvent);
      }
      capture.clear();
      lifecycle.clear();
      timers.clear();
    },
    /** A Back/Forward into another document that the browser loads afresh. */
    goToDocument(delta: number) {
      win.history.go(delta);
      this.traverseToDocument();
    },
    fireTimers() {
      for (const [id, handler] of [...timers]) {
        timers.delete(id);
        handler();
      }
    },
  };
}

type Fake = ReturnType<typeof fakeWindow>;

function controller(start = '/w', opts: Parameters<typeof fakeWindow>[1] = {}) {
  const fake = fakeWindow(start, opts);
  const history = new PanelHistory(() => fake.win);
  history.attach();
  history.stamp();
  return { fake, history };
}

/**
 * From the closed home: Back reaches the page before it, Forward comes back to a closed home (the
 * skip entry, with the address before the open), the next one to `closed`, and no further.
 */
function expectBackLeavesForwardStaysClosed(fake: Fake, closed = '/w') {
  fake.back();
  expect(fake.url()).toBe('/workspaces');
  fake.forward();
  expect(openDialogs(new URL(fake.url(), ORIGIN).search)).toEqual([]);
  fake.forward();
  expect(fake.url()).toBe(closed);
  expect(fake.index()).toBe(fake.urls().length - 1);
}

describe('entry marks', () => {
  it('reads only positive integer marks, and a fresh entry is not ours', () => {
    expect(readEntry(null)).toEqual({
      ours: false,
      mark: { pos: 0, depth: 0, under: 0 },
      skip: 0,
    });
    expect(
      readEntry({ [PANEL_POS_KEY]: 3, [PANEL_DEPTH_KEY]: 2, [PANEL_UNDER_KEY]: '1', x: 1 }),
    ).toEqual({ ours: true, mark: { pos: 3, depth: 2, under: 0 }, skip: 0 });
    expect(readEntry({ [PANEL_POS_KEY]: 1, [PANEL_SKIP_KEY]: -1 }).skip).toBe(0);
  });

  it("keeps Next's keys and drops the skip mark of a real entry", () => {
    const mark = { pos: 1, depth: 0, under: 2 };
    expect(markState({ __NA: true, [PANEL_SKIP_KEY]: 1 }, mark)).toEqual({
      __NA: true,
      [PANEL_POS_KEY]: 1,
      [PANEL_DEPTH_KEY]: 0,
      [PANEL_UNDER_KEY]: 2,
    });
    expect(markState(null, mark, 3)[PANEL_SKIP_KEY]).toBe(3);
  });
});

describe('openDialogs and withoutPanels', () => {
  it('lists the dialogs and the practice panel, not which question or document they show', () => {
    expect(openDialogs('?status=retry&panel=documents&panel=history&question=q1')).toEqual([
      'documents',
      'history',
      'question',
    ]);
    expect(openDialogs('?panel=bogus&q=x')).toEqual([]);
  });

  it('closes every dialog and the practice panel, keeping filters and searches', () => {
    expect(withoutPanels('?status=retry&panel=documents&panel=history&question=q1&q=x')).toBe(
      '?status=retry&q=x',
    );
    // The 정리 노트 panel takes `chapter`; the summary panel hands `document` back.
    expect(withoutPanels('?panel=chapter-note&chapter=c1&text=a')).toBe('?text=a');
    expect(
      withoutPanels('?panel=document-summary&document=d1&text=a', {
        documentId: 'd2',
        chapterId: null,
      }),
    ).toBe('?document=d2&text=a');
    expect(withoutPanels('')).toBe('');
  });
});

describe('PanelHistory', () => {
  it('open → close: Back leaves the home and Forward never reopens the dialog', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=documents']);
    history.close('/w');
    expect(fake.url()).toBe('/w?panel=documents'); // waits for the traversal
    fake.traverse();
    // The base is a skip entry under a copy that dropped the dialog's forward entry.
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    expect(fake.skips()).toEqual([0, 1, 0]);
    expect(fake.index()).toBe(2);
    fake.rendered.length = 0;
    expectBackLeavesForwardStaysClosed(fake);
    // Next never rendered the skip entry on the way back.
    expect(fake.rendered[0]).toBe('/workspaces');
  });

  it('Back while open closes it; Forward has nothing to reopen', () => {
    const { fake, history } = controller();
    history.push('/w?panel=history');
    fake.back();
    expect(fake.url()).toBe('/w');
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    fake.forward();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a Back that closes restores the address before the open (SEARCH-01-AC09)', () => {
    const { fake, history } = controller('/w?q=a');
    history.push('/w?q=a&panel=documents');
    history.replace('/w?q=a&panel=documents&status=retry');
    fake.back();
    expect(fake.url()).toBe('/w?q=a');
    expectBackLeavesForwardStaysClosed(fake, '/w?q=a');
  });

  it('stacked dialogs: each Back closes the top one, Forward reopens neither', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.push('/w?panel=documents&panel=history');
    fake.back();
    expect(fake.url()).toBe('/w?panel=documents');
    fake.forward();
    expect(fake.url()).toBe('/w?panel=documents');
    fake.back();
    expect(fake.url()).toBe('/w');
    fake.forward();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a render between the Back and its popstate neither restamps nor moves the start', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.push('/w?panel=documents&panel=history');
    fake.win.history.go(-1);
    fake.traverse(() => history.stamp());
    // The Back closed 이력 only: one Back each, then the page before the home.
    expect(fake.url()).toBe('/w?panel=documents');
    expect(fake.skips()).toEqual([0, 0, 1, 0]);
    fake.back();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a stacked close keeps the dialog still open on one entry; Back then closes it', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.push('/w?panel=documents&panel=history');
    history.close('/w?panel=history');
    fake.traverse();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=history']);
    fake.back();
    expect(fake.url()).toBe('/w');
    fake.forward();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a stacked close after a Back that closed the top one rewinds over the skip entry', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.push('/w?panel=documents&panel=history');
    fake.back(); // closes 이력
    history.close('/w');
    fake.traverse();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it("the practice panel's previous/next stay Back/Forward steps; closing drops them", () => {
    const { fake, history } = controller();
    history.push('/w?question=1');
    history.push('/w?question=2');
    history.push('/w?question=3');
    fake.back();
    expect(fake.url()).toBe('/w?question=2');
    fake.forward();
    expect(fake.url()).toBe('/w?question=3');
    fake.back();
    fake.back();
    expect(fake.url()).toBe('/w?question=1');
    fake.back();
    expect(fake.url()).toBe('/w');
    fake.forward();
    expect(fake.url()).toBe('/w');
    // Reopened, moved, then closed with its button.
    history.push('/w?question=1');
    history.push('/w?question=2');
    fake.back();
    history.close('/w');
    fake.traverse();
    expect(fake.url()).toBe('/w');
    fake.rendered.length = 0;
    expectBackLeavesForwardStaysClosed(fake);
    // One traversal over the whole run of skip entries.
    expect(fake.rendered[0]).toBe('/workspaces');
  });

  it('keeps what changed while open (filters) on the entry above the base', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.replace('/w?panel=documents&status=retry');
    history.close('/w?status=retry');
    fake.traverse();
    // The skip entry keeps its own address (Next's saved state matches it).
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?status=retry']);
    expect(fake.skips()).toEqual([0, 1, 0]);
    expectBackLeavesForwardStaysClosed(fake, '/w?status=retry');
  });

  it('finishes a close whose rewind loaded another document (a reload while open)', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    // Reloaded with the dialog open: the base belongs to the previous document now.
    const reloaded = new PanelHistory(() => fake.win);
    reloaded.attach();
    reloaded.close('/w');
    fake.traverseToDocument();
    expect(fake.url()).toBe('/w');
    new PanelHistory(() => fake.win).attach();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    expect(fake.storage.size).toBe(0);
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('reload → Back across documents → Forward never reopens the dialog', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    // Reloaded with the dialog open (a new document on the same entry).
    fake.leaveDocument();
    new PanelHistory(() => fake.win).attach();
    // Back: the base belongs to the previous document, loaded afresh (no BFCache).
    fake.goToDocument(-1);
    expect(fake.url()).toBe('/w');
    new PanelHistory(() => fake.win).attach();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a reload, a question change or a Forward across documents drops nothing', () => {
    const { fake, history } = controller();
    history.push('/w?question=1');
    history.push('/w?question=2');
    const entries = fake.urls();
    fake.leaveDocument(); // reload on question 2
    new PanelHistory(() => fake.win).attach();
    fake.goToDocument(-1); // back to question 1: the panel stays open
    new PanelHistory(() => fake.win).attach();
    expect(fake.url()).toBe('/w?question=1');
    fake.goToDocument(1);
    new PanelHistory(() => fake.win).attach();
    expect(fake.url()).toBe('/w?question=2');
    expect(fake.urls()).toEqual(entries);
  });

  it('a stale close handover is ignored; the pagehide record still finishes the Back', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.close('/w');
    fake.traverseToDocument();
    fake.tick(10_000);
    new PanelHistory(() => fake.win).attach();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    expect(fake.storage.size).toBe(0);
  });

  it('ignores records older than a page load', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.close('/w');
    fake.traverseToDocument();
    fake.tick(60_000);
    new PanelHistory(() => fake.win).attach();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=documents']);
    expect(fake.storage.size).toBe(0);
  });

  it('a deep-linked dialog closes in place when nothing lies ahead (Navigation API)', () => {
    const { fake, history } = controller('/w?panel=history', { navigation: true });
    history.close('/w');
    expect(fake.urls()).toEqual(['/workspaces', '/w']);
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a deep-linked dialog closes on a truncating copy without the Navigation API', () => {
    const { fake, history } = controller('/w?panel=history');
    history.close('/w');
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w']);
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a deep-linked practice panel moved back and closed drops its forward question', () => {
    const { fake, history } = controller('/w?question=1', { navigation: true });
    history.push('/w?question=2');
    fake.back();
    history.close('/w');
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('a deep-linked stack closed from below keeps the rest on an entry Back closes', () => {
    const { fake, history } = controller('/w?panel=documents&panel=history', { navigation: true });
    history.close('/w?panel=history');
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=history']);
    fake.back();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('stays on a skip entry with nothing further back (the first entry of the tab)', () => {
    const fake = fakeWindow('/w?panel=history', { firstEntry: true });
    const history = new PanelHistory(() => fake.win);
    history.attach();
    history.close('/w');
    expect(fake.urls()).toEqual(['/w', '/w']);
    fake.back();
    // The skip entry's Back has nowhere to go: the page stays on it, as a real entry.
    expect(fake.index()).toBe(0);
    fake.fireTimers();
    expect(fake.url()).toBe('/w');
    expect(fake.skips()).toEqual([0, 0]);
  });

  it('arriving on a skip entry from another document stays there as a real entry', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.close('/w');
    fake.traverse();
    fake.back();
    expect(fake.url()).toBe('/workspaces');
    // Forward from another page: unknown direction, the closed home is shown and kept.
    fake.forward();
    expect(fake.index()).toBe(1);
    expect(fake.skips()).toEqual([0, 0, 0]);
    // A reload (a new document) on a skip entry does the same.
    const skipState = markState({ __NA: true }, { pos: 0, depth: 0, under: 0 }, 1);
    const reloaded = fakeWindow('/w', { startState: skipState });
    new PanelHistory(() => reloaded.win).attach();
    expect(reloaded.skips()).toEqual([0, 0]);
  });

  it('pushes nothing for an open that changes nothing, and ignores closing a closed dialog', () => {
    const { fake, history } = controller('/w?panel=history');
    history.push('/w?panel=history');
    history.close('/w?panel=history');
    expect(fake.urls()).toEqual(['/workspaces', '/w?panel=history']);
  });

  it('restores the marks a router navigation dropped, and reads them back on Back/Forward', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    // router.replace rewrote the entry with Next's state only.
    fake.win.history.replaceState({ __NA: true }, '', '/w?panel=documents');
    history.stamp();
    expect(fake.win.history.state).toEqual({
      __NA: true,
      [PANEL_POS_KEY]: 1,
      [PANEL_DEPTH_KEY]: 1,
      [PANEL_UNDER_KEY]: 0,
    });
    history.push('/w?panel=documents&panel=history');
    fake.back();
    history.close('/w');
    fake.traverse();
    expect(fake.url()).toBe('/w');
    expectBackLeavesForwardStaysClosed(fake);
  });

  it('closes in place when the traversal never comes', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.close('/w');
    fake.fireTimers();
    expect(fake.url()).toBe('/w');
    expect(fake.index()).toBe(2);
  });
});
