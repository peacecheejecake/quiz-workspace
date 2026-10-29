// @vitest-environment jsdom
// DOCSUM-01 문서 요약: the panel's view model (states as text), the Markdown subset (never HTML or
// links from the model), labels, the relay client, the home/share URL helpers, history labels and
// the panel's states and actions against a fake client.
import './dom-setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentSummaryPanel } from '../src/components/documents/summary/document-summary-panel';
import { SummaryMarkdown } from '../src/components/documents/summary/summary-content';
import { activeSummaryDocuments } from '../src/components/documents/summary/use-summary-activity';
import {
  classifySummaryFailure,
  createSummaryClient,
  pageLinkLabel,
  pageRangeText,
  parseSummaryMarkdown,
  summaryErrorReason,
  summaryMetaLine,
  summaryPanelModel,
  summaryPollMs,
  type SummaryClient,
  type SummaryRun,
  type SummaryState,
} from '../src/lib/documents/summary';
import {
  eventLabel,
  jobCauseLabel,
  jobTypeLabel,
  type WorkspaceJob,
} from '../src/lib/history/model';
import { parseSharedViewParams, sharedSummaryHref } from '../src/lib/shared/view-state';
import { mergeContentSearch } from '../src/lib/search/state';
import { SharedSummaryPanel } from '../src/components/shared/shared-summary';
import {
  contentSearchParams,
  keepSummaryDocument,
  ownSummaryDocument,
  parsePanels,
  summaryDocumentId,
  summaryPanelPath,
  withoutSummaryDocument,
  withSummaryPanel,
} from '../src/lib/workspaces/home';

const WS = '99999999-2222-4333-8444-555555555555';
const DOC = '11111111-2222-4333-8444-555555555555';
const REV = '22222222-2222-4333-8444-555555555555';
const OLD_REV = '33333333-2222-4333-8444-555555555555';

function run(patch: Partial<SummaryRun> = {}): SummaryRun {
  return {
    id: '44444444-2222-4333-8444-555555555555',
    revision_id: REV,
    status: 'succeeded',
    trigger: 'manual',
    job_id: null,
    error_code: null,
    progress: null,
    usage: null,
    created_at: '2026-10-29T03:00:00Z',
    ...patch,
  };
}

const SUMMARY: NonNullable<SummaryState['summary']> = {
  run_id: '44444444-2222-4333-8444-555555555555',
  revision_id: REV,
  published_at: '2026-10-29T03:00:00Z',
  usage: null,
  document: {
    title: '물의 순환과 정수 처리',
    summary_md: '물은 **순환**한다.\n\n- 증발\n- 강수',
    key_points: [{ text: '물은 순환한다', pages: { from: 2, to: 3 } }],
  },
  chapters: [
    {
      section_key: 'ch1',
      title: '1장 물의 순환',
      page_from: 2,
      page_to: 3,
      summary_md: '증발과 강수.',
      key_points: [{ text: '증발', pages: { from: 2, to: 2 } }],
    },
    {
      section_key: 'ch2',
      title: '2장 정수 처리',
      page_from: 4,
      page_to: 4,
      summary_md: '',
      key_points: [],
    },
  ],
};

function state(patch: Partial<SummaryState> = {}): SummaryState {
  return {
    document_id: DOC,
    available: true,
    enabled: false,
    published_revision_id: REV,
    run: null,
    summary: null,
    stale: false,
    ...patch,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('summary panel model', () => {
  it('offers editors 요약 만들기 with the notice, viewers only the empty text', () => {
    const editor = summaryPanelModel(state(), { canEdit: true });
    expect(editor).toMatchObject({ empty: true, createInEmpty: true, auto: null, retry: false });
    const viewer = summaryPanelModel(state(), { canEdit: false });
    expect(viewer).toMatchObject({ empty: true, createInEmpty: false });
  });

  it('shows queued and running progress as text', () => {
    expect(
      summaryPanelModel(state({ run: run({ status: 'queued' }) }), { canEdit: true }).progress,
    ).toEqual({ text: '요약 대기 중', value: undefined });
    const running = summaryPanelModel(
      state({
        run: run({ status: 'running', progress: { chapters_done: 3, chapters_total: 7 } }),
      }),
      { canEdit: true },
    );
    expect(running.progress).toEqual({ text: '요약을 만드는 중 · 장별 요약 3/7', value: 43 });
    expect(running.empty).toBe(false);
    expect(running.createInEmpty).toBe(false);
  });

  it('keeps an older summary with a stale notice while running or after a failure', () => {
    const base = { summary: { ...SUMMARY, revision_id: OLD_REV }, stale: true, enabled: true };
    expect(
      summaryPanelModel(state({ ...base, run: run({ status: 'running' }) }), { canEdit: true })
        .stale,
    ).toBe('이전 발행본 기준 요약입니다. 새 발행본의 요약을 만드는 중입니다.');
    const failed = summaryPanelModel(
      state({ ...base, run: run({ status: 'failed', error_code: 'llm_invalid_output' }) }),
      { canEdit: true },
    );
    expect(failed.stale).toBe('이전 발행본 기준 요약입니다. 새 요약을 만들지 못했습니다.');
    expect(failed.failure).toBe('요약을 만들지 못했습니다. 다시 시도하세요.');
    expect(failed.retry).toBe(true);
    expect(
      summaryPanelModel(state({ ...base, run: run({ status: 'failed' }) }), { canEdit: false })
        .retry,
    ).toBe(false);
    // Auto refresh off: stale only, no running suffix.
    expect(summaryPanelModel(state({ ...base, enabled: false }), { canEdit: true }).stale).toBe(
      '이전 발행본 기준 요약입니다.',
    );
  });

  it('shows the auto-refresh line with the editor action only', () => {
    const on = state({ summary: SUMMARY, enabled: true, run: run() });
    expect(summaryPanelModel(on, { canEdit: true }).auto).toEqual({ on: true, action: 'disable' });
    expect(summaryPanelModel(on, { canEdit: false }).auto).toEqual({ on: true, action: null });
    const off = state({ summary: SUMMARY, enabled: false });
    expect(summaryPanelModel(off, { canEdit: true }).auto).toEqual({ on: false, action: 'enable' });
  });

  it('marks an environment without summaries and documents that cannot be summarized', () => {
    expect(summaryPanelModel(state({ available: false }), { canEdit: true }).unavailable).toBe(
      true,
    );
    const paper = summaryPanelModel(state(), { canEdit: true, questionPaper: true });
    expect(paper).toMatchObject({ notice: '문제지는 요약하지 않습니다.', createInEmpty: false });
    const processing = summaryPanelModel(state({ published_revision_id: null }), {
      canEdit: true,
    });
    expect(processing.createInEmpty).toBe(false);
    expect(processing.notice).toMatch(/처리가 끝나면/);
  });

  it('maps error codes to the spec reasons and polls faster while a run is active', () => {
    expect(summaryErrorReason('llm_timeout')).toMatch(/AI 서비스에 연결하지 못했습니다/);
    expect(summaryErrorReason('summary_too_large')).toBe('문서가 너무 커서 요약할 수 없습니다.');
    expect(summaryErrorReason('anything')).toBe('요약을 만들지 못했습니다. 다시 시도하세요.');
    expect(summaryPollMs(state({ run: run({ status: 'running' }) }))).toBeLessThan(
      summaryPollMs(state()),
    );
  });
});

describe('summary text', () => {
  it('parses paragraphs, lists and emphasis only', () => {
    expect(parseSummaryMarkdown('# 제목\n첫 줄\n둘째 줄\n\n- 가\n- **나**\n1. 하나')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: '제목 첫 줄 둘째 줄' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: '가' }],
          [{ kind: 'strong', children: [{ kind: 'text', text: '나' }] }],
        ],
      },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: '하나' }]] },
    ]);
  });

  it('renders HTML, links and images as text', () => {
    const { container } = render(
      <SummaryMarkdown
        markdown={'<img src=x onerror=alert(1)> [링크](https://evil.test) *강조*'}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('em')?.textContent).toBe('강조');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('[링크](https://evil.test)');
  });

  it('labels pages and the meta line', () => {
    expect(pageRangeText({ from: 12, to: 14 })).toBe('p.12–14');
    expect(pageRangeText({ from: 4, to: 4 })).toBe('p.4');
    expect(pageLinkLabel({ from: 12, to: 14 })).toBe('12–14쪽 열기');
    expect(pageLinkLabel({ from: 4, to: 4 })).toBe('4쪽 열기');
    expect(summaryMetaLine(SUMMARY)).toMatch(/^2026\. 10\. 29\. .+ 발행본 기준 · 장 2개$/);
    expect(summaryMetaLine({ ...SUMMARY, published_at: null })).toBe('발행본 기준 · 장 2개');
  });
});

describe('summary client', () => {
  it('classifies problems', () => {
    const t = (slug: string) => ({ type: `urn:quiz-workspace:problem:${slug}` });
    expect(classifySummaryFailure(404, {})).toBe('notFound');
    expect(classifySummaryFailure(403, t('workspace-archived'))).toBe('archived');
    expect(classifySummaryFailure(403, t('insufficient-role'))).toBe('forbidden');
    expect(classifySummaryFailure(409, t('summary-disabled'))).toBe('disabled');
    expect(classifySummaryFailure(409, t('summary-not-applicable'))).toBe('notApplicable');
    expect(classifySummaryFailure(409, t('document-not-ready'))).toBe('notReady');
    expect(classifySummaryFailure(409, t('summary-not-failed'))).toBe('notFailed');
    expect(classifySummaryFailure(500, {})).toBe('failed');
  });

  it('sends the Idempotency-Key with create and retry, DELETE for auto off', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(state({ run: run({ status: 'queued' }) }), { status: 202 }),
    );
    const client = createSummaryClient(fetchImpl);
    await client.create(DOC, 'key-1');
    await client.retry(DOC, 'key-2');
    await client.disableAuto(DOC);
    const calls = fetchImpl.mock.calls.map(([url, init]) => [
      url,
      init?.method,
      (init?.headers as Record<string, string>)['idempotency-key'],
    ]);
    expect(calls).toEqual([
      [`/api/documents/${DOC}/summary`, 'POST', 'key-1'],
      [`/api/documents/${DOC}/summary/retry`, 'POST', 'key-2'],
      [`/api/documents/${DOC}/summary/auto`, 'DELETE', undefined],
    ]);
  });
});

const OTHER = '55555555-2222-4333-8444-555555555555';

describe('the summary panel owns the URL document key (Codex P2)', () => {
  const search = (q: Partial<Parameters<typeof mergeContentSearch>[1]>) => ({
    query: 'x',
    mode: 'hybrid' as const,
    documentId: null,
    chapterId: null,
    includeQuestionPapers: false,
    ...q,
  });

  it("content-search writes keep the open panel's document and section", () => {
    const open = `?q=x&panel=document-summary&document=${DOC}`;
    // A search with another document filter, or none, never replaces or removes it.
    expect(
      new URLSearchParams(
        mergeContentSearch(open, search({ documentId: OTHER, chapterId: 's' })),
      ).get('document'),
    ).toBe(DOC);
    const cleared = new URLSearchParams(mergeContentSearch(open, search({ query: 'y' })));
    expect(cleared.get('document')).toBe(DOC);
    expect(cleared.get('section')).toBeNull();
    expect(cleared.get('q')).toBe('y');
    expect(keepSummaryDocument(open, '?q=z')).toBe(`?q=z&document=${DOC}`);
  });

  it('writes behave as before once the panel is closed', () => {
    const closed = `?q=x&document=${DOC}&section=s`;
    const next = new URLSearchParams(mergeContentSearch(closed, search({ documentId: OTHER })));
    expect(next.get('document')).toBe(OTHER);
    expect(next.get('section')).toBeNull();
    expect(keepSummaryDocument(closed, '?q=z')).toBe('?q=z');
  });

  it('reads the executed filter, not the panel document, while the panel is open', () => {
    const open = new URLSearchParams(`q=x&panel=document-summary&document=${DOC}`);
    const withFilter = contentSearchParams(open, { documentId: OTHER, chapterId: 's' });
    expect(withFilter.get('document')).toBe(OTHER);
    expect(withFilter.get('section')).toBe('s');
    expect(contentSearchParams(open, null).get('document')).toBeNull();
    const closed = new URLSearchParams(`q=x&document=${OTHER}`);
    expect(contentSearchParams(closed, null)).toBe(closed);
  });

  it('closing the panel hands the executed filter back to the content search', () => {
    const open = `?q=x&panel=documents&panel=document-summary&document=${DOC}`;
    const closed = new URLSearchParams(
      withSummaryPanel(open, null, { documentId: OTHER, chapterId: 's' }),
    );
    expect(parsePanels(closed)).toEqual(['documents']);
    expect(closed.get('document')).toBe(OTHER);
    expect(closed.get('section')).toBe('s');
    expect(new URLSearchParams(withSummaryPanel(open, null)).get('document')).toBeNull();
  });
});

describe("only the current workspace's (or share's) documents (Codex P2)", () => {
  it('resolves the panel document against the list', () => {
    const docs = [{ id: DOC, title: '물' }];
    expect(ownSummaryDocument(DOC, docs)).toEqual(docs[0]);
    expect(ownSummaryDocument(OTHER, docs)).toBeNull();
    expect(ownSummaryDocument(null, docs)).toBeNull();
  });

  it('the guest panel shows "볼 수 없습니다" without requesting another document', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <SharedSummaryPanel
        shareId={WS}
        open
        documentId={null}
        title={null}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('이 문서의 요약을 볼 수 없습니다.')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('summary URLs and labels', () => {
  it('opens and closes the home panel with its document', () => {
    const opened = withSummaryPanel('?panel=documents&q=x', DOC);
    const params = new URLSearchParams(opened);
    expect(parsePanels(params)).toEqual(['documents', 'document-summary']);
    expect(summaryDocumentId(params)).toBe(DOC);
    expect(withSummaryPanel(opened, null)).toBe('?q=x&panel=documents');
    expect(summaryDocumentId(new URLSearchParams(`document=${DOC}`))).toBeNull();
    expect(summaryPanelPath(WS, DOC)).toBe(
      `/workspaces/${WS}?panel=document-summary&document=${DOC}`,
    );
  });

  it('keeps the panel document out of the content search', () => {
    expect(
      withoutSummaryDocument({ panel: 'document-summary', document: DOC, section: 's', q: 'x' }),
    ).toEqual({ panel: 'document-summary', q: 'x' });
    expect(withoutSummaryDocument({ document: DOC, q: 'x' })).toEqual({ document: DOC, q: 'x' });
  });

  it('opens the guest panel over the shared home', () => {
    expect(sharedSummaryHref(WS, DOC)).toBe(`/share/${WS}?panel=document-summary&document=${DOC}`);
    expect(parseSharedViewParams({ panel: 'document-summary', document: DOC })).toEqual({
      documentId: null,
      page: null,
      blockId: null,
      forkPanel: false,
      summaryDocumentId: DOC,
    });
  });

  it('names summary history entries without body text', () => {
    expect(eventLabel('document.summary_enabled')).toBe('요약 만들기');
    expect(eventLabel('document.summary_auto_disabled')).toBe('자동 갱신 끄기');
    expect(jobTypeLabel('document.summarize')).toBe('문서 요약');
    expect(jobCauseLabel({ status: 'failed', error_code: 'llm_invalid_output' })).toBe(
      'AI 응답 오류',
    );
  });

  it('finds documents with an active summary job', () => {
    const job = (patch: Partial<WorkspaceJob>) => ({ ...patch }) as WorkspaceJob;
    expect(
      activeSummaryDocuments([
        job({ job_type: 'document.summarize', status: 'running', target_id: DOC }),
        job({ job_type: 'document.summarize', status: 'succeeded', target_id: WS }),
        job({ job_type: 'document.parse', status: 'running', target_id: REV }),
      ]),
    ).toEqual(new Set([DOC]));
  });
});

// --- the panel ----------------------------------------------------------------------------------

function fakeClient(initial: SummaryState) {
  let current = initial;
  const client = {
    get: vi.fn(async () => current),
    create: vi.fn(async () => {
      current = state({ ...current, enabled: true, run: run({ status: 'queued' }) });
      return current;
    }),
    retry: vi.fn(async () => current),
    disableAuto: vi.fn(async () => {
      current = { ...current, enabled: false };
    }),
  } satisfies SummaryClient;
  return { client, set: (next: SummaryState) => (current = next) };
}

function renderPanel(initial: SummaryState, props: { canEdit?: boolean } = {}) {
  const fake = fakeClient(initial);
  const onActivity = vi.fn();
  render(
    <DocumentSummaryPanel
      open
      onOpenChange={() => undefined}
      workspaceId={WS}
      documentId={DOC}
      documentTitle="물의 순환"
      canEdit={props.canEdit ?? true}
      client={fake.client}
      onActivity={onActivity}
    />,
  );
  return { ...fake, onActivity, panel: screen.getByRole('dialog', { name: '문서 요약' }) };
}

describe('DocumentSummaryPanel', () => {
  it('loads nothing for a document outside the workspace (null) and says it is not found', async () => {
    const fake = fakeClient(state());
    render(
      <DocumentSummaryPanel
        open
        onOpenChange={() => undefined}
        workspaceId={WS}
        documentId={null}
        canEdit
        client={fake.client}
      />,
    );
    expect(await screen.findByText(/문서를 찾을 수 없습니다/)).toBeTruthy();
    expect(fake.client.get).not.toHaveBeenCalled();
  });

  it('opens at once, then offers an editor 요약 만들기 that starts one run for two presses', async () => {
    const user = userEvent.setup();
    const { client, panel, onActivity } = renderPanel(state());
    expect(within(panel).getByText('요약을 불러오는 중입니다.')).toBeTruthy();
    expect(await within(panel).findByText('아직 요약이 없습니다.')).toBeTruthy();
    expect(within(panel).getByText(/본문이 AI 서비스로 전송됩니다/)).toBeTruthy();
    const create = within(panel).getByRole('button', { name: '요약 만들기' });
    await user.dblClick(create);
    expect(await within(panel).findByText('요약 대기 중')).toBeTruthy();
    expect(within(panel).getByRole('progressbar', { name: '요약 진행률' })).toBeTruthy();
    expect(client.create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onActivity).toHaveBeenLastCalledWith(DOC, true));
  });

  it('gives viewers no buttons', async () => {
    const { panel } = renderPanel(state({ summary: SUMMARY, enabled: true }), { canEdit: false });
    expect(await within(panel).findByText(/자동 갱신 켜짐/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /요약 만들기|자동 갱신 끄기/ })).toBeNull();
    expect(within(panel).getByText('AI 생성')).toBeTruthy();
  });

  it('keeps 요약 만들기 focusable but aria-disabled with its reason when unavailable', async () => {
    const { panel, client } = renderPanel(state({ available: false }));
    const create = await within(panel).findByRole('button', { name: '요약 만들기' });
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create).toHaveAccessibleDescription('이 환경에서는 AI 요약을 사용할 수 없습니다.');
    await userEvent.setup().click(create);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('shows the summary with collapsed chapters and page links into DOC-02', async () => {
    const user = userEvent.setup();
    const { panel } = renderPanel(state({ summary: SUMMARY, enabled: true, run: run() }));
    expect(await within(panel).findByRole('heading', { level: 3, name: '전체 요약' })).toBeTruthy();
    expect(within(panel).getByText(/발행본 기준 · 장 2개$/)).toBeTruthy();
    const link = within(within(panel).getByRole('list', { name: '핵심' })).getByRole('link', {
      name: '2–3쪽 열기',
    });
    expect(link.getAttribute('href')).toBe(`/workspaces/${WS}/documents/${DOC}?page=2`);
    const chapter = within(panel).getByRole('button', { name: /^1장 물의 순환 p\.2–3/ });
    expect(chapter.getAttribute('aria-expanded')).toBe('false');
    await user.click(chapter);
    expect(chapter.getAttribute('aria-expanded')).toBe('true');
    await user.click(within(panel).getByRole('button', { name: /^2장 정수 처리/ }));
    expect(within(panel).getByText('요약할 본문이 없습니다.')).toBeTruthy();
  });

  it('shows a failure alert with 다시 시도 for editors', async () => {
    const { panel, client } = renderPanel(
      state({ enabled: true, run: run({ status: 'failed', error_code: 'llm_timeout' }) }),
    );
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toMatch(/요약을 만들지 못했습니다.*AI 서비스에 연결하지 못했습니다/);
    await userEvent.setup().click(within(panel).getByRole('button', { name: '다시 시도' }));
    expect(client.retry).toHaveBeenCalledWith(DOC, expect.any(String));
  });

  it('turns auto refresh off only after the confirmation; 취소 changes nothing', async () => {
    const user = userEvent.setup();
    const { panel, client } = renderPanel(state({ summary: SUMMARY, enabled: true, run: run() }));
    const off = await within(panel).findByRole('button', { name: '자동 갱신 끄기' });
    await user.click(off);
    let dialog = await screen.findByRole('alertdialog', { name: '자동 갱신을 끌까요?' });
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.disableAuto).not.toHaveBeenCalled();
    await waitFor(() => expect(off).toHaveFocus());

    await user.click(off);
    dialog = await screen.findByRole('alertdialog', { name: '자동 갱신을 끌까요?' });
    await user.click(within(dialog).getByRole('button', { name: '끄기' }));
    expect(await within(panel).findByText('자동 갱신 꺼짐')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '요약 만들기' })).toBeTruthy();
    expect(client.disableAuto).toHaveBeenCalledTimes(1);
  });

  it('says when the document cannot be found', async () => {
    const fake = fakeClient(state());
    fake.client.get.mockRejectedValue(
      new (await import('../src/lib/documents/summary')).SummaryApiError('notFound'),
    );
    await act(async () => {
      render(
        <DocumentSummaryPanel
          open
          onOpenChange={() => undefined}
          workspaceId={WS}
          documentId={DOC}
          canEdit
          client={fake.client}
        />,
      );
    });
    expect(await screen.findByText(/문서를 찾을 수 없습니다/)).toBeTruthy();
  });
});
