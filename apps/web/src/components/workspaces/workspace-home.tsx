'use client';

// Workspace home `/workspaces/:id` (QOV-01, docs/screens/questions-overview.md "Workspace 홈
// 레이아웃", UX3c): the single page of a workspace, without a sidebar.
//
//   Workspace header  the 문제 search (SEARCH-01-AC12: filters the heatmap as you type, no button;
//                     its "설정" popover holds the heatmap's chapter/type filters) with the
//                     "본문 검색" disclosure under it (AC10, collapsed by default), then two
//                     button groups: `문서 n` · `문제` (직접 추가 / 중복 문제 정리 | 보관·초안 문제 /
//                     모의고사 / 문제 풀기, UX4, MOCK-SYNC;
//                     no 전체 문제 since UX7-BANK, no PDF 관리 since UX7-DOCS), and, aligned right,
//                     `이력` · `공유하기` (icon
//                     buttons; share for the owner only)
//   본문 search       when expanded: its form (box, icon submit, "본문 설정") and the results
//                     (AC09; clicking a result opens the excerpt panel, AC11)
//   문제 영역         the heatmap (QuestionsOverview)
//   floating dialogs  문서 관리 (문제 PDF 관리 merged in, UX7-DOCS) · 모의고사 · 이력 · 링크 공유 · 정리 노트 · 문서 요약
//                     (DOCSUM-01, `?panel=document-summary&document=<id>`, from a 문서 관리 row): modal
//                     FloatingSidePanels (HOMEDLG-01, UX9) portalled into this page (inside <main>)
//                     and listed in the URL (`?panel=`, repeatable). While one is open the home
//                     behind it is inert, so buttons open one home dialog at a time; dialogs opened
//                     inside one (요약, 문제 상세, a footnote's question) and those of a deep link stack
//                     in opening order, the top one active (useStagedDialogs). The home never steps
//                     aside for them: opening or closing a dialog moves nothing.
//   문제 등록 editor  `?panel=question-create` (문제 › 직접 추가 and the empty heatmap, UX7-BANK): the
//                     modal question editor, rendered by QuestionsOverview; not a stacked panel.
//   챕터 재분배        `?panel=chapter-redistribution` (문제 › 챕터 재분배, CHREDIST-01, editors of an
//                     active workspace): a stacked floating dialog that moves confirmed questions
//                     between chapters (직접 옮기기, 자동 추천 미리보기); a move re-reads the heatmap
//                     and an open 정리 노트. Others' deep links to it are dropped from the URL.
//   중복 문제 정리     `?panel=question-duplicates` (문제 › 중복 문제 정리, UX7-DEDUP, editors of an active
//                     workspace): a stacked floating dialog that scans for identical confirmed
//                     questions and merges each group into the question kept (QOV-01-AC16).
//   보관·초안 문제     `?panel=inactive-questions` (문제 › 보관·초안 문제, UX7-BANK-2, every member): a
//                     stacked floating dialog of the draft and archived questions (QOV-01-AC15).
//   문제 풀기          `?practice=new&source=bank` → `?practice=<run>&i=<n>` (문제 › 문제 풀기, QVIEW-01,
//                     every member): the modal range run (QuestionViewer sequence, rendered by
//                     QuestionsOverview). Its steps replace the entry; positions push one.
//   모의고사           `?panel=mock-exams[&mock=new|<id>]` (문제 › 모의고사, MOCK-01, every member): a
//                     stacked floating dialog of the workspace's mock exams; list → 만들기 / 상세
//                     pushes an entry. A mock exam's 풀기 opens the run panel with `source=mock`.
//
// State lives in the URL: heatmap filters (overview-filters.ts), the 문제 search `q`, the 본문
// search `text` and its options (search/state.ts), `panel` (+ `chapter` of the 정리 노트 panel, CHNOTE-01: a Heatmap
// chapter header's `정리 노트` button opens it), and `question` (the practice panel). Dialogs and
// panels open on a new history entry and closing one (its button or Back) drops those entries
// (usePanelHistory, UX7-BACK/UX7-BACK-2: neither Back nor Forward reopens it; Next syncs
// useSearchParams, no server round trip); filter and 문제 search changes write the URL at once and use router.replace (the server
// re-reads the overview, rereadHeatmap; the 문제 search only once typing pauses). The 본문 search
// writes its keys in place (replace).
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  FloatingSidePanel,
  HistoryIcon,
  IconButton,
  questionTypeLabels,
  Select,
  ShareIcon,
  type QuestionType,
} from '@quiz/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { DocumentLibraryFeedback } from '@/components/documents/document-library-feedback';
import { DocumentsLibrary } from '@/components/documents/documents-library';
import { DocumentSummaryPanel } from '@/components/documents/summary/document-summary-panel';
import { useSummaryActivity } from '@/components/documents/summary/use-summary-activity';
import { bodyDocumentCount } from '@/components/documents/labels';
import { useDocumentLibrary } from '@/components/documents/use-document-library';
import { HistoryPanel } from '@/components/history/history-panel';
import { QuestionDuplicates } from '@/components/questions/duplicates/question-duplicates';
import { InactiveQuestions } from '@/components/questions/inactive/inactive-questions';
import { MockExamsPanel } from '@/components/questions/mock-exams/mock-exams-panel';
import { ChapterNotePanel } from '@/components/questions/notes/chapter-note-panel';
import { ChapterRedistributionDialog } from '@/components/questions/redistribution/chapter-redistribution-dialog';
import { QuestionsOverview } from '@/components/questions/overview/questions-overview';
import {
  ContentSearchOptions,
  ContentSearchResults,
  useContentSearch,
} from '@/components/search/content-search';
import { ContentSearchForm } from '@/components/search/content-search-form';
import { QuestionSearch } from '@/components/search/question-search';
import searchStyles from '@/components/search/search-forms.module.css';
import { useLiveQuery } from '@/components/search/use-live-query';
import { listChapterNotes } from '@/lib/notes/client';
import { generatingChapters, type ChapterNoteList } from '@/lib/notes/model';
import { WorkspaceSharingPanel } from '@/components/sharing/workspace-sharing-panel';
import { QuestionMenu } from './question-menu';
import type { DocumentSummary } from '@/lib/documents/client-api';
import type { ChapterChoice, QuestionOverview } from '@/lib/questions/overview-data';
import {
  EMPTY_OVERVIEW_FILTERS,
  mergeOverviewFilters,
  parseOverviewFilters,
  OVERVIEW_SEARCH_MAX,
  overviewSearch,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import { NO_CHAPTER_KEY, type PlacedQuestion } from '@/lib/questions/overview-placement';
import type { QuestionFailureKind } from '@/lib/questions/problems';
import type { SearchQuery } from '@/lib/search/client';
import {
  addressBarContentKey,
  hasSearchableBody,
  hasSearchableQuestions,
  isSearchableBody,
} from '@/lib/search/scope';
import { CONTENT_QUERY_PARAM, MAX_QUERY_CHARS, parseSearchParams } from '@/lib/search/state';
import {
  isChapterNoteOpen,
  keepNoteChapter,
  noteChapterOf,
  openChapterNote,
  parsePanels,
  isHomePanel,
  patchSearch,
  withChapterNote,
  summaryDocumentId,
  contentSearchParams,
  DUPLICATES_PANEL,
  INACTIVE_QUESTIONS_PANEL,
  MOCK_EXAMS_PANEL,
  REDISTRIBUTION_PANEL,
  mockParamOf,
  mockViewOf,
  runOwnsMockParam,
  withMockView,
  withoutMockExams,
  type MockView,
  ownSummaryDocument,
  QUESTION_CREATE_PANEL,
  type ContentDocumentFilter,
  withPanel,
  withSummaryPanel,
  withoutPanels,
  openDialogs,
  closeDialog,
  exclusiveClose,
  withMockRun,
  withShownMockView,
  RUN_DIALOG,
  withPracticeQuestion,
  withRunPanel,
  type HomePanel,
} from '@/lib/workspaces/home';
import { withRunState, type RunUrlState } from '@/lib/questions/practice-runs';
import { useManualScrollWhile, usePanelHistory } from './use-panel-history';
import { useStagedDialogs } from './use-staged-dialogs';
import styles from './workspace-home.module.css';

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];
/** Re-reads of the same wanted heatmap filters after interrupted reads (see rereadHeatmap). */
const MAX_HEATMAP_RETRIES = 3;

export interface WorkspaceHomeProps {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly role: 'owner' | 'editor' | 'viewer';
    readonly archived: boolean;
  };
  /** Verified id of the signed-in user (history entries of this actor read "나"). */
  readonly viewerId: string | null;
  /** Heatmap filters the server rendered `overview` with (`q` = the 문제 search). */
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
    readonly summary: string;
    readonly mockExams: string;
    readonly redistribution?: string;
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
  // Closing a dialog (its button or Back) drops the entries that opened it, so neither Back nor
  // Forward reopens it (UX7-BACK, UX7-BACK-2); what changed meanwhile (filters) is kept.
  const panelHistory = usePanelHistory({
    open: openDialogs,
    // Closing the run (its button or Back) hands `mock` back to the 모의고사 dialog's view.
    close: (search, dialog) => {
      const closed = closeDialog(search, dialog, executedFilter());
      return dialog === RUN_DIALOG ? keepMockView(closed) : closed;
    },
    closeAll: (search) => withoutPanels(search, executedFilter()),
    read: (url) => router.replace(url, { scroll: false }),
  });
  function closeTo(url: string) {
    panelHistory.close(url);
  }
  // The practice panel and the run panel are never open together (QVIEW-01-AC09): opening one
  // over the other closes that one first (neither Back nor Forward brings it back), then opens.
  function openPanelAt(target: string) {
    const search = new URL(target, window.location.href).search;
    const closed = exclusiveClose(window.location.search, search);
    if (closed === null) panelHistory.push(target);
    else panelHistory.close(`${pathname}${closed}`, target);
  }
  const allowed = (panel: HomePanel) =>
    (panel !== 'share' || isOwner) &&
    ((panel !== QUESTION_CREATE_PANEL &&
      panel !== DUPLICATES_PANEL &&
      panel !== REDISTRIBUTION_PANEL) ||
      canEdit);
  const panels = parsePanels(searchParams).filter(allowed);
  const isOpen = (panel: HomePanel) => panels.includes(panel);
  // The dialogs on screen: the URL's, mounted one per commit in opening order (HOMEDLG-01). The
  // practice and run panels (rendered by QuestionsOverview) wait for the dialogs listed before them.
  const urlDialogs = openDialogs(`?${searchParams.toString()}`).filter(
    (dialog) => !isHomePanel(dialog) || allowed(dialog),
  );
  const staged = useStagedDialogs(urlDialogs);
  const shows = (panel: HomePanel) => isOpen(panel) && staged.has(panel);
  const holdPracticePanels = urlDialogs.some((dialog) => !staged.has(dialog));
  useManualScrollWhile(urlDialogs.length > 0);
  const setPanel = (panel: HomePanel, open: boolean) => {
    if (open) {
      // A home dialog's button is behind the open dialog (inert): an open one is never reopened.
      if (isOpen(panel)) return;
      panelHistory.push(`${pathname}${withPanel(window.location.search, panel, true)}`);
      return;
    }
    if (!isOpen(panel)) return;
    // Closing the summary panel hands `document`/`section` back to the executed content search.
    const search =
      panel === 'document-summary'
        ? withSummaryPanel(window.location.search, null, executedFilter())
        : panel === MOCK_EXAMS_PANEL
          ? withoutMockExams(window.location.search)
          : withPanel(window.location.search, panel, false);
    closeTo(`${pathname}${search}`);
  };
  // DOCSUM-01: one summary panel; another row's 요약 switches its document (and raises it).
  const summaryDocId = summaryDocumentId(searchParams);
  const summaryOpenerRef = useRef<HTMLElement | null>(null);
  const openSummary = (documentId: string, opener: HTMLElement) => {
    summaryOpenerRef.current = opener;
    panelHistory.push(`${pathname}${withSummaryPanel(window.location.search, documentId)}`);
  };
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // CHREDIST-01: without edit rights the dialog's deep link opens nothing and leaves the URL.
  const deniedRedistribution = !canEdit && parsePanels(searchParams).includes(REDISTRIBUTION_PANEL);
  useEffect(() => {
    if (!deniedRedistribution) return;
    panelHistory.replace(
      `${pathname}${withPanel(window.location.search, REDISTRIBUTION_PANEL, false)}`,
    );
  }, [deniedRedistribution, panelHistory, pathname]);

  // --- 정리 노트 (CHNOTE-01) ---------------------------------------------------------------------
  // `chapter` names the note's chapter while its panel is open (home.ts noteChapterOf).
  const noteChapter = noteChapterOf(searchParams);
  function openNote(chapterId: string) {
    const next = openChapterNote(window.location.search, chapterId);
    const target = `${pathname}${next.search}`;
    panelHistory.push(target);
    if (view.chapter !== null) {
      // The note takes over `chapter`: drop the heatmap's chapter filter with it (re-read).
      setView((v) => ({ ...v, chapter: null }));
      startNavigation(() => router.replace(target, { scroll: false }));
    }
  }
  function closeNote() {
    if (!isOpen('chapter-note')) return;
    closeTo(`${pathname}${withChapterNote(window.location.search, null)}`);
  }
  // Practice opened from a footnote returns focus to the note's disclosure when it closes.
  const practiceReturnFocusRef = useRef<HTMLElement | null>(null);
  function openNoteQuestion(questionId: string, returnFocus: HTMLElement | null) {
    practiceReturnFocusRef.current = returnFocus;
    openPanelAt(`${pathname}${withPracticeQuestion(window.location.search, questionId)}`);
  }
  // The range run panel (QVIEW-01): opened from the 문제 menu on a new entry; its range → run →
  // results steps rewrite that entry, its positions push entries, closing drops them (QOV-01-AC14).
  function openRun() {
    const picker: RunUrlState = { step: 'picker', source: 'bank', mockExamId: null };
    openPanelAt(`${pathname}${withRunPanel(window.location.search, picker)}`);
  }
  function navigateRun(state: RunUrlState, how: 'push' | 'replace') {
    const target = `${pathname}${keepMockView(withRunState(window.location.search, state))}`;
    if (how === 'push') panelHistory.push(target);
    else panelHistory.replace(target);
  }
  function closeRun() {
    closeTo(`${pathname}${keepMockView(withRunState(window.location.search, null))}`);
  }

  // --- 모의고사 (MOCK-01) ---------------------------------------------------------------------------
  // The dialog's view is `mock`, which a mock exam run's range step borrows for its mock exam
  // (home.ts runOwnsMockParam): meanwhile the dialog keeps the view it last showed, and the run's
  // later steps hand `mock` back to it.
  const urlMockView = mockViewOf(searchParams);
  const borrowed = runOwnsMockParam(searchParams);
  const [shownMockView, setShownMockView] = useState<MockView>(urlMockView);
  if (!borrowed && mockParamOf(urlMockView) !== mockParamOf(shownMockView)) {
    setShownMockView(urlMockView);
  }
  const mockView = borrowed ? shownMockView : urlMockView;
  function keepMockView(search: string): string {
    return withShownMockView(search, shownMockView);
  }
  function changeMockView(view: MockView, how: 'push' | 'replace') {
    const target = `${pathname}${withMockView(window.location.search, view)}`;
    if (how === 'push') panelHistory.push(target);
    else panelHistory.replace(target);
  }
  /** A mock exam's 풀기: the run panel's range step on it (QVIEW-01 `sequence(mock)`). */
  function openMockRun(mockExamId: string) {
    openPanelAt(`${pathname}${withMockRun(window.location.search, mockExamId)}`);
  }
  // The practice panel's open, previous/next (new entries) and close (QPLAY-01-AC05, UX7-BACK).
  function changeQuestion(questionId: string | null) {
    if (questionId) {
      openPanelAt(`${pathname}${withPracticeQuestion(window.location.search, questionId)}`);
      return;
    }
    closeTo(`${pathname}${patchSearch(window.location.search, { question: null })}`);
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

  // --- documents (문서 관리, with the question PDFs since UX7-DOCS) -------------------------------
  const library = useDocumentLibrary({
    workspaceId: workspace.id,
    initialDocuments: documents,
    canEdit,
    loadFailed: documentsLoadFailed,
  });
  // UX6-UPLOAD: `문서 n` counts the PDFs with body text (교재, 교재+문제).
  const bookCount = bodyDocumentCount(library.documents);
  const summaryActivity = useSummaryActivity(workspace.id, isOpen('documents'));
  // Only this workspace's documents: another workspace's id (even one the user can read) is
  // "문서를 찾을 수 없습니다." and is never loaded here (DOCSUM-01-AC07).
  const summaryDocument = ownSummaryDocument(summaryDocId, library.documents);
  const searchDocuments = library.documents
    .filter(isSearchableBody)
    .map((d) => ({ id: d.id, title: d.title }));
  // Bumped when the heatmap's panel changes a question: an open 보관·초안 문제 list re-reads.
  const [questionsVersion, setQuestionsVersion] = useState(0);
  // Bumped when 챕터 재분배 moved questions: an open 정리 노트 panel reads its note again.
  const [notesVersion, setNotesVersion] = useState(0);
  // A move (or a move refused because questions changed) re-reads the heatmap and the notes. The
  // dialog's close replaces the URL, which can drop a refresh still in flight: it is redone then.
  const chaptersStale = useRef(false);
  const onChaptersChanged = () => {
    chaptersStale.current = true;
    setQuestionsVersion((n) => n + 1);
    setNotesVersion((n) => n + 1);
    setNoteListRead((n) => n + 1);
    startNavigation(() => router.refresh());
  };
  const redistributionOpen = isOpen(REDISTRIBUTION_PANEL);
  useEffect(() => {
    if (redistributionOpen || !chaptersStale.current) return;
    chaptersStale.current = false;
    startNavigation(() => router.refresh());
  }, [redistributionOpen, router]);
  // Source titles of the 문제 상세 dialog (UX7-BANK-2).
  const documentTitles = library.documents.map((d) => ({ id: d.id, title: d.title }));

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

  /**
   * Writes `search` (new heatmap filters or the 문제 search) into the address bar at once, then
   * has the server re-read the overview for it (UX7-SEARCH). Without the immediate write, a
   * dialog opened while the re-read was loading pushed a URL without the new filters (its
   * pushState also discards the pending navigation), or the navigation's URL, a snapshot from
   * before, dropped the dialog's `panel`. Now later URL writes build on the new URL; a re-read
   * discarded that way is redone by the reconciliation below. A newer re-read supersedes an older
   * one, so a late answer never wins.
   */
  function rereadHeatmap(search: string) {
    const target = `${pathname}${search}`;
    panelHistory.replace(target);
    startNavigation(() => router.replace(target, { scroll: false }));
  }

  // The heatmap filters the address bar asks for (as the page reads them: the open 정리 노트
  // panel owns `chapter`). When they differ from what the server rendered and nothing is
  // loading, a re-read was discarded (see rereadHeatmap): read the current URL again.
  const urlFilters = parseOverviewFilters(searchParams);
  const urlFiltersKey = overviewSearch(
    isChapterNoteOpen(searchParams) ? { ...urlFilters, chapter: null } : urlFilters,
  );
  // Retries are tracked per wanted filters: a retry is tried once per navigation target (a retry
  // that a later history change interrupted has a new target, e.g. a dialog closed meanwhile),
  // and at most MAX_HEATMAP_RETRIES times in all, so a server that keeps failing never loops.
  const healRef = useRef<{ key: string; targets: string[] } | null>(null);
  useEffect(() => {
    if (navigating) return;
    if (urlFiltersKey === filtersKey) {
      healRef.current = null;
      return;
    }
    const target = `${pathname}${window.location.search}`;
    const heal =
      healRef.current?.key === urlFiltersKey
        ? healRef.current
        : (healRef.current = { key: urlFiltersKey, targets: [] });
    if (heal.targets.includes(target) || heal.targets.length >= MAX_HEATMAP_RETRIES) return;
    heal.targets.push(target);
    startNavigation(() => router.replace(target, { scroll: false }));
  }, [filtersKey, navigating, pathname, router, searchParams, urlFiltersKey]);

  function changeFilters(patch: Partial<OverviewFilters>) {
    const next = { ...view, ...patch };
    setView(next);
    const search = window.location.search;
    rereadHeatmap(
      keepNoteChapter(search, mergeOverviewFilters(search, next), patch.chapter ?? null),
    );
  }

  // --- 문제 search (SEARCH-01-AC12: live, debounced; `q`) ---------------------------------------
  const questionSearch = useLiveQuery({
    urlValue: (searchParams.get('q') ?? '').trim().slice(0, OVERVIEW_SEARCH_MAX),
    max: OVERVIEW_SEARCH_MAX,
    onCommit: (q) => {
      setView((v) => ({ ...v, q }));
      // replaceState: typing never adds history entries.
      rereadHeatmap(patchSearch(window.location.search, { q: q || null }));
    },
  });

  function resetAll() {
    questionSearch.replace('');
    setView(EMPTY_OVERVIEW_FILTERS);
    const search = window.location.search;
    const merged = keepNoteChapter(
      search,
      mergeOverviewFilters(search, EMPTY_OVERVIEW_FILTERS),
      null,
    );
    rereadHeatmap(patchSearch(merged, { q: null }));
  }

  // --- 본문 search (SEARCH-01-AC09/AC10: collapsed by default; `text` + options) ---------------
  const hasBody = hasSearchableBody(library.documents, library.listFailed);
  const content = useContentSearch({
    workspaceId: workspace.id,
    initial: initialSearch,
    runInitial: hasBody,
  });
  const urlText = searchParams.get(CONTENT_QUERY_PARAM) ?? '';
  const [contentDraft, setContentDraft] = useState(urlText);
  // Open on arrival with a 본문 search in the URL, and whenever the address bar brings one back.
  const [contentOpen, setContentOpen] = useState(urlText !== '');
  const [seenText, setSeenText] = useState(urlText);
  if (seenText !== urlText) {
    setSeenText(urlText);
    setContentDraft(urlText);
    if (urlText) setContentOpen(true);
  }
  const contentRegionId = useId();
  const contentInputRef = useRef<HTMLInputElement | null>(null);
  const focusContentRef = useRef(false);
  useEffect(() => {
    if (!contentOpen || !focusContentRef.current) return;
    focusContentRef.current = false;
    contentInputRef.current?.focus();
  }, [contentOpen]);
  function toggleContent() {
    if (contentOpen) content.closeHit();
    else focusContentRef.current = true;
    setContentOpen(!contentOpen);
  }

  // The address bar can change under us (browser Back/Forward restores an earlier search): the
  // executed content search follows it. Our own updates write the same state they already show,
  // so following them is a no-op. While the summary panel owns `document`/`section`, the content
  // search reads its own executed filter there (contentSearchParams): opening or closing the
  // panel never re-runs a search.
  const executedFilter = (): ContentDocumentFilter | null =>
    content.submitted
      ? { documentId: content.submitted.documentId, chapterId: content.submitted.chapterId }
      : null;
  const contentKey = hasBody
    ? addressBarContentKey(Object.fromEntries(contentSearchParams(searchParams, executedFilter())))
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

  /** Runs the 본문 search for `query` (empty: clears it and its `text`). */
  function applyContentSearch(query: string) {
    const q = query.trim().slice(0, MAX_QUERY_CHARS);
    let search: string;
    if (q && hasBody) {
      // Writes the search into the address bar at once (keeping Next's history state)…
      content.search(q);
      search = window.location.search;
    } else {
      content.clear();
      search = patchSearch(window.location.search, { [CONTENT_QUERY_PARAM]: null });
    }
    // …and this write, without Next's state, makes useSearchParams follow it, so a later
    // Back/Forward to another `text` is seen as a change.
    panelHistory.replace(`${pathname}${search}`);
  }

  function closeContentResults() {
    setContentDraft('');
    applyContentSearch('');
  }

  const chapterOptions = [
    { value: ALL, label: '전체 챕터' },
    ...chapterChoices.map((c) => ({ value: c.value, label: c.title })),
  ];

  return (
    <div className={styles.home}>
      <h1 className="qz-visually-hidden">{workspace.name}</h1>

      <div className={styles.header}>
        <div className={searchStyles.column}>
          <QuestionSearch
            screenId={screenIds.search}
            query={questionSearch}
            max={OVERVIEW_SEARCH_MAX}
            searchable={hasSearchableQuestions(hasQuestions)}
            settings={
              <div className={searchStyles.optionRow}>
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
            }
          />
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={contentOpen}
            aria-controls={contentRegionId}
            onClick={toggleContent}
          >
            본문 검색
            {contentOpen ? (
              <ChevronUpIcon width={16} height={16} aria-hidden="true" />
            ) : (
              <ChevronDownIcon width={16} height={16} aria-hidden="true" />
            )}
          </Button>
        </div>

        <div className={styles.actions}>
          <div className={styles.actionGroup}>
            <Button onClick={() => setPanel('documents', true)}>
              문서 <span className={styles.count}>{bookCount}</span>
            </Button>
            <QuestionMenu
              readOnly={readOnly}
              onCreate={() => setPanel(QUESTION_CREATE_PANEL, true)}
              onDuplicates={() => setPanel(DUPLICATES_PANEL, true)}
              onRedistribute={() => setPanel(REDISTRIBUTION_PANEL, true)}
              onInactive={() => setPanel(INACTIVE_QUESTIONS_PANEL, true)}
              onMockExams={() => setPanel(MOCK_EXAMS_PANEL, true)}
              onPractice={openRun}
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

      <div id={contentRegionId} className={searchStyles.contentArea} hidden={!contentOpen}>
        <ContentSearchForm
          inputRef={contentInputRef}
          draft={contentDraft}
          onDraftChange={setContentDraft}
          onSearch={() => applyContentSearch(contentDraft)}
          searchable={hasBody}
          settings={
            <ContentSearchOptions
              search={content}
              documents={searchDocuments}
              documentsLoadFailed={library.listFailed}
            />
          }
        />
        {hasBody ? (
          <ContentSearchResults
            workspaceId={workspace.id}
            search={content}
            onClose={closeContentResults}
          />
        ) : null}
      </div>

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
        onQuestionChange={changeQuestion}
        onRunNavigate={navigateRun}
        onRunClose={closeRun}
        createOpen={shows(QUESTION_CREATE_PANEL)}
        holdPanels={holdPracticePanels}
        dialogContainer={host}
        onCreateOpenChange={(open) => setPanel(QUESTION_CREATE_PANEL, open)}
        documents={documentTitles}
        onQuestionsChanged={() => setQuestionsVersion((n) => n + 1)}
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
            open={shows('documents')}
            onOpenChange={(open) => setPanel('documents', open)}
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
                summary={{ onOpen: openSummary, busy: summaryActivity.busy }}
              />
            </div>
          </FloatingSidePanel>
          {canEdit ? (
            <FloatingSidePanel
              open={shows(DUPLICATES_PANEL)}
              onOpenChange={(open) => setPanel(DUPLICATES_PANEL, open)}
              container={host}
              title="중복 문제 정리"
              closeLabel="중복 문제 정리 닫기"
              mobileLayout="full"
            >
              {shows(DUPLICATES_PANEL) ? (
                <QuestionDuplicates
                  workspaceId={workspace.id}
                  onMerged={() => setQuestionsVersion((n) => n + 1)}
                />
              ) : null}
            </FloatingSidePanel>
          ) : null}
          {canEdit ? (
            <ChapterRedistributionDialog
              open={shows(REDISTRIBUTION_PANEL)}
              onOpenChange={(open) => setPanel(REDISTRIBUTION_PANEL, open)}
              container={host}
              workspaceId={workspace.id}
              onChanged={onChaptersChanged}
              screenId={screenIds.redistribution}
            />
          ) : null}
          <FloatingSidePanel
            open={shows(INACTIVE_QUESTIONS_PANEL)}
            onOpenChange={(open) => setPanel(INACTIVE_QUESTIONS_PANEL, open)}
            container={host}
            title="보관·초안 문제"
            closeLabel="보관·초안 문제 닫기"
            mobileLayout="full"
          >
            <InactiveQuestions
              workspaceId={workspace.id}
              readOnly={readOnly}
              documents={documentTitles}
              refreshKey={questionsVersion}
            />
          </FloatingSidePanel>
          <MockExamsPanel
            open={shows(MOCK_EXAMS_PANEL)}
            onOpenChange={(open) => setPanel(MOCK_EXAMS_PANEL, open)}
            container={host}
            workspaceId={workspace.id}
            canEdit={canEdit}
            view={mockView}
            onViewChange={changeMockView}
            onPractise={(exam) => openMockRun(exam.id)}
            screenId={screenIds.mockExams}
          />
          <FloatingSidePanel
            open={shows('history')}
            onOpenChange={(open) => setPanel('history', open)}
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
            open={shows('chapter-note')}
            onOpenChange={(open) => (open ? undefined : closeNote())}
            container={host}
            chapterId={noteChapter ?? null}
            chapterTitle={overview.chapters.find((c) => c.id === noteChapter)?.title}
            canEdit={canEdit}
            screenId={screenIds.chapterNote}
            onOpenQuestion={openNoteQuestion}
            onGeneratingChange={onNoteGenerating}
            refreshKey={notesVersion}
          />
          <DocumentSummaryPanel
            open={shows('document-summary')}
            onOpenChange={(open) => setPanel('document-summary', open)}
            container={host}
            workspaceId={workspace.id}
            documentId={summaryDocument?.id ?? null}
            // An id the list could not confirm because the list failed: retry, not "not found".
            documentListFailed={summaryDocId !== null && !summaryDocument && library.listFailed}
            onReloadDocumentList={() => void library.refresh()}
            documentTitle={summaryDocument?.title ?? null}
            questionPaper={summaryDocument?.document_type === 'question_paper'}
            canEdit={canEdit}
            screenId={screenIds.summary}
            returnFocusTo={() => summaryOpenerRef.current}
            onActivity={summaryActivity.report}
          />
          {isOwner && shows('share') ? (
            <WorkspaceSharingPanel
              workspaceId={workspace.id}
              archived={workspace.archived}
              open
              onOpenChange={(open) => setPanel('share', open)}
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
