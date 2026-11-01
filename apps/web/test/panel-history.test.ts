// UX7-BACK (QOV-01-AC14): the workspace home's dialog history. Opening pushes an entry; closing
// rewinds to the entry before the first open so Back never reopens a closed dialog.
import { describe, expect, it } from 'vitest';
import { withoutPanels } from '../src/lib/workspaces/home';
import {
  entryDepth,
  PANEL_DEPTH_KEY,
  PanelHistory,
  planClose,
  type PanelHistoryWindow,
} from '../src/lib/workspaces/panel-history';

const ORIGIN = 'http://home.test';

/** A session history with Next's patched methods reduced to plain entry writes. */
function fakeWindow(start: string, startState: unknown = { __NA: true }) {
  const entries: { url: string; state: unknown }[] = [
    { url: '/workspaces', state: null },
    { url: start, state: startState },
  ];
  let index = 1;
  const entry = (i = index) => {
    const found = entries[i];
    if (!found) throw new Error(`no entry ${i}`);
    return found;
  };
  const listeners = new Set<(event: PopStateEvent) => void>();
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
        entries.splice(index + 1);
        entries.push({ url: String(url ?? entry().url), state });
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
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    setTimeout: (handler) => {
      timers.set(nextTimer, handler);
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  return {
    win,
    url: () => entry().url,
    urls: () => entries.map((e) => e.url),
    index: () => index,
    /** Delivers the traversal a `go` started (the browser does it asynchronously). */
    traverse() {
      if (pendingGo === null) return;
      index = Math.max(0, Math.min(entries.length - 1, index + pendingGo));
      pendingGo = null;
      const event = { state: entry().state } as PopStateEvent;
      for (const listener of listeners) listener(event);
    },
    back() {
      win.history.go(-1);
      this.traverse();
    },
    forward() {
      win.history.go(1);
      this.traverse();
    },
    fireTimers() {
      for (const [id, handler] of [...timers]) {
        timers.delete(id);
        handler();
      }
    },
  };
}

const closeAll = (search: string) => withoutPanels(search);

function controller(start = '/w') {
  const fake = fakeWindow(start);
  const history = new PanelHistory(() => fake.win);
  history.attach();
  return { fake, history };
}

describe('entryDepth and planClose', () => {
  it('reads only a positive integer depth', () => {
    expect(entryDepth(null)).toBe(0);
    expect(entryDepth({ [PANEL_DEPTH_KEY]: 2 })).toBe(2);
    expect(entryDepth({ [PANEL_DEPTH_KEY]: -1 })).toBe(0);
    expect(entryDepth({ [PANEL_DEPTH_KEY]: '3' })).toBe(0);
  });

  it('rewrites in place without entries of ours, and rewinds otherwise', () => {
    expect(planClose('/w?panel=history', '/w?panel=history', 1, '/w')).toEqual({ kind: 'none' });
    expect(planClose('/w?panel=history', '/w', 0, '/w')).toEqual({ kind: 'replace', url: '/w' });
    expect(planClose('/w?panel=history', '/w', 2, '/w')).toEqual({
      kind: 'rewind',
      steps: 2,
      base: '/w',
      reopen: null,
    });
    expect(planClose('/w?panel=a&panel=b', '/w?panel=b', 2, '/w')).toEqual({
      kind: 'rewind',
      steps: 2,
      base: '/w',
      reopen: '/w?panel=b',
    });
  });
});

describe('withoutPanels', () => {
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
  it('open → close → Back leaves the home; Forward reopens the closed dialog', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=documents']);
    history.close('/w', closeAll);
    expect(fake.url()).toBe('/w?panel=documents'); // waits for the traversal
    fake.traverse();
    expect(fake.url()).toBe('/w');
    expect(fake.index()).toBe(1);
    fake.back();
    expect(fake.url()).toBe('/workspaces');
    fake.forward();
    fake.forward();
    expect(fake.url()).toBe('/w?panel=documents');
  });

  it('Back while open closes it; the next close still rewinds', () => {
    const { fake, history } = controller();
    history.push('/w?panel=history');
    fake.back();
    expect(fake.url()).toBe('/w');
    fake.forward();
    history.close('/w', closeAll);
    fake.traverse();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=history']);
    expect(fake.index()).toBe(1);
  });

  it('closing after previous/next rewinds every entry the panel pushed', () => {
    const { fake, history } = controller();
    history.push('/w?question=1');
    history.push('/w?question=2');
    history.push('/w?question=3');
    history.close('/w', closeAll);
    fake.traverse();
    expect(fake.index()).toBe(1);
    expect(fake.url()).toBe('/w');
    fake.back();
    expect(fake.url()).toBe('/workspaces');
  });

  it('a stacked close keeps the dialog still open on one new entry', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.push('/w?panel=documents&panel=history');
    history.close('/w?panel=history', closeAll);
    fake.traverse();
    expect(fake.urls()).toEqual(['/workspaces', '/w', '/w?panel=history']);
    // Back closes the remaining dialog; closing it instead also rewinds.
    fake.back();
    expect(fake.url()).toBe('/w');
    fake.forward();
    history.close('/w', closeAll);
    fake.traverse();
    expect(fake.url()).toBe('/w');
    expect(fake.index()).toBe(1);
  });

  it('writes what changed while open (filters) onto the base entry', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.replace('/w?panel=documents&status=retry');
    history.close('/w?status=retry', closeAll);
    fake.traverse();
    expect(fake.urls()).toEqual([
      '/workspaces',
      '/w?status=retry',
      '/w?panel=documents&status=retry',
    ]);
    expect(fake.index()).toBe(1);
  });

  it('a deep-linked dialog closes in place and never leaves the home', () => {
    const { fake, history } = controller('/w?panel=history');
    history.close('/w', closeAll);
    expect(fake.urls()).toEqual(['/workspaces', '/w']);
    expect(fake.index()).toBe(1);
  });

  it('pushes nothing for an open that changes nothing, and ignores closing a closed dialog', () => {
    const { fake, history } = controller('/w?panel=history');
    history.push('/w?panel=history');
    history.close('/w?panel=history', closeAll);
    expect(fake.urls()).toEqual(['/workspaces', '/w?panel=history']);
  });

  it('restores the depth a router navigation dropped, and reads it back on Back/Forward', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    // router.replace rewrote the entry with Next's state only.
    fake.win.history.replaceState({ __NA: true }, '', '/w?panel=documents');
    history.stamp();
    expect(fake.win.history.state).toEqual({ __NA: true, [PANEL_DEPTH_KEY]: 1 });
    history.push('/w?panel=documents&panel=history');
    fake.back();
    history.close('/w', closeAll);
    fake.traverse();
    expect(fake.index()).toBe(1);
    expect(fake.url()).toBe('/w');
  });

  it('closes in place when the traversal never comes', () => {
    const { fake, history } = controller();
    history.push('/w?panel=documents');
    history.close('/w', closeAll);
    fake.fireTimers();
    expect(fake.url()).toBe('/w');
    expect(fake.index()).toBe(2);
  });
});
