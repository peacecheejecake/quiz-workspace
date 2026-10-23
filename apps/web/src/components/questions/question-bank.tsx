'use client';

// QBANK-01 문제은행 (docs/screens/questions-bank.md): confirmed questions grouped by chapter
// ("챕터 없음" last), search + type/chapter/status filters in the URL behind a collapsible "검색·필터"
// toggle (collapsed by default, UX4), cursor pagination ("더 보기"), the empty state with
// direct-create and PDF-import actions (the header has neither while the bank is empty, UX4), the
// detail panel and the editor. "PDF 가져오기" opens the same "문제 PDF 관리" dialog as the home
// (QBANK-01-AC06).
// Viewers and archived workspaces get a read-only bank; the API enforces it regardless.
// QGEN-MULTI: editors check CONFIRMED questions (≤ 20) and "선택한 문제 변형 출제 (n)" opens the
// generation form over the page; "생성" starts one batch and goes to its results page.
import {
  Badge,
  Button,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  ConfirmDialog,
  EmptyState,
  Input,
  ModalDialog,
  PageHeader,
  Select,
  useToast,
} from '@quiz/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import { useDocumentLibrary } from '@/components/documents/use-document-library';
import {
  DocumentLibraryFeedback,
  QuestionPdfsDialog,
} from '@/components/questions/import/question-pdfs';
import { QuestionGenerationForm } from '@/components/questions/generate/question-generation-form';
import { useBatchStart } from '@/components/questions/generate/use-batch-start';
import { WorkspaceBackLink, WorkspaceBreadcrumb } from '@/components/workspaces/sub-page-nav';
import type { DocumentSummary } from '@/lib/documents/data';
import {
  deleteQuestionAction,
  listQuestionsAction,
  setQuestionStatusAction,
} from '@/lib/questions/actions';
import {
  CREATE_PARAM,
  DEFAULT_FILTERS,
  isFiltered,
  SEARCH_MAX,
  serializeBankFilters,
  type BankFilters,
  type StatusFilter,
} from '@/lib/questions/filters';
import {
  PUBLICATION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  type PublicationStatus,
  type Question,
  type QuestionType,
} from '@/lib/questions/form';
import type { GenerationCreate } from '@/lib/questions/generation-client';
import {
  batchCostProblem,
  MAX_BATCH_SOURCES,
  toggleSource,
} from '@/lib/questions/generation-model';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import type { ChapterOption, DocumentOption } from '@/lib/questions/server';
import { chapterLabel, documentTitle, NO_CHAPTER_TITLE, pageText, sourceHref } from './labels';
import { QuestionDetailPanel } from './question-detail';
import { QuestionEditor, type EditorTarget } from './question-editor';
import styles from './question-bank.module.css';

export type ReadOnlyReason = 'viewer' | 'archived' | null;

export interface QuestionBankProps {
  readonly workspaceId: string;
  /** Breadcrumb root; defaults to a generic label (unit tests). */
  readonly workspaceName?: string;
  readonly readOnly: ReadOnlyReason;
  readonly filters: BankFilters;
  readonly items: readonly Question[];
  readonly nextCursor: string | null;
  readonly failure: QuestionFailureKind | null;
  readonly chapters: readonly ChapterOption[];
  readonly documents: readonly DocumentOption[];
  /** `?create=1` (the home's 문제 › 직접 추가): open the 문제 등록 editor on arrival. */
  readonly openCreate?: boolean;
  /** The workspace's documents for the "문제 PDF 관리" dialog ("PDF 가져오기"). */
  readonly questionPdfs?: {
    readonly documents: readonly DocumentSummary[];
    readonly failed: boolean;
  };
}

const ALL = '__all__';
const NO_DOCUMENTS: readonly DocumentSummary[] = [];

const READ_ONLY_TEXT: Readonly<Record<Exclude<ReadOnlyReason, null>, string>> = {
  viewer: '읽기 전용: 보기 권한으로는 문제를 등록하거나 수정할 수 없습니다.',
  archived: '읽기 전용: 보관된 Workspace의 문제는 등록하거나 수정할 수 없습니다.',
};

const STATUS_FILTER_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'CONFIRMED', label: '확정 문제' },
  { value: 'DRAFT', label: '초안' },
  { value: 'ARCHIVED', label: '보관됨' },
  { value: 'ALL', label: '전체 상태' },
];

interface Group {
  readonly key: string;
  readonly title: string;
  readonly items: Question[];
}

/** Bank order is the API's; chapters keep their first appearance, "챕터 없음" goes last. */
export function groupByChapter(items: readonly Question[]): Group[] {
  const groups = new Map<string, Group>();
  let none: Group | null = null;
  for (const q of items) {
    if (!q.chapter_id) {
      none ??= { key: 'none', title: NO_CHAPTER_TITLE, items: [] };
      none.items.push(q);
      continue;
    }
    let group = groups.get(q.chapter_id);
    if (!group) {
      group = { key: q.chapter_id, title: q.chapter?.title ?? '챕터', items: [] };
      groups.set(q.chapter_id, group);
    }
    group.items.push(q);
  }
  return none ? [...groups.values(), none] : [...groups.values()];
}

/** Chapters seen in `items`, added to `known` (the filter keeps offering them under any filter). */
function withChapters(
  known: ReadonlyMap<string, string>,
  items: readonly Question[],
): ReadonlyMap<string, string> {
  const missing = items.filter((q) => q.chapter_id && !known.has(q.chapter_id));
  if (missing.length === 0) return known;
  const next = new Map(known);
  for (const q of missing) if (q.chapter_id) next.set(q.chapter_id, q.chapter?.title ?? '챕터');
  return next;
}

export function QuestionBank({
  workspaceId,
  workspaceName = 'Workspace',
  readOnly,
  filters,
  items: initialItems,
  nextCursor: initialCursor,
  failure,
  chapters,
  documents,
  openCreate = false,
  questionPdfs,
}: QuestionBankProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [navigating, startNavigation] = useTransition();
  const canEdit = readOnly === null;

  const [items, setItems] = useState<readonly Question[]>(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [knownChapters, setKnownChapters] = useState(() => withChapters(new Map(), initialItems));
  const [search, setSearch] = useState(filters.q);
  // A new server render (new filters, refresh after a save) restarts the list from its first
  // page. The screen itself stays mounted, so open popups and panels are not torn down.
  const filtersKey = serializeBankFilters(filters);
  const [rendered, setRendered] = useState({ items: initialItems, filtersKey, q: filters.q });
  // Filters as last chosen: several quick changes build on each other before the URL catches up.
  const [view, setView] = useState(filters);
  // List generation: bumped on every filter change and new server render. A "더 보기" response
  // for an older generation belongs to another list and is dropped.
  const [listGeneration, setListGeneration] = useState(0);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current = Math.max(generation.current, listGeneration);
  }, [listGeneration]);
  const [loadingMore, setLoadingMore] = useState(false);
  // QGEN-MULTI selection (question ids in selection order); a new list starts empty.
  const [selectedIds, setSelected] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchProblem, setBatchProblem] = useState<string | null>(null);
  const batch = useBatchStart(workspaceId, pathname);
  if (rendered.items !== initialItems || rendered.filtersKey !== filtersKey) {
    if (rendered.filtersKey !== filtersKey) setSelected([]);
    setListGeneration((g) => Math.max(g, generation.current) + 1);
    setRendered({ items: initialItems, filtersKey, q: filters.q });
    setItems(initialItems);
    setCursor(initialCursor);
    setLoadingMore(false);
    setKnownChapters((known) => withChapters(known, initialItems));
    if (rendered.filtersKey !== filtersKey) setView(filters);
    if (rendered.q !== filters.q) setSearch(filters.q);
  }

  const createOnArrival = openCreate && canEdit;
  const [editor, setEditor] = useState<{ target: EditorTarget | null; session: number }>(() =>
    createOnArrival ? { target: { mode: 'create' }, session: 1 } : { target: null, session: 0 },
  );
  // The request is one-shot: a reload or Back must not reopen the editor.
  useEffect(() => {
    if (!openCreate) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(CREATE_PARAM)) return;
    url.searchParams.delete(CREATE_PARAM);
    window.history.replaceState(window.history.state, '', url);
  }, [openCreate]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  // UX4: the search and filters are collapsed until asked for (like the home's status filter).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRegionId = useId();
  const [pdfsOpen, setPdfsOpen] = useState(false);
  const library = useDocumentLibrary({
    workspaceId,
    initialDocuments: questionPdfs?.documents ?? NO_DOCUMENTS,
    canEdit,
    loadFailed: questionPdfs?.failed ?? false,
  });

  const detail = items.find((q) => q.id === detailId) ?? null;
  // Only questions still listed and CONFIRMED stay selected: a deleted or archived question (or
  // one gone from a refreshed list) loses its checkbox, so it must not linger in the batch.
  const selected = useMemo(() => {
    const confirmed = new Set(
      items.filter((q) => q.publication_status === 'CONFIRMED').map((q) => q.id),
    );
    return selectedIds.filter((id) => confirmed.has(id));
  }, [items, selectedIds]);
  const selectionFull = selected.length >= MAX_BATCH_SOURCES;

  function generateBatch(body: GenerationCreate) {
    const cost = batchCostProblem(selected.length, body);
    setBatchProblem(cost);
    if (cost || selected.length === 0) return;
    void batch.start({ ...body, selection: { mode: 'selected', question_ids: selected } });
  }
  const groups = useMemo(() => groupByChapter(items), [items]);

  function navigate(patch: Partial<BankFilters>) {
    const next = { ...view, ...patch };
    generation.current += 1;
    setListGeneration(generation.current);
    setLoadingMore(false);
    setView(next);
    startNavigation(() => {
      router.replace(`${pathname}${serializeBankFilters(next)}`, { scroll: false });
    });
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ q: search.trim().slice(0, SEARCH_MAX) });
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const requested = generation.current;
    setLoadingMore(true);
    try {
      const result = await listQuestionsAction(workspaceId, filters, cursor);
      if (requested !== generation.current) return;
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setItems((prev) => {
        const seen = new Set(prev.map((q) => q.id));
        return [...prev, ...result.data.items.filter((q) => !seen.has(q.id))];
      });
      setKnownChapters((known) => withChapters(known, result.data.items));
      setCursor(result.data.nextCursor);
    } finally {
      if (requested === generation.current) setLoadingMore(false);
    }
  }

  function openEditor(target: EditorTarget) {
    setDetailId(null);
    setEditor((prev) => ({ target, session: prev.session + 1 }));
  }

  function replaceItem(question: Question) {
    setItems((prev) => prev.map((q) => (q.id === question.id ? question : q)));
  }

  async function changeStatus(question: Question, status: PublicationStatus) {
    const result = await setQuestionStatusAction(
      workspaceId,
      question.id,
      question.revision.id,
      status,
    );
    if (!result.ok) {
      toast({ tone: 'error', title: result.message });
      if (result.kind === 'staleRevision' || result.kind === 'notFound') router.refresh();
      return;
    }
    replaceItem(result.data);
    toast({
      tone: 'success',
      title:
        status === 'ARCHIVED'
          ? '문제를 보관했습니다.'
          : question.publication_status === 'DRAFT'
            ? '문제를 확정했습니다.'
            : '문제를 다시 확정했습니다.',
    });
  }

  async function runDelete() {
    const question = confirmDelete;
    if (!question) return;
    setDeleting(true);
    try {
      const result = await deleteQuestionAction(workspaceId, question.id);
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setItems((prev) => prev.filter((q) => q.id !== question.id));
      setDetailId(null);
      setConfirmDelete(null);
      toast({ tone: 'success', title: '문제를 삭제했습니다.' });
    } finally {
      setDeleting(false);
    }
  }

  const multiDocs = new Set(chapters.map((c) => c.documentId)).size > 1;
  const chapterFilterOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const c of chapters) options.set(c.id, chapterLabel(c, multiDocs));
    for (const [id, title] of knownChapters) if (!options.has(id)) options.set(id, title);
    if (view.chapter && !options.has(view.chapter)) options.set(view.chapter, '선택한 챕터');
    return [
      { value: ALL, label: '전체 챕터' },
      ...[...options].map(([value, label]) => ({ value, label })),
    ];
  }, [chapters, knownChapters, view.chapter, multiDocs]);

  const importButton = (
    <Button aria-haspopup="dialog" onClick={() => setPdfsOpen(true)}>
      PDF 가져오기
    </Button>
  );
  // An empty bank keeps its actions in the empty state only (UX4).
  const emptyBank = !failure && items.length === 0 && !isFiltered(filters);
  const filtered = isFiltered(view);

  return (
    <div className={styles.screen}>
      <PageHeader
        back={<WorkspaceBackLink workspaceId={workspaceId} />}
        breadcrumb={
          <WorkspaceBreadcrumb
            workspace={{ id: workspaceId, name: workspaceName }}
            trail={[{ label: '문제은행' }]}
          />
        }
        title="문제은행"
        description="확정된 문제를 챕터별로 관리합니다. 문제를 직접 등록하거나 PDF에서 가져올 수 있습니다."
        actions={
          canEdit && !emptyBank ? (
            <>
              {importButton}
              <Button
                variant="primary"
                aria-haspopup="dialog"
                onClick={() => openEditor({ mode: 'create' })}
              >
                문제 등록
              </Button>
            </>
          ) : null
        }
      />

      {readOnly ? <p className={styles.readOnly}>{READ_ONLY_TEXT[readOnly]}</p> : null}

      <div className={styles.filterBar}>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={filtersOpen}
          aria-controls={filtersRegionId}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          검색·필터
          {filtersOpen ? (
            <ChevronUpIcon width={16} height={16} aria-hidden="true" />
          ) : (
            <ChevronDownIcon width={16} height={16} aria-hidden="true" />
          )}
        </Button>
        <p className={styles.filterNote} role="status">
          {filtered && !filtersOpen ? '검색·필터 적용 중' : ''}
        </p>
      </div>

      <div
        id={filtersRegionId}
        role="group"
        aria-label="검색·필터"
        className={styles.filters}
        hidden={!filtersOpen}
      >
        <form role="search" className={styles.searchForm} onSubmit={onSearch}>
          <Input
            type="search"
            label="문제 검색"
            placeholder="문제 내용으로 검색"
            value={search}
            maxLength={SEARCH_MAX}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
          <Button type="submit">검색</Button>
        </form>
        <Select
          label="유형"
          options={[
            { value: ALL, label: '전체 유형' },
            ...QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] })),
          ]}
          value={view.type ?? ALL}
          onValueChange={(value) =>
            navigate({ type: value === ALL ? null : (value as QuestionType) })
          }
        />
        <Select
          label="챕터"
          options={chapterFilterOptions}
          value={view.chapter ?? ALL}
          onValueChange={(value) => navigate({ chapter: value === ALL ? null : value })}
        />
        <Select
          label="상태"
          options={STATUS_FILTER_OPTIONS}
          value={view.status}
          onValueChange={(value) => navigate({ status: value as StatusFilter })}
        />
      </div>

      {failure ? (
        <div role="alert" className={styles.loadError}>
          <p>문제 목록을 불러오지 못했습니다. {QUESTION_FAILURE_MESSAGES[failure]}</p>
          <Button onClick={() => startNavigation(() => router.refresh())}>다시 시도</Button>
        </div>
      ) : items.length === 0 ? (
        isFiltered(filters) ? (
          <EmptyState
            title="검색 결과가 없습니다"
            description="검색어나 필터를 바꿔 보세요."
            action={
              <Button
                onClick={() => {
                  setSearch('');
                  navigate(DEFAULT_FILTERS);
                }}
              >
                필터 초기화
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="등록된 문제가 없습니다"
            description={
              canEdit
                ? '문제를 직접 등록하거나 문제 PDF에서 가져와 문제은행을 채워 보세요.'
                : '아직 이 Workspace에 등록된 문제가 없습니다.'
            }
            action={
              canEdit ? (
                <div className={styles.formActions}>
                  <Button
                    variant="primary"
                    aria-haspopup="dialog"
                    onClick={() => openEditor({ mode: 'create' })}
                  >
                    문제 직접 등록
                  </Button>
                  {importButton}
                </div>
              ) : null
            }
          />
        )
      ) : (
        <div className={styles.groups} aria-busy={navigating || undefined}>
          <p className="qz-visually-hidden" role="status">
            {navigating ? '문제 목록을 불러오는 중입니다.' : `문제 ${items.length}개`}
          </p>
          {canEdit && selected.length > 0 ? (
            <div role="region" aria-label="선택한 문제" className={styles.selectionBar}>
              <p className={styles.selectionCount} role="status">
                {selected.length}개 선택됨
                {selectionFull ? ` · 최대 ${MAX_BATCH_SOURCES}개까지 고를 수 있습니다` : ''}
              </p>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                선택 해제
              </Button>
              <Button
                size="sm"
                variant="primary"
                aria-haspopup="dialog"
                onClick={() => {
                  setBatchProblem(null);
                  batch.clearError();
                  setBatchOpen(true);
                }}
              >
                선택한 문제 변형 출제 ({selected.length})
              </Button>
            </div>
          ) : null}
          {groups.map((group) => (
            <section
              key={group.key}
              className={styles.group}
              aria-labelledby={`qbank-group-${group.key}`}
            >
              <h2 id={`qbank-group-${group.key}`} className={styles.groupTitle}>
                {group.title}
                <span className={styles.groupCount}>{group.items.length}문제</span>
              </h2>
              <ul className={styles.list}>
                {group.items.map((question) => (
                  <QuestionItem
                    key={question.id}
                    workspaceId={workspaceId}
                    question={question}
                    documents={documents}
                    canEdit={canEdit}
                    selection={
                      canEdit
                        ? {
                            checked: selected.includes(question.id),
                            disabled: selectionFull && !selected.includes(question.id),
                            onChange: (on) => setSelected(toggleSource(selected, question.id, on)),
                          }
                        : null
                    }
                    onOpen={(trigger) => {
                      returnFocus.current = trigger;
                      setDetailId(question.id);
                    }}
                    onEdit={() => openEditor({ mode: 'edit', question })}
                  />
                ))}
              </ul>
            </section>
          ))}
          {cursor ? (
            <div className={styles.more}>
              <Button onClick={() => void loadMore()} loading={loadingMore}>
                더 보기
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <QuestionDetailPanel
        workspaceId={workspaceId}
        question={detail}
        onClose={() => setDetailId(null)}
        canEdit={canEdit}
        documents={documents}
        onEdit={(question) => openEditor({ mode: 'edit', question })}
        onStatus={(question, status) => void changeStatus(question, status)}
        onDelete={(question) => setConfirmDelete(question)}
      />

      {canEdit ? (
        <QuestionEditor
          workspaceId={workspaceId}
          target={editor.target}
          session={editor.session}
          onClose={() => setEditor((prev) => ({ ...prev, target: null }))}
          chapters={chapters}
          documents={documents}
          onSaved={(question, mode) => {
            // The server action revalidated the route, so the refreshed list arrives with its
            // response; until then an edit shows in place.
            if (mode === 'edit') replaceItem(question);
          }}
        />
      ) : null}

      {canEdit ? (
        <ModalDialog
          open={batchOpen}
          onOpenChange={(open) => {
            if (!batch.starting) setBatchOpen(open);
          }}
          title={`선택한 문제 변형 출제 (${selected.length})`}
          description="고른 문제마다 같은 설정으로 변형 초안을 만듭니다. 원본별로 검토해 승인한 초안만 문제은행에 등록됩니다."
        >
          <div className={styles.batchForm}>
            <QuestionGenerationForm
              source={{ questionType: 'MCQ', confirmed: true }}
              canGenerate
              canShuffle={false}
              allowShuffle={false}
              busy={batch.starting}
              onShuffle={() => undefined}
              onGenerate={generateBatch}
            />
            {(batchProblem ?? batch.error) ? (
              <p role="alert" className={styles.loadError}>
                {batchProblem ?? batch.error}
              </p>
            ) : null}
          </div>
        </ModalDialog>
      ) : null}

      <QuestionPdfsDialog
        open={pdfsOpen}
        onOpenChange={setPdfsOpen}
        workspaceId={workspaceId}
        library={library}
        canEdit={canEdit}
      />
      <DocumentLibraryFeedback library={library} />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title="문제를 삭제할까요?"
        description="문제은행과 Heatmap에서 사라집니다. 지난 풀이 기록은 이력으로 남습니다."
        confirmLabel="삭제"
        onConfirm={() => void runDelete()}
        loading={deleting}
        returnFocusRef={returnFocus}
      />
    </div>
  );
}

function QuestionItem({
  workspaceId,
  question,
  documents,
  canEdit,
  selection,
  onOpen,
  onEdit,
}: {
  workspaceId: string;
  question: Question;
  documents: readonly DocumentOption[];
  canEdit: boolean;
  /** QGEN-MULTI batch selection (editors only; null = no selection column). */
  selection: {
    checked: boolean;
    disabled: boolean;
    onChange: (on: boolean) => void;
  } | null;
  onOpen: (trigger: HTMLElement) => void;
  onEdit: () => void;
}) {
  const rev = question.revision;
  const answer =
    question.question_type === 'MCQ'
      ? `보기 ${rev.options.length}개${rev.is_multi_answer ? ' · 복수 정답' : ''}`
      : question.question_type === 'SHORT_ANSWER'
        ? rev.accepted_answers?.length
          ? `허용 답안 ${rev.accepted_answers.length}개`
          : '직접 채점'
        : '서술형 채점';
  return (
    <li
      className={styles.item}
      data-status={question.publication_status}
      data-selectable={selection ? 'true' : undefined}
    >
      {selection ? (
        <div className={styles.itemSelect}>
          {question.publication_status === 'CONFIRMED' ? (
            <Checkbox
              checked={selection.checked}
              disabled={selection.disabled}
              onCheckedChange={(on) => selection.onChange(on === true)}
              label={<span className="qz-visually-hidden">{selectLabel(question)}</span>}
            />
          ) : null}
        </div>
      ) : null}
      <div className={styles.itemMain}>
        <div className={styles.itemMeta}>
          {question.question_number ? <span>{question.question_number}번</span> : null}
          <Badge>{QUESTION_TYPE_LABELS[question.question_type]}</Badge>
          {question.publication_status !== 'CONFIRMED' ? (
            <Badge tone="warning">{PUBLICATION_STATUS_LABELS[question.publication_status]}</Badge>
          ) : null}
          <span>{answer}</span>
          {rev.version > 1 ? <span>버전 {rev.version}</span> : null}
        </div>
        <button
          type="button"
          className={styles.stemButton}
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          {rev.stem}
        </button>
        {question.sources.length > 0 ? (
          <div className={styles.sources}>
            <span className="qz-visually-hidden">출처:</span>
            {question.sources.map((source, i) => {
              const href = sourceHref(workspaceId, source);
              const text =
                `${documentTitle(documents, source.document_id)} ${pageText(source) ?? ''}`.trim();
              return href ? (
                <Link key={i} href={href} className={styles.sourceLink}>
                  {text}
                </Link>
              ) : (
                <span key={i}>{text}</span>
              );
            })}
          </div>
        ) : null}
      </div>
      {canEdit ? (
        <div className={styles.itemActions}>
          <Button size="sm" onClick={onEdit} aria-haspopup="dialog">
            편집
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Accessible name of a question's batch selection checkbox. */
export function selectLabel(question: Question): string {
  if (question.question_number) return `${question.question_number}번 문제 선택`;
  const stem = question.revision.stem.replace(/\s+/g, ' ').trim();
  return `"${stem.length > 30 ? `${stem.slice(0, 30)}…` : stem}" 문제 선택`;
}
