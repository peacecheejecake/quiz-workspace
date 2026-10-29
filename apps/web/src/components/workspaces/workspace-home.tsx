'use client';

// Workspace home `/workspaces/:id` (QOV-01, docs/screens/questions-overview.md "Workspace 홈
// 레이아웃", UX3c): the single page of a workspace, without a sidebar.
//
//   Workspace header  unified search (SEARCH-01-AC07: one box, icon submit, the 문제 · 본문 scope
//                     checkboxes under it, each with a "설정" popover: the heatmap's chapter/type
//                     filters for 문제, the content-search options for 본문; question papers are
//                     searched whenever 문제 is checked, UX4; no searchable scope disables the
//                     submit with a status message, UX6), then two
//                     button groups: `문서 n` · `문제` (menu: 전체 문제 — the bank, UX6-PROGRESS —
//                     / PDF 관리 / 직접 추가 / 변형 출제, UX4), and, aligned right, `이력` · `공유하기` (icon buttons; share
//                     for the owner only)
//   content results   the 본문 search results when the scope includes 본문
//   문제 영역         the heatmap (QuestionsOverview)
//   floating dialogs  문서 관리 · 문제 PDF 관리 · 문제 생성 · 이력 · 링크 공유 · 정리 노트: non-modal
//                     FloatingSidePanels portalled into this page (inside <main>), opened at once
//                     and listed in the URL (`?panel=`, repeatable); the most recently opened is
//                     on top (UX3b stacking).
//
// State lives in the URL: heatmap filters (overview-filters.ts), `q`/`scope` and the content
// options (search/state.ts), `panel` (+ `chapter` of the 정리 노트 panel, CHNOTE-01: a Heatmap
// chapter header's `정리 노트` button opens it), and `question` (the practice panel). Dialog and panel
// changes use history.pushState (Next syncs useSearchParams; no server round trip); filter and
// search changes that alter the heatmap use router.replace (the server re-reads the overview).
import {
  Button,
  FloatingSidePanel,
  HistoryIcon,
  IconButton,
  questionTypeLabels,
  Select,
  ShareIcon,
  type QuestionType,
} from '@quiz/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { DocumentsLibrary } from '@/components/documents/documents-library';
import { bodyDocumentCount } from '@/components/documents/labels';
import { useDocumentLibrary } from '@/components/documents/use-document-library';
import { HistoryPanel } from '@/components/history/history-panel';
import { GenerationDialog } from '@/components/questions/generate/generation-dialog';
import { ChapterNotePanel } from '@/components/questions/notes/chapter-note-panel';
import {
  DocumentLibraryFeedback,
  QuestionPdfsDialog,
} from '@/components/questions/import/question-pdfs';
import { QuestionsOverview } from '@/components/questions/overview/questions-overview';
import {
  ContentSearchOptions,
  ContentSearchResults,
  dropsSelectedPaper,
  useContentSearch,
} from '@/components/search/content-search';
import { UnifiedSearchForm } from '@/components/search/unified-search-form';
import { listChapterNotes } from '@/lib/notes/client';
import { generatingChapters, type ChapterNoteList } from '@/lib/notes/model';
import { WorkspaceSharingPanel } from '@/components/sharing/workspace-sharing-panel';
import { QuestionMenu } from './question-menu';
import type { DocumentSummary } from '@/lib/documents/client-api';
import type { ChapterChoice, QuestionOverview } from '@/lib/questions/overview-data';
import {
  EMPTY_OVERVIEW_FILTERS,
  mergeOverviewFilters,
  OVERVIEW_SEARCH_MAX,
  overviewSearch,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import { NO_CHAPTER_KEY, type PlacedQuestion } from '@/lib/questions/overview-placement';
import type { QuestionFailureKind } from '@/lib/questions/problems';
import { bankCreatePath } from '@/lib/questions/filters';
import type { SearchQuery } from '@/lib/search/client';
import { addressBarContentKey, hasSearchableBody, searchReadiness } from '@/lib/search/scope';
import { MAX_QUERY_CHARS, parseSearchParams } from '@/lib/search/state';
import {
  keepNoteChapter,
  noteChapterOf,
  parsePanels,
  parseScope,
  patchSearch,
  scopeIncludesContent,
  scopeIncludesQuestions,
  scopeOf,
  withChapterNote,
  withPanel,
  type HomePanel,
  type SearchScope,
} from '@/lib/workspaces/home';
import styles from './workspace-home.module.css';

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

export interface WorkspaceHomeProps {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly role: 'owner' | 'editor' | 'viewer';
    readonly archived: boolean;
  };
  /** Verified id of the signed-in user (history entries of this actor read "나"). */
  readonly viewerId: string | null;
  /** Heatmap filters the server rendered `overview` with (`q` only when the scope has 문제). */
  readonly filters: OverviewFilters;
  readonly overview: QuestionOverview;
  readonly chapterChoices: readonly ChapterChoice[];
  readonly failure: QuestionFailureKind | null;
  readonly requested: PlacedQuestion | null;
  /** Whether the workspace has any question to search (null = unknown, never blocks). */
  readonly hasQuestions?: boolean | null;
  readonly documents: readonly DocumentSummary[];
  readonly documentsLoadFailed: boolean;
  /** The content search in the URL on arrival. */
  readonly initialSearch: SearchQuery;
  /** Screen ids of the parts of this page (`data-screen-id`, docs/screens/index.md). */
  readonly screenIds: {
    readonly documents: string;
    readonly search: string;
    readonly practice: string;
    readonly history: string;
    readonly share: string;
    readonly chapterNote: string;
  };
}

export function WorkspaceHome({
  workspace,
  viewerId,
  filters,
  overview,
  chapterChoices,
  failure,
  requested,
  hasQuestions = null,
  documents,
  documentsLoadFailed,
  initialSearch,
  screenIds,
}: WorkspaceHomeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();
  const isOwner = workspace.role === 'owner';
  const canEdit = !workspace.archived && workspace.role !== 'viewer';
  const readOnly = workspace.archived ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  // --- dialogs ------------------------------------------------------------------------------
  const allowed = (panel: HomePanel) =>
    (panel !== 'share' || isOwner) && (panel !== 'generate' || canEdit);
  const panels = parsePanels(searchParams).filter(allowed);
  const isOpen = (panel: HomePanel) => panels.includes(panel);
  // Pressing the button of a dialog that is already open (maybe under another one) raises it.
  const [raised, setRaised] = useState<Partial<Record<HomePanel, number>>>({});
  const setPanel = (panel: HomePanel, open: boolean) => {
    if (open && isOpen(panel)) {
      setRaised((r) => ({ ...r, [panel]: (r[panel] ?? 0) + 1 }));
    }
    window.history.pushState(
      null,
      '',
      `${pathname}${withPanel(window.location.search, panel, open)}`,
    );
  };
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  // --- 정리 노트 (CHNOTE-01) ---------------------------------------------------------------------
  // `chapter` names the note's chapter while its panel is open (home.ts noteChapterOf).
  const noteChapter = noteChapterOf(searchParams);
  function openNote(chapterId: string) {
    if (isOpen('chapter-note') && noteChapter === chapterId) {
      setRaised((r) => ({ ...r, 'chapter-note': (r['chapter-note'] ?? 0) + 1 }));
    }
    const target = `${pathname}${withChapterNote(window.location.search, chapterId)}`;
    if (view.chapter !== null) {
      // The note takes over `chapter`: drop the heatmap's chapter filter with it.
      setView((v) => ({ ...v, chapter: null }));
      startNavigation(() => router.push(target, { scroll: false }));
    } else {
      window.history.pushState(null, '', target);
    }
  }
  function closeNote() {
    window.history.pushState(
      null,
      '',
      `${pathname}${withChapterNote(window.location.search, null)}`,
    );
  }
  // Practice opened from a footnote returns focus to the note's disclosure when it closes.
  const practiceReturnFocusRef = useRef<HTMLElement | null>(null);
  function openNoteQuestion(questionId: string, returnFocus: HTMLElement | null) {
    practiceReturnFocusRef.current = returnFocus;
    window.history.pushState(
      null,
      '',
      `${pathname}${patchSearch(window.location.search, { question: questionId })}`,
    );
  }
  // The Heatmap headers' "만드는 중": the workspace's note list, re-read while one is generating,
  // and what an open note panel last saw.
  const [noteList, setNoteList] = useState<ChapterNoteList | null>(null);
  const [noteListRead, setNoteListRead] = useState(0);
  const [panelGenerating, setPanelGenerating] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    listChapterNotes(workspace.id, controller.signal).then(
      (list) => {
        setNoteList(list);
        setPanelGenerating(new Map());
      },
      () => undefined, // The header text is a hint; the panel shows the real state.
    );
    return () => controller.abort();
  }, [workspace.id, noteListRead]);
  const generating = new Set(generatingChapters(noteList));
  for (const [id, busy] of panelGenerating) {
    if (busy) generating.add(id);
    else generating.delete(id);
  }
  const anyGenerating = generating.size > 0;
  useEffect(() => {
    if (!anyGenerating) return;
    const timer = window.setTimeout(() => setNoteListRead((n) => n + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [anyGenerating, noteList]);
  const onNoteGenerating = useCallback((chapterId: string, busy: boolean) => {
    setPanelGenerating((prev) =>
      prev.get(chapterId) === busy ? prev : new Map(prev).set(chapterId, busy),
    );
  }, []);

  // --- documents (문서 관리 + 문제 PDF 관리) ----------------------------------------------------
  const library = useDocumentLibrary({
    workspaceId: workspace.id,
    initialDocuments: documents,
    canEdit,
    loadFailed: documentsLoadFailed,
  });
  // UX6-UPLOAD: `문서 n` counts the PDFs with body text (교재, 교재+문제).
  const bookCount = bodyDocumentCount(library.documents);
  const searchDocuments = library.documents
    .filter((d) => d.active_revision_id !== null)
    .map((d) => ({
      id: d.id,
      title: d.title,
      isQuestionPaper: d.document_type === 'question_paper',
    }));

  // --- heatmap filters ----------------------------------------------------------------------
  // Filters as last chosen: quick successive changes build on each other before the URL (and the
  // server render) catch up; a new server render with other filters resets them.
  const filtersKey = overviewSearch(filters);
  const [renderedKey, setRenderedKey] = useState(filtersKey);
  const [view, setView] = useState(filters);
  if (renderedKey !== filtersKey) {
    setRenderedKey(filtersKey);
    setView(filters);
  }

  function changeFilters(patch: Partial<OverviewFilters>) {
    const next = { ...view, ...patch };
    setView(next);
    startNavigation(() => {
      const search = window.location.search;
      const merged = keepNoteChapter(
        search,
        mergeOverviewFilters(search, next),
        patch.chapter ?? null,
      );
      router.replace(`${pathname}${merged}`, { scroll: false });
    });
  }

  // --- unified search -----------------------------------------------------------------------
  const scope = parseScope(searchParams);
  const [draft, setDraft] = useState(searchParams.get('q') ?? '');
  /** What a search under `s` runs on, and whether it is blocked (UX6). */
  const readinessFor = (s: SearchScope) =>
    searchReadiness(
      { questions: scopeIncludesQuestions(s), body: scopeIncludesContent(s) },
      {
        questions: hasQuestions ?? true,
        body: hasSearchableBody(library.documents, scopeIncludesQuestions(s), library.listFailed),
      },
    );
  const readiness = readinessFor(scope);
  const content = useContentSearch({
    workspaceId: workspace.id,
    // UX4: question papers are searched exactly when 문제 is a target.
    initial: { ...initialSearch, includeQuestionPapers: scopeIncludesQuestions(scope) },
    runInitial: readiness.effective.body,
  });

  // The address bar can change under us (browser Back/Forward restores an earlier search): the
  // search box, the content options and the executed content search follow it. Our own updates
  // write the same state they already show, so following them is a no-op.
  const urlQ = searchParams.get('q') ?? '';
  const [seenQ, setSeenQ] = useState(urlQ);
  if (seenQ !== urlQ) {
    setSeenQ(urlQ);
    setDraft(urlQ);
  }
  // Question papers follow the 문제 checkbox, not the URL's `papers` flag (unwritten while a
  // search had no body to run on, UX6).
  const contentKey = readiness.effective.body
    ? addressBarContentKey(Object.fromEntries(searchParams), scopeIncludesQuestions(scope))
    : '';
  const syncedContentKey = useRef(contentKey);
  const syncContent = content.sync;
  useEffect(() => {
    if (syncedContentKey.current === contentKey) return;
    syncedContentKey.current = contentKey;
    const q = contentKey
      ? parseSearchParams(Object.fromEntries(new URLSearchParams(contentKey)))
      : null;
    void Promise.resolve().then(() => syncContent(q));
  }, [contentKey, syncContent]);

  /** Runs `query` under `nextScope`: content results, heatmap filter and the URL. */
  function applySearch(query: string, nextScope: SearchScope) {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    const papers = scopeIncludesQuestions(nextScope);
    // Without 문제 only books are searched: a selected question paper (and its chapter) must go,
    // or the API would keep searching that explicit document.
    const clearDocument = dropsSelectedPaper(content.documentId, searchDocuments, papers);
    // UX6: the 본문 side runs only when it has a published document to search.
    if (q && readinessFor(nextScope).effective.body) {
      content.search(q, { includeQuestionPapers: papers, clearDocument });
    } else {
      content.clear();
      if (clearDocument) content.clearDocumentFilter();
    }
    const target = `${pathname}${patchSearch(window.location.search, {
      q: q || null,
      scope: nextScope === 'all' ? null : nextScope,
    })}`;
    const heatmapQ = scopeIncludesQuestions(nextScope) ? q.slice(0, OVERVIEW_SEARCH_MAX) : '';
    if (heatmapQ !== filters.q) {
      setView((v) => ({ ...v, q: heatmapQ }));
      startNavigation(() => router.replace(target, { scroll: false }));
    } else {
      window.history.replaceState(null, '', target);
    }
  }

  function changeScope(questions: boolean, includeContent: boolean) {
    // Both boxes may be off (UX6): the search button is then disabled and nothing is searched.
    applySearch(
      content.submitted?.query ?? searchParams.get('q') ?? '',
      scopeOf(questions, includeContent),
    );
  }

  function resetAll() {
    setDraft('');
    setView(EMPTY_OVERVIEW_FILTERS);
    content.clear();
    startNavigation(() => {
      const search = window.location.search;
      const merged = keepNoteChapter(
        search,
        mergeOverviewFilters(search, EMPTY_OVERVIEW_FILTERS),
        null,
      );
      router.replace(`${pathname}${patchSearch(merged, { q: null })}`, { scroll: false });
    });
  }

  function closeContentResults() {
    setDraft('');
    applySearch('', scope);
  }

  const withQuestions = scopeIncludesQuestions(scope);
  const withContent = scopeIncludesContent(scope);
  const chapterOptions = [
    { value: ALL, label: '전체 챕터' },
    ...chapterChoices.map((c) => ({ value: c.value, label: c.title })),
  ];

  return (
    <div className={styles.home} data-panel-open={panels.length > 0 || undefined}>
      <h1 className="qz-visually-hidden">{workspace.name}</h1>

      <div className={styles.header}>
        <UnifiedSearchForm
          screenId={screenIds.search}
          draft={draft}
          onDraftChange={setDraft}
          onSearch={() => applySearch(draft, scope)}
          readiness={readiness}
          questions={{
            checked: withQuestions,
            onCheckedChange: (checked) => changeScope(checked, withContent),
            settings: (
              <div className={styles.optionRow}>
                <Select
                  label="챕터"
                  options={chapterOptions}
                  value={view.chapter ?? ALL}
                  onValueChange={(value) =>
                    value && changeFilters({ chapter: value === ALL ? null : value })
                  }
                />
                <Select
                  label="유형"
                  options={[
                    { value: ALL, label: '전체 유형' },
                    ...TYPES.map((type) => ({ value: type, label: questionTypeLabels[type] })),
                  ]}
                  value={view.type ?? ALL}
                  onValueChange={(value) =>
                    value && changeFilters({ type: value === ALL ? null : (value as QuestionType) })
                  }
                />
              </div>
            ),
          }}
          body={{
            checked: withContent,
            onCheckedChange: (checked) => changeScope(withQuestions, checked),
            settings: (
              <ContentSearchOptions
                search={content}
                documents={
                  withQuestions
                    ? searchDocuments
                    : searchDocuments.filter((d) => !d.isQuestionPaper)
                }
                documentsLoadFailed={library.listFailed}
              />
            ),
          }}
        />

        <div className={styles.actions}>
          <div className={styles.actionGroup}>
            <Button onClick={() => setPanel('documents', true)}>
              문서 <span className={styles.count}>{bookCount}</span>
            </Button>
            <QuestionMenu
              canEdit={canEdit}
              bankHref={`/workspaces/${workspace.id}/questions/bank`}
              onPdfs={() => setPanel('question-pdfs', true)}
              onCreate={() => router.push(bankCreatePath(workspace.id))}
              onGenerate={() => setPanel('generate', true)}
            />
          </div>
          <div className={styles.actionGroup} data-align="end">
            <IconButton
              label="이력"
              icon={<HistoryIcon />}
              variant="secondary"
              onClick={() => setPanel('history', true)}
            />
            {isOwner ? (
              <IconButton
                label="공유하기"
                icon={<ShareIcon />}
                variant="secondary"
                onClick={() => setPanel('share', true)}
              />
            ) : null}
          </div>
        </div>
      </div>

      {readiness.effective.body ? (
        <ContentSearchResults
          workspaceId={workspace.id}
          search={content}
          onClose={closeContentResults}
        />
      ) : null}

      <QuestionsOverview
        workspaceId={workspace.id}
        readOnly={readOnly}
        filters={filters}
        view={view}
        navigating={navigating}
        onFiltersChange={changeFilters}
        onResetFilters={resetAll}
        overview={overview}
        failure={failure}
        requested={requested}
        panelScreenId={screenIds.practice}
        practiceReturnFocusRef={practiceReturnFocusRef}
        chapterActions={(chapter) =>
          chapter.id === NO_CHAPTER_KEY ? null : (
            <>
              {generating.has(chapter.id) ? <span>만드는 중</span> : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${chapter.title} 정리 노트`}
                aria-haspopup="dialog"
                onClick={() => openNote(chapter.id)}
              >
                정리 노트
              </Button>
            </>
          )
        }
      />

      {/* Dialogs are portalled here so they stay inside the main landmark. */}
      <div ref={setHost} />
      {host ? (
        <>
          <FloatingSidePanel
            open={isOpen('documents')}
            onOpenChange={(open) => setPanel('documents', open)}
            raiseKey={raised.documents}
            modal={false}
            container={host}
            title="문서 관리"
            closeLabel="문서 관리 닫기"
            mobileLayout="full"
          >
            <div data-screen-id={screenIds.documents}>
              <DocumentsLibrary
                workspaceId={workspace.id}
                library={library}
                canEdit={canEdit}
                readOnlyReason={
                  workspace.role === 'viewer' && !workspace.archived
                    ? '뷰어 권한으로는 문서를 볼 수만 있습니다.'
                    : undefined
                }
              />
            </div>
          </FloatingSidePanel>
          <QuestionPdfsDialog
            open={isOpen('question-pdfs')}
            onOpenChange={(open) => setPanel('question-pdfs', open)}
            raiseKey={raised['question-pdfs']}
            container={host}
            workspaceId={workspace.id}
            library={library}
            canEdit={canEdit}
            onOpenDocuments={() => setPanel('documents', true)}
          />
          {canEdit ? (
            <FloatingSidePanel
              open={isOpen('generate')}
              onOpenChange={(open) => setPanel('generate', open)}
              raiseKey={raised.generate}
              modal={false}
              container={host}
              title="문제 생성"
              closeLabel="문제 생성 닫기"
              mobileLayout="full"
            >
              <GenerationDialog
                workspaceId={workspace.id}
                archived={workspace.archived}
                chapters={chapterChoices}
                onShuffle={(questionId) => {
                  const search = patchSearch(withPanel(window.location.search, 'generate', false), {
                    question: questionId,
                  });
                  window.history.pushState(null, '', `${pathname}${search}`);
                }}
              />
            </FloatingSidePanel>
          ) : null}
          <FloatingSidePanel
            open={isOpen('history')}
            onOpenChange={(open) => setPanel('history', open)}
            raiseKey={raised.history}
            modal={false}
            container={host}
            title="이력"
            closeLabel="이력 닫기"
            mobileLayout="full"
          >
            <div data-screen-id={screenIds.history}>
              <HistoryPanel workspaceId={workspace.id} viewerId={viewerId} />
            </div>
          </FloatingSidePanel>
          <ChapterNotePanel
            open={isOpen('chapter-note')}
            onOpenChange={(open) => (open ? undefined : closeNote())}
            raiseKey={raised['chapter-note']}
            container={host}
            chapterId={noteChapter ?? null}
            chapterTitle={overview.chapters.find((c) => c.id === noteChapter)?.title}
            canEdit={canEdit}
            screenId={screenIds.chapterNote}
            onOpenQuestion={openNoteQuestion}
            onGeneratingChange={onNoteGenerating}
          />
          {isOwner && isOpen('share') ? (
            <WorkspaceSharingPanel
              workspaceId={workspace.id}
              archived={workspace.archived}
              open
              onOpenChange={(open) => setPanel('share', open)}
              raiseKey={raised.share}
              container={host}
              screenId={screenIds.share}
            />
          ) : null}
        </>
      ) : null}

      <DocumentLibraryFeedback library={library} />
    </div>
  );
}
