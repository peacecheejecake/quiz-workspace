'use client';

// Workspace home `/workspaces/:id` (QOV-01, docs/screens/questions-overview.md "Workspace 홈
// 레이아웃", UX3c): the single page of a workspace, without a sidebar.
//
//   Workspace header  the 문제 search (SEARCH-01-AC12: filters the heatmap as you type, no button;
//                     its "설정" popover holds the heatmap's chapter/type filters), then two
//                     button groups: `문서 n` · `문제` (직접 추가 / 중복 문제 정리 | 보관·초안 문제 /
//                     모의고사 / 문제 풀기, UX4, MOCK-SYNC;
//                     no 전체 문제 since UX7-BANK, no PDF 관리 since UX7-DOCS; AI 질문 last, ASK-01), and,
//                     aligned right, `AI 질문` (icon + text, every member) · `본문 검색` · `이력` ·
//                     `공유하기` (icon buttons; share for the owner only). `본문 검색` is a link to the
//                     본문 search page (SEARCH-02, UX9: the home's collapsed 본문 search area is gone,
//                     its place under the 문제 search left empty; its `AI에게 묻기` lives there now)
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
//   AI 질문            `?panel=ask[&conversation=<id>]` (header `AI 질문`, 문제 › AI 질문, a question's
//                     `질문하기`; ASK-01, every member): a stacked modal dialog (HOMEDLG-01); list → a
//                     conversation pushes an entry, the first question of a new one replaces it.
//                     It is unrelated to the practice/run exclusivity (QVIEW-01-AC09).
//
// State lives in the URL: heatmap filters (overview-filters.ts), the 문제 search `q`, `panel` (+ `chapter` of the 정리 노트 panel, CHNOTE-01: a Heatmap
// chapter header's `정리 노트` button opens it), and `question` (the practice panel). Dialogs and
// panels open on a new history entry and closing one (its button or Back) drops those entries
// (usePanelHistory, UX7-BACK/UX7-BACK-2: neither Back nor Forward reopens it; Next syncs
// useSearchParams, no server round trip); filter and 문제 search changes write the URL at once via
// panelHistory.replace and serve from the in-memory OverviewCache or fetch the overview BFF route
// (QSEARCH-CACHE; non-empty 문제 search debounced 350ms, clearing to empty restores in 0ms).
import {
  Button,
  FloatingSidePanel,
  HistoryIcon,
  IconButton,
  questionTypeLabels,
  SearchIcon,
  Select,
  ShareIcon,
  Tooltip,
  type QuestionType,
} from '@quiz/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
import { QuestionSearch } from '@/components/search/question-search';
import { isPlainClick, markSearchEntryFromHome } from '@/components/search/search-entry';
import searchStyles from '@/components/search/search-forms.module.css';
import { useLiveQuery } from '@/components/search/use-live-query';
import { listChapterNotes } from '@/lib/notes/client';
import { generatingChapters, type ChapterNoteList } from '@/lib/notes/model';
import { WorkspaceSharingPanel } from '@/components/sharing/workspace-sharing-panel';
import { AskIcon } from '@/components/ask/ask-icons';
import {
  AskLauncherProvider,
  useGuardedAskLaunch,
  type AskLaunched,
} from '@/components/ask/ask-launcher';
import { AskPanel, type AskIntent } from '@/components/ask/ask-panel';
import { useAskState } from '@/components/ask/use-ask-state';
import { normalizeScope } from '@/lib/ask/client';
import { EMPTY_SCOPE, unavailableReason, unavailableText } from '@/lib/ask/model';
import { loginRedirectPath } from '@/lib/auth/routes';
import { QuestionMenu } from './question-menu';
import type { DocumentSummary } from '@/lib/documents/client-api';
import { fetchQuestionOverview, OverviewCache } from '@/lib/questions/overview-cache';
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
import { hasSearchableQuestions, isSearchableBody } from '@/lib/search/scope';
import {
  homeOpensBlocked,
  isChapterNoteOpen,
  keepNoteChapter,
  NO_CHAPTER_NOTE,
  noteChapterOf,
  openChapterNote,
  parsePanels,
  isHomePanel,
  patchSearch,
  withChapterNote,
  summaryDocumentId,
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
  withPanel,
  withSummaryPanel,
  withoutPanels,
  holdsPracticePanels,
  openDialogs,
  closeDialog,
  exclusiveClose,
  withMockRun,
  withShownMockView,
  RUN_DIALOG,
  withPracticeQuestion,
  withRunPanel,
  searchPagePath,
  type HomePanel,
  ASK_PANEL,
  askConversationOf,
  withAskConversation,
  withoutAsk,
} from '@/lib/workspaces/home';
import { withRunState, type RunUrlState } from '@/lib/questions/practice-runs';
import { useManualScrollWhile, usePanelHistory } from './use-panel-history';
import { useStagedDialogs } from './use-staged-dialogs';
import styles from './workspace-home.module.css';

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

function effectiveOverviewFilters(
  params: Readonly<Record<string, string | string[] | undefined>> | URLSearchParams,
): OverviewFilters {
  const parsed = parseOverviewFilters(params);
  return isChapterNoteOpen(params) ? { ...parsed, chapter: null } : parsed;
}

function seedOverviewCache(
  workspaceId: string,
  viewerId: string | null,
  filters: OverviewFilters,
  overview: QuestionOverview,
  failure: QuestionFailureKind | null,
  unfilteredOverview: QuestionOverview | null,
): OverviewCache {
  const seeded = new OverviewCache(workspaceId, viewerId);
  if (unfilteredOverview) seeded.put(EMPTY_OVERVIEW_FILTERS, unfilteredOverview);
  if (!failure) seeded.put(filters, overview);
  return seeded;
}

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
  /** Unfiltered heatmap when SSR loaded it alongside a filtered URL (QSEARCH-CACHE). */
  readonly unfilteredOverview?: QuestionOverview | null;
  readonly chapterChoices: readonly ChapterChoice[];
  readonly failure: QuestionFailureKind | null;
  readonly requested: PlacedQuestion | null;
  /** Whether the workspace has any question to search (null = unknown, never blocks). */
  readonly hasQuestions?: boolean | null;
  readonly documents: readonly DocumentSummary[];
  readonly documentsLoadFailed: boolean;
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
    readonly ask?: string;
  };
}

export function WorkspaceHome({
  workspace,
  viewerId,
  filters,
  overview,
  unfilteredOverview = null,
  chapterChoices,
  failure,
  requested,
  hasQuestions = null,
  documents,
  documentsLoadFailed,
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
      const closed = closeDialog(search, dialog);
      return dialog === RUN_DIALOG ? keepMockView(closed) : closed;
    },
    closeAll: (search) => withoutPanels(search),
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
  const holdPracticePanels = holdsPracticePanels(urlDialogs, staged);
  useManualScrollWhile(urlDialogs.length > 0);
  const setPanel = (panel: HomePanel, open: boolean) => {
    if (open) {
      // A home dialog's button is behind the open dialog (inert): an open one is never reopened,
      // and nothing opens from the home while the note is open (CHNOTE-02-C05).
      if (isOpen(panel) || homeOpensBlocked(new URLSearchParams(window.location.search))) return;
      panelHistory.push(`${pathname}${withPanel(window.location.search, panel, true)}`);
      return;
    }
    if (!isOpen(panel)) return;
    const search =
      panel === 'document-summary'
        ? withSummaryPanel(window.location.search, null)
        : panel === MOCK_EXAMS_PANEL
          ? withoutMockExams(window.location.search)
          : panel === ASK_PANEL
            ? withoutAsk(window.location.search)
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
      // The note takes over `chapter`: drop the heatmap's chapter filter with it.
      const dropped = effectiveOverviewFilters(new URLSearchParams(next.search));
      setView(dropped);
      requestOverview(dropped);
    }
  }
  function closeNote() {
    if (!isOpen('chapter-note')) return;
    closeTo(`${pathname}${withChapterNote(window.location.search, null)}`);
  }
  // Practice opened from a footnote (stacked over the note) returns focus to that footnote.
  const practiceReturnFocusRef = useRef<HTMLElement | null>(null);
  function openNoteQuestion(questionId: string, returnFocus: HTMLElement | null) {
    practiceReturnFocusRef.current = returnFocus;
    openPanelAt(`${pathname}${withPracticeQuestion(window.location.search, questionId)}`);
  }
  // The range run panel (QVIEW-01): opened from the 문제 menu on a new entry; its range → run →
  // results steps rewrite that entry, its positions push entries, closing drops them (QOV-01-AC14).
  function openRun() {
    if (homeOpensBlocked(new URLSearchParams(window.location.search))) return;
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

  // --- AI 질문 (ASK-01) -------------------------------------------------------------------------
  // One panel: the header button and 문제 › AI 질문 open it; the 본문 search page's `AI에게 묻기`
  // (SEARCH-02) has its own. Each opening starts it afresh (askSession): unsent input never
  // survives a close. Like every home dialog it is modal (HOMEDLG-01, UX9). A question's
  // `질문하기` (ASK-Q, the launcher below) opens it on a new conversation with that question
  // attached, on top of the modal layers (practice, range run, 문제 상세, mock exam question); it is
  // always the last of the URL's dialogs (openDialogs), so a deep link or reload stacks it on top.
  const ask = useAskState(workspace.id);
  const askConversation = askConversationOf(searchParams) ?? null;
  const askOpen = isOpen(ASK_PANEL);
  const askReason = unavailableReason(ask.state, workspace.archived);
  const askUnavailable = askReason ? unavailableText(askReason) : null;
  const [askSession, setAskSession] = useState(0);
  const [askWasOpen, setAskWasOpen] = useState(askOpen);
  if (askOpen !== askWasOpen) {
    setAskWasOpen(askOpen);
    if (askOpen) setAskSession((n) => n + 1);
  }
  const [askIntent, setAskIntent] = useState<AskIntent | null>(null);
  const askIntentKey = useRef(0);
  const [askOpener, setAskOpener] = useState<HTMLElement | null>(null);
  function openAsk() {
    if (!askOpen) {
      setAskIntent(null);
      setAskOpener(null);
    }
    setPanel(ASK_PANEL, true);
  }
  // A question's `질문하기`: a new conversation with it attached, on top. An AI 질문 panel open
  // under the modal layer is closed first (its unsent input is dropped; neither Back nor Forward
  // brings it back) and the new one opens on its own entry (ASK-SYNC (c)).
  function showLaunched({ conversation, opener }: AskLaunched) {
    askIntentKey.current += 1;
    setAskIntent({
      key: askIntentKey.current,
      text: '',
      scope: conversation ? normalizeScope(conversation.scope) : EMPTY_SCOPE,
      conversation,
      failure: conversation ? null : '문제를 첨부하지 못했습니다. 다시 시도하세요.',
    });
    setAskOpener(opener);
    const search = window.location.search;
    const target = `${pathname}${withAskConversation(withoutAsk(search), conversation?.id ?? null)}`;
    if (isOpen(ASK_PANEL)) {
      setAskSession((n) => n + 1);
      panelHistory.close(`${pathname}${withoutAsk(search)}`, target);
    } else {
      panelHistory.push(target);
    }
  }
  const askAvailable = ask.state?.available === true && !workspace.archived;
  const askLauncher = useGuardedAskLaunch(
    (attachment) => ask.client.create(workspace.id, { attachment }),
    showLaunched,
  );
  function navigateAsk(conversationId: string | null, how: 'push' | 'replace') {
    const target = `${pathname}${withAskConversation(window.location.search, conversationId)}`;
    if (how === 'push') panelHistory.push(target);
    else panelHistory.replace(target);
  }

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
  // Bumped when the heatmap's panel changes a question: an open 보관·초안 문제 list re-reads.
  const [questionsVersion, setQuestionsVersion] = useState(0);
  // Bumped when 챕터 재분배 moved questions: an open 정리 노트 panel reads its note again.
  const [notesVersion, setNotesVersion] = useState(0);
  // A move (or a move refused because questions changed) re-reads the heatmap and the notes. The
  // dialog's close replaces the URL, which can drop a refresh still in flight: it is redone then.
  const chaptersStale = useRef(false);
  // --- heatmap filters + client cache (QSEARCH-CACHE) --------------------------------------
  const ssrFiltersKey = overviewSearch(filters);
  const urlFiltersKey = overviewSearch(effectiveOverviewFilters(searchParams));
  const urlEffectiveFilters = useMemo(
    () => parseOverviewFilters(new URLSearchParams(urlFiltersKey.slice(1))),
    [urlFiltersKey],
  );

  const [cache, setCache] = useState(() =>
    seedOverviewCache(workspace.id, viewerId, filters, overview, failure, unfilteredOverview),
  );
  const [shown, setShown] = useState<{
    readonly overview: QuestionOverview;
    readonly filters: OverviewFilters;
    readonly filtersKey: string;
    readonly failure: QuestionFailureKind | null;
    readonly source: OverviewCache;
  }>(() => ({
    overview,
    filters,
    filtersKey: ssrFiltersKey,
    failure,
    source: cache,
  }));
  const [fetchingKey, setFetchingKey] = useState<string | null>(null);
  const [view, setView] = useState(filters);

  const [ssrSnapshot, setSsrSnapshot] = useState({
    workspaceId: workspace.id,
    viewerId,
    filtersKey: ssrFiltersKey,
    overview,
    unfilteredOverview,
    failure,
  });
  if (
    ssrSnapshot.workspaceId !== workspace.id ||
    ssrSnapshot.viewerId !== viewerId ||
    ssrSnapshot.filtersKey !== ssrFiltersKey ||
    ssrSnapshot.overview !== overview ||
    ssrSnapshot.unfilteredOverview !== unfilteredOverview ||
    ssrSnapshot.failure !== failure
  ) {
    setSsrSnapshot({
      workspaceId: workspace.id,
      viewerId,
      filtersKey: ssrFiltersKey,
      overview,
      unfilteredOverview,
      failure,
    });
    const freshCache = seedOverviewCache(
      workspace.id,
      viewerId,
      filters,
      overview,
      failure,
      unfilteredOverview,
    );
    setCache(freshCache);
    if (urlFiltersKey === ssrFiltersKey) {
      setView(filters);
      setFetchingKey(null);
      setShown({
        overview,
        filters,
        filtersKey: ssrFiltersKey,
        failure,
        source: freshCache,
      });
    } else {
      setView(urlEffectiveFilters);
      const hit = freshCache.get(urlEffectiveFilters);
      if (hit) {
        setFetchingKey(null);
        setShown({
          overview: hit,
          filters: urlEffectiveFilters,
          filtersKey: urlFiltersKey,
          failure: null,
          source: freshCache,
        });
      }
    }
  }

  const [seenUrlKey, setSeenUrlKey] = useState(urlFiltersKey);
  if (seenUrlKey !== urlFiltersKey) {
    setSeenUrlKey(urlFiltersKey);
    const alreadyHandled =
      fetchingKey === urlFiltersKey ||
      (shown.filtersKey === urlFiltersKey && shown.source === cache);
    if (!alreadyHandled) {
      setView(urlEffectiveFilters);
      const hit = cache.get(urlEffectiveFilters);
      if (hit) {
        setFetchingKey(null);
        setShown({
          overview: hit,
          filters: urlEffectiveFilters,
          filtersKey: urlFiltersKey,
          failure: null,
          source: cache,
        });
      }
    }
  }

  const cacheRef = useRef(cache);
  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  const mutationEpochRef = useRef(0);
  const invalidateOverviewCache = useCallback(() => {
    mutationEpochRef.current += 1;
    cacheRef.current.clear();
  }, []);

  const inFlightRef = useRef<{
    controller: AbortController;
    key: string;
    source: OverviewCache;
  } | null>(null);

  const abortInFlight = useCallback(() => {
    if (!inFlightRef.current) return;
    inFlightRef.current.controller.abort();
    inFlightRef.current = null;
  }, []);
  useEffect(() => abortInFlight, [abortInFlight]);

  const requestOverview = useCallback(
    (nextFilters: OverviewFilters, targetCache: OverviewCache = cacheRef.current) => {
      const nextKey = overviewSearch(nextFilters);
      const cached = targetCache.get(nextFilters);
      if (cached !== null) {
        abortInFlight();
        setFetchingKey(null);
        setShown({
          overview: cached,
          filters: nextFilters,
          filtersKey: nextKey,
          failure: null,
          source: targetCache,
        });
        return;
      }

      abortInFlight();
      const controller = new AbortController();
      const epochAtStart = mutationEpochRef.current;
      inFlightRef.current = { controller, key: nextKey, source: targetCache };
      setFetchingKey(nextKey);
      setShown((prev) => (prev.failure !== null ? { ...prev, failure: null } : prev));

      void fetchQuestionOverview(workspace.id, nextFilters, controller.signal).then((result) => {
        if (inFlightRef.current?.controller !== controller) return;
        inFlightRef.current = null;
        if (result.ok) {
          setFetchingKey(null);
          if (cacheRef.current === targetCache && mutationEpochRef.current === epochAtStart) {
            targetCache.put(nextFilters, result.data);
          }
          setShown({
            overview: result.data,
            filters: nextFilters,
            filtersKey: nextKey,
            failure: null,
            source: cacheRef.current,
          });
          return;
        }
        if (result.aborted) return;
        setFetchingKey(null);
        if (result.kind === 'unauthenticated') {
          router.replace(loginRedirectPath(`${pathname}${window.location.search}`));
          return;
        }
        setShown((prev) => ({
          ...prev,
          filters: nextFilters,
          filtersKey: nextKey,
          failure: result.kind,
          source: cacheRef.current,
        }));
      });
    },
    [abortInFlight, pathname, router, workspace.id],
  );

  useEffect(() => {
    if (inFlightRef.current && (fetchingKey === null || inFlightRef.current.source !== cache)) {
      abortInFlight();
    }
    if (shown.filtersKey === urlFiltersKey && shown.source === cache) return;
    if (inFlightRef.current?.key === urlFiltersKey && inFlightRef.current.source === cache) return;
    requestOverview(urlEffectiveFilters, cache);
  }, [
    abortInFlight,
    cache,
    fetchingKey,
    requestOverview,
    shown.filtersKey,
    shown.source,
    urlEffectiveFilters,
    urlFiltersKey,
  ]);

  const onChaptersChanged = () => {
    invalidateOverviewCache();
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
  // The published books: the AI 질문 panel's 질문 범위 choices and source titles (ASK-01).
  const searchDocuments = library.documents
    .filter(isSearchableBody)
    .map((d) => ({ id: d.id, title: d.title }));
  // Source titles of the 문제 상세 dialog (UX7-BANK-2).
  const documentTitles = library.documents.map((d) => ({ id: d.id, title: d.title }));

  /**
   * Writes `search` (new heatmap filters or the 문제 search) into the address bar at once via
   * `panelHistory.replace` (no extra history entry, no RSC page navigation), then serves the
   * Heatmap from `OverviewCache` (`0ms` on cache hit, e.g. clearing `q`) or fetches the BFF
   * overview endpoint with `AbortController` cancellation of superseded requests (QSEARCH-CACHE).
   */
  function applyHeatmapUrl(search: string) {
    const target = `${pathname}${search}`;
    panelHistory.replace(target);
    const nextFilters = effectiveOverviewFilters(new URLSearchParams(search));
    setView(nextFilters);
    requestOverview(nextFilters);
  }

  function retryOverview() {
    if (failure !== null && shown.filtersKey === ssrFiltersKey) {
      startNavigation(() => router.refresh());
      return;
    }
    requestOverview(urlEffectiveFilters, cache);
  }

  function changeFilters(patch: Partial<OverviewFilters>) {
    const next = { ...view, ...patch };
    setView(next);
    const search = window.location.search;
    applyHeatmapUrl(
      keepNoteChapter(search, mergeOverviewFilters(search, next), patch.chapter ?? null),
    );
  }

  // --- 문제 search (SEARCH-01-AC12: live, 350ms debounced, 0ms on clear; `q`) -------------------
  const questionSearch = useLiveQuery({
    urlValue: (searchParams.get('q') ?? '').trim().slice(0, OVERVIEW_SEARCH_MAX),
    max: OVERVIEW_SEARCH_MAX,
    onCommit: (q) => {
      // replaceState: typing never adds history entries.
      applyHeatmapUrl(patchSearch(window.location.search, { q: q || null }));
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
    applyHeatmapUrl(patchSearch(merged, { q: null }));
  }

  const chapterOptions = [
    { value: ALL, label: '전체 챕터' },
    ...chapterChoices.map((c) => ({ value: c.value, label: c.title })),
  ];

  const page = (
    <div className={styles.home}>
      <h1 className="qz-visually-hidden">{workspace.name}</h1>

      <div className={styles.header}>
        <div className={searchStyles.column}>
          <QuestionSearch
            screenId={screenIds.search}
            query={questionSearch}
            max={OVERVIEW_SEARCH_MAX}
            searchable={hasSearchableQuestions(
              hasQuestions === false && shown.overview.counts.total > 0 ? true : hasQuestions,
            )}
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
              onAsk={openAsk}
              askUnavailable={askUnavailable}
            />
          </div>
          <div className={styles.actionGroup} data-align="end">
            <Button onClick={openAsk}>
              <AskIcon width={16} height={16} />
              AI 질문
            </Button>
            {/* SEARCH-02: a link to the 본문 search page, styled as the icon buttons beside it. */}
            <Tooltip content="본문 검색">
              <Link
                href={searchPagePath(workspace.id)}
                aria-label="본문 검색"
                className="qz-icon-button qz-focus-ring"
                data-variant="secondary"
                data-size="md"
                onClick={(event) => {
                  if (isPlainClick(event)) markSearchEntryFromHome();
                }}
              >
                <span className="icon" aria-hidden="true">
                  <SearchIcon />
                </span>
              </Link>
            </Tooltip>
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

      {/* CHNOTE-02: while the modal note is open the Heatmap is inert (no focus, no hit-testing); a
          backdrop click closes the note only. The practice panels are portalled outside. */}
      <div className={styles.contents} inert={isOpen('chapter-note') || undefined}>
        <QuestionsOverview
          workspaceId={workspace.id}
          readOnly={readOnly}
          filters={shown.filters}
          view={view}
          navigating={navigating || fetchingKey !== null}
          onFiltersChange={changeFilters}
          onResetFilters={resetAll}
          overview={shown.overview}
          failure={shown.failure}
          onRetry={retryOverview}
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
          onQuestionsChanged={() => {
            invalidateOverviewCache();
            setQuestionsVersion((n) => n + 1);
          }}
          onStudyStateChanged={invalidateOverviewCache}
          chapterActions={(chapter) =>
            chapter.id === NO_CHAPTER_KEY ? (
              // HILITE-01: the "챕터 없음" group's explanation highlights (no AI note there).
              <Button
                size="sm"
                variant="ghost"
                aria-haspopup="dialog"
                onClick={() => openNote(NO_CHAPTER_NOTE)}
              >
                내 하이라이트
              </Button>
            ) : (
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
      </div>

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
                  onMerged={() => {
                    invalidateOverviewCache();
                    setQuestionsVersion((n) => n + 1);
                  }}
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
            workspaceId={workspace.id}
            documents={documentTitles}
            open={shows('chapter-note')}
            onOpenChange={(open) => (open ? undefined : closeNote())}
            container={host}
            chapterId={noteChapter ?? null}
            chapterTitle={
              shown.overview.chapters.find((c) => c.id === noteChapter)?.title ??
              chapterChoices.find((c) => c.value === noteChapter)?.title
            }
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
          <AskPanel
            key={askSession}
            open={shows(ASK_PANEL)}
            onOpenChange={(open) => setPanel(ASK_PANEL, open)}
            container={host}
            workspaceId={workspace.id}
            archived={workspace.archived}
            askState={ask.state}
            client={ask.client}
            conversationId={askConversation}
            onNavigate={navigateAsk}
            documents={searchDocuments}
            intent={askIntent}
            screenId={screenIds.ask}
            modal
            returnFocus={askOpener}
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
  return (
    <AskLauncherProvider launcher={askAvailable ? askLauncher : null}>{page}</AskLauncherProvider>
  );
}
