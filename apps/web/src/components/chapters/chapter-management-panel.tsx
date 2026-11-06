'use client';

// CHMAN-01 챕터 관리 (docs/screens/chapter-management.md): the modal panel over the home, editors of
// an active workspace only. Each book's chapter tree with 챕터 추가, a row menu (이름 바꾸기, 하위 챕터
// 추가, 위로, 아래로, 들여쓰기, 내어쓰기, 삭제) and pointer drags: a row onto a row makes it its last
// child, a question onto a row moves it through `chapter-assignments`. Edits apply at once (D-9), so
// nothing here is unsaved. The grips are pointer-only and hidden from assistive technology: the
// row menu and the question's `챕터로 옮기기` are the keyboard, touch and screen reader path
// (WCAG 2.5.7). After every write the tree is read again and the home is told.
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  Badge,
  Button,
  ChapterPicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FloatingSidePanel,
  GripIcon,
  IconButton,
  Input,
  MoreIcon,
  Skeleton,
} from '@quiz/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  canAddChild,
  CHAPTER_FAILURE_MESSAGES,
  createChapterApi,
  depthOf,
  documentOf,
  dropMove,
  NO_CHAPTER_TARGET,
  rowMove,
  treePickerNodes,
  type ChapterApi,
  type ChapterMove,
  type ChapterResult,
  type ChapterTree,
  type RowAction,
  type TreeChapter,
  type TreeDocument,
} from '@/lib/chapters/tree';
import {
  createRedistributionApi,
  NO_CHAPTER_TITLE,
  NO_TARGET_CHAPTER,
  REDIST_FAILURE_MESSAGES,
  targetChapterId,
  type RedistributionApi,
  type RedistributionList,
  type RedistributionQuestion,
} from '@/lib/questions/redistribution';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';
import styles from './chapter-management.module.css';

export interface ChapterManagementPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly container: HTMLElement | null;
  readonly workspaceId: string;
  /** Something moved: the home re-reads the heatmap, its filters and any open note. */
  readonly onChanged: () => void;
  readonly screenId?: string | undefined;
}

export function ChapterManagementPanel({
  open,
  onOpenChange,
  container,
  workspaceId,
  onChanged,
  screenId,
}: ChapterManagementPanelProps) {
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={onOpenChange}
      container={container}
      title="챕터 관리"
      closeLabel="챕터 관리 닫기"
      size="wide"
      mobileLayout="full"
    >
      <div data-screen-id={screenId}>
        {open ? <Content workspaceId={workspaceId} onChanged={onChanged} /> : null}
      </div>
    </FloatingSidePanel>
  );
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly tree: ChapterTree };

interface Notice {
  readonly tone: 'status' | 'alert';
  readonly text: string;
}

type TitleForm =
  | { readonly kind: 'create'; readonly documentId: string; readonly parentId: string | null }
  | { readonly kind: 'rename'; readonly chapter: TreeChapter };

const QUESTION_PAGE = 200;
const DROP_REFUSED = CHAPTER_FAILURE_MESSAGES.invalid;
const CHAPTER_DRAG = 'chapter:';
const QUESTION_DRAG = 'question:';
const DRAG_SENSOR = { activationConstraint: { distance: 4 } };
const TARGET_LEADING = [{ value: NO_TARGET_CHAPTER, label: NO_CHAPTER_TITLE }];
const DELETE_LEADING = [{ value: NO_CHAPTER_TARGET, label: NO_CHAPTER_TITLE }];

// The grips are hidden from assistive technology, so a drag has nothing to announce.
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};
const NO_INSTRUCTIONS = { draggable: '' };

const subscribeNever = () => () => undefined;
const documentBody = () => document.body;
const noBody = () => null;

function Content({
  workspaceId,
  onChanged,
}: {
  readonly workspaceId: string;
  readonly onChanged: () => void;
}) {
  const api: ChapterApi = useMemo(() => createChapterApi(workspaceId), [workspaceId]);
  const assignApi: RedistributionApi = useMemo(
    () => createRedistributionApi(workspaceId),
    [workspaceId],
  );
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [questions, setQuestions] = useState<RedistributionList | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState<TitleForm | null>(null);
  const [removing, setRemoving] = useState<TreeChapter | null>(null);
  // The server asked for a destination the loaded counts did not show (a question arrived since).
  const [targetRequired, setTargetRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const contextId = useId();
  const sensors = useSensors(useSensor(PointerSensor, DRAG_SENSOR));
  // Dialogs have a transform, which would offset a fixed overlay rendered inside them.
  const portalTarget = useSyncExternalStore(subscribeNever, documentBody, noBody);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const [tree, list] = await Promise.all([api.tree(signal), assignApi.list(signal)]);
      return { tree, list };
    },
    [api, assignApi],
  );
  const show = useCallback((read: Awaited<ReturnType<typeof reload>>) => {
    setLoad(read.tree.ok ? { status: 'ready', tree: read.tree.data } : { status: 'error' });
    setQuestions(read.list.ok ? read.list.data : null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal)
      .then((read) => {
        if (!controller.signal.aborted) show(read);
      })
      .catch(() => {
        // Aborted by closing the panel: nothing to show.
      });
    return () => controller.abort();
  }, [reload, show]);

  const tree = load.status === 'ready' ? load.tree : null;

  /** One write at a time; the tree is read again after it, whatever the answer was. */
  async function write<T>(
    run: (key: string) => Promise<ChapterResult<T>>,
    done: string,
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const result = await run(newIdempotencyKey());
    if (result.ok) {
      setNotice({ tone: 'status', text: done });
      onChanged();
    } else {
      setNotice({ tone: 'alert', text: CHAPTER_FAILURE_MESSAGES[result.kind] });
    }
    show(await reload());
    busyRef.current = false;
    setBusy(false);
    return result.ok;
  }

  function move(document: TreeDocument, chapterMove: ChapterMove, title: string) {
    void write(
      (key) => api.move(document.document_id, document.version, [chapterMove], key),
      `${title}을 옮겼습니다.`,
    );
  }

  function onRowAction(document: TreeDocument, chapter: TreeChapter, action: RowAction) {
    const chapterMove = rowMove(document.chapters, chapter.id, action);
    if (chapterMove) move(document, chapterMove, chapter.title);
  }

  async function assign(question: RedistributionQuestion, target: string | null) {
    if (target === question.chapter_id || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const result = await assignApi.assign(
      'manual',
      [
        {
          question_id: question.question_id,
          chapter_id: target,
          expected_chapter_id: question.chapter_id,
        },
      ],
      newIdempotencyKey(),
    );
    if (result.ok) {
      setNotice({ tone: 'status', text: `${question.label}을 옮겼습니다.` });
      onChanged();
    } else {
      setNotice({ tone: 'alert', text: REDIST_FAILURE_MESSAGES[result.kind] });
    }
    show(await reload());
    busyRef.current = false;
    setBusy(false);
  }

  function onDragStart({ active }: DragStartEvent) {
    const id = String(active.id);
    if (id.startsWith(CHAPTER_DRAG)) {
      const chapterId = id.slice(CHAPTER_DRAG.length);
      const chapters = tree?.documents.flatMap((d) => d.chapters) ?? [];
      setDragLabel(chapters.find((c) => c.id === chapterId)?.title ?? null);
    } else {
      const questionId = id.slice(QUESTION_DRAG.length);
      setDragLabel(questions?.items.find((q) => q.question_id === questionId)?.label ?? null);
    }
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragLabel(null);
    if (!over || !tree) return;
    const dragged = String(active.id);
    const target = String(over.id);
    if (dragged.startsWith(QUESTION_DRAG)) {
      const questionId = dragged.slice(QUESTION_DRAG.length);
      const question = questions?.items.find((q) => q.question_id === questionId);
      if (question) void assign(question, target);
      return;
    }
    const chapterId = dragged.slice(CHAPTER_DRAG.length);
    if (chapterId === target) return;
    const document = documentOf(tree, chapterId);
    if (!document) return;
    const chapter = document.chapters.find((c) => c.id === chapterId);
    const inDocument = document.chapters.some((c) => c.id === target);
    const chapterMove = inDocument ? dropMove(document.chapters, chapterId, target) : null;
    if (chapterMove && chapter) move(document, chapterMove, chapter.title);
    else setNotice({ tone: 'alert', text: DROP_REFUSED });
  }

  if (load.status === 'loading') {
    return (
      <div className={styles.loading}>
        <p className={styles.muted}>챕터를 불러오는 중입니다.</p>
        <Skeleton height={40} />
        <Skeleton height={40} />
      </div>
    );
  }
  if (load.status === 'error' || !tree) {
    return (
      <div role="alert" className={styles.failure}>
        <p>챕터를 불러오지 못했습니다.</p>
        <Button
          onClick={() => {
            setLoad({ status: 'loading' });
            void reload().then(show);
          }}
        >
          다시 시도
        </Button>
      </div>
    );
  }
  if (tree.documents.length === 0) {
    return <EmptyState title="챕터를 관리할 교재가 없습니다. 교재 PDF를 먼저 올려 주세요." />;
  }

  const pickerNodes = treePickerNodes(tree);
  // The row as last read: its counts change, and it may be gone.
  const current = removing
    ? tree.documents.flatMap((d) => d.chapters).find((c) => c.id === removing.id)
    : undefined;
  return (
    <div className={styles.body} aria-busy={busy || undefined}>
      <p role="status" className={styles.notice}>
        {notice?.tone === 'status' ? notice.text : null}
      </p>
      {notice?.tone === 'alert' ? (
        <p role="alert" className={styles.alertText}>
          {notice.text}
        </p>
      ) : null}

      {current ? (
        <DeleteConfirm
          key={current.id}
          chapter={current}
          tree={tree}
          busy={busy}
          targetRequired={targetRequired}
          onCancel={() => setRemoving(null)}
          onConfirm={(target) => {
            void write(async (key) => {
              const result = await api.remove(current.id, target, key);
              if (!result.ok && result.kind === 'targetRequired') setTargetRequired(true);
              return result;
            }, `${current.title}을 삭제했습니다.`).then((done) => {
              if (done) setRemoving(null);
            });
          }}
        />
      ) : null}

      <DndContext
        id={contextId}
        sensors={sensors}
        collisionDetection={pointerWithin}
        accessibility={{
          announcements: SILENT,
          screenReaderInstructions: NO_INSTRUCTIONS,
          // Outside the dialog: a live region inside would keep the dialog itself in the
          // accessibility tree while another modal covers it (HOMEDLG-01-AC02).
          container: portalTarget ?? undefined,
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragLabel(null)}
      >
        <div className={styles.columns}>
          <div className={styles.trees}>
            {tree.documents.map((document) => (
              <section key={document.document_id} className={styles.book}>
                <div className={styles.bookHead}>
                  <h3 className={styles.bookTitle}>{document.title}</h3>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setForm({
                        kind: 'create',
                        documentId: document.document_id,
                        parentId: null,
                      })
                    }
                  >
                    챕터 추가
                  </Button>
                </div>
                {form?.kind === 'create' &&
                form.documentId === document.document_id &&
                form.parentId === null ? (
                  <TitleInput
                    busy={busy}
                    initial=""
                    submitLabel="추가"
                    onCancel={() => setForm(null)}
                    onSubmit={(title) => {
                      void write(
                        (key) => api.create(document.document_id, null, title, key),
                        `${title}을 추가했습니다.`,
                      ).then((done) => {
                        if (done) setForm(null);
                      });
                    }}
                  />
                ) : null}
                {document.chapters.length === 0 ? (
                  <p className={styles.muted}>챕터가 없습니다.</p>
                ) : (
                  <ul className={styles.tree} aria-label={`${document.title} 챕터`}>
                    {document.chapters.map((chapter) => (
                      <ChapterRow
                        key={chapter.id}
                        chapter={chapter}
                        documentId={document.document_id}
                        depth={depthOf(document.chapters, chapter.id)}
                        chapters={document.chapters}
                        busy={busy}
                        form={form}
                        onForm={setForm}
                        onAction={(action) => onRowAction(document, chapter, action)}
                        onDelete={() => {
                          setTargetRequired(false);
                          setRemoving(chapter);
                        }}
                        onRename={(title) => {
                          void write(
                            (key) => api.rename(chapter.id, title, key),
                            `${title}으로 바꿨습니다.`,
                          ).then((done) => {
                            if (done) setForm(null);
                          });
                        }}
                        onCreateChild={(title) => {
                          void write(
                            (key) => api.create(document.document_id, chapter.id, title, key),
                            `${title}을 추가했습니다.`,
                          ).then((done) => {
                            if (done) setForm(null);
                          });
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <QuestionList
            questions={questions}
            nodes={pickerNodes}
            busy={busy}
            onAssign={(question, target) => void assign(question, target)}
          />
        </div>
        {portalTarget
          ? createPortal(
              <DragOverlay dropAnimation={null}>
                {dragLabel !== null ? (
                  <div className={styles.dragPreview} aria-hidden>
                    <GripIcon width={20} height={20} />
                    <span>{dragLabel}</span>
                  </div>
                ) : null}
              </DragOverlay>,
              portalTarget,
            )
          : null}
      </DndContext>
    </div>
  );
}

function TitleInput({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly initial: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = title.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed !== '' && !busy) onSubmit(trimmed);
  }
  return (
    <form className={styles.titleForm} onSubmit={submit}>
      <Input
        ref={inputRef}
        label="챕터 이름"
        value={title}
        maxLength={1000}
        fieldClassName={styles.titleField}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button type="submit" variant="primary" disabled={trimmed === '' || busy}>
        {submitLabel}
      </Button>
      <Button onClick={onCancel}>취소</Button>
    </form>
  );
}

function ChapterRow({
  chapter,
  documentId,
  depth,
  chapters,
  busy,
  form,
  onForm,
  onAction,
  onDelete,
  onRename,
  onCreateChild,
}: {
  readonly chapter: TreeChapter;
  readonly documentId: string;
  readonly depth: number;
  readonly chapters: readonly TreeChapter[];
  readonly busy: boolean;
  readonly form: TitleForm | null;
  readonly onForm: (form: TitleForm | null) => void;
  readonly onAction: (action: RowAction) => void;
  readonly onDelete: () => void;
  readonly onRename: (title: string) => void;
  readonly onCreateChild: (title: string) => void;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${CHAPTER_DRAG}${chapter.id}`,
    disabled: busy,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: chapter.id });
  const renaming = form?.kind === 'rename' && form.chapter.id === chapter.id;
  const addingChild = form?.kind === 'create' && form.parentId === chapter.id;
  const indent = { '--chapter-depth': depth - 1 } as CSSProperties;
  return (
    <li
      ref={setDropRef}
      className={styles.rowItem}
      style={indent}
      data-chapter-row={chapter.id}
      data-drop-target={isOver || undefined}
    >
      {renaming ? (
        <TitleInput
          busy={busy}
          initial={chapter.title}
          submitLabel="저장"
          onCancel={() => onForm(null)}
          onSubmit={onRename}
        />
      ) : (
        <div className={styles.row} data-dragging={isDragging || undefined}>
          <span
            ref={setNodeRef}
            className={styles.grip}
            data-chapter-grip=""
            aria-hidden
            {...listeners}
          >
            <GripIcon width={20} height={20} />
          </span>
          <span className={styles.rowTitle}>{chapter.title}</span>
          {chapter.has_note ? <Badge>노트</Badge> : null}
          <span className={styles.count} aria-label={`${chapter.question_count}문제`}>
            {chapter.question_count}
          </span>
          <RowMenu
            chapter={chapter}
            chapters={chapters}
            busy={busy}
            onRename={() => onForm({ kind: 'rename', chapter })}
            onAddChild={() => onForm({ kind: 'create', documentId, parentId: chapter.id })}
            onAction={onAction}
            onDelete={onDelete}
          />
        </div>
      )}
      {addingChild ? (
        <TitleInput
          busy={busy}
          initial=""
          submitLabel="추가"
          onCancel={() => onForm(null)}
          onSubmit={onCreateChild}
        />
      ) : null}
    </li>
  );
}

const ROW_ACTIONS: readonly { readonly action: RowAction; readonly label: string }[] = [
  { action: 'up', label: '위로' },
  { action: 'down', label: '아래로' },
  { action: 'indent', label: '들여쓰기' },
  { action: 'outdent', label: '내어쓰기' },
];

function RowMenu({
  chapter,
  chapters,
  busy,
  onRename,
  onAddChild,
  onAction,
  onDelete,
}: {
  readonly chapter: TreeChapter;
  readonly chapters: readonly TreeChapter[];
  readonly busy: boolean;
  readonly onRename: () => void;
  readonly onAddChild: () => void;
  readonly onAction: (action: RowAction) => void;
  readonly onDelete: () => void;
}) {
  const label = `${chapter.title} 챕터 메뉴`;
  // An item runs after the menu has handed focus back, so a form can take the focus from it.
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton className={styles.rowMenu} label={label} icon={<MoreIcon />} disabled={busy} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        <DropdownMenuItem onSelect={afterClose(onRename)}>이름 바꾸기</DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canAddChild(chapters, chapter.id)}
          onSelect={afterClose(onAddChild)}
        >
          하위 챕터 추가
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {ROW_ACTIONS.map(({ action, label: name }) => (
          <DropdownMenuItem
            key={action}
            disabled={rowMove(chapters, chapter.id, action) === null}
            onSelect={afterClose(() => onAction(action))}
          >
            {name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onSelect={afterClose(onDelete)}>
          삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteConfirm({
  chapter,
  tree,
  busy,
  targetRequired,
  onCancel,
  onConfirm,
}: {
  readonly chapter: TreeChapter;
  readonly tree: ChapterTree;
  readonly busy: boolean;
  readonly targetRequired: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (target: string | null) => void;
}) {
  const [target, setTarget] = useState('');
  const reasonId = useId();
  const titleId = useId();
  const attached = chapter.attached_question_count;
  const needsTarget = attached > 0 || targetRequired;
  const nodes = useMemo(() => treePickerNodes(tree, chapter.id), [tree, chapter.id]);
  const blocked = needsTarget && target === '';
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  return (
    <section ref={rootRef} tabIndex={-1} className={styles.confirm} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.confirmTitle}>
        {`${chapter.title}을 삭제할까요?`}
      </h3>
      <p className={styles.muted}>
        하위 챕터와 본문은 상위 챕터로 옮겨집니다. 문제 내용과 풀이 기록은 바뀌지 않습니다.
      </p>
      {chapter.has_note ? (
        <p className={styles.warning}>이 챕터의 정리 노트는 더 이상 보이지 않습니다.</p>
      ) : null}
      {needsTarget ? (
        <ChapterPicker
          label="문제를 옮길 챕터"
          placeholder="챕터 고르기"
          leading={DELETE_LEADING}
          nodes={nodes}
          value={target}
          onValueChange={setTarget}
        />
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={blocked || busy}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => onConfirm(target === '' ? null : target)}
        >
          삭제
        </Button>
        <Button onClick={onCancel}>취소</Button>
      </div>
      {blocked ? (
        <p id={reasonId} className={styles.muted}>
          {attached > 0
            ? `초안·보관 문제를 포함한 이 챕터의 문제 ${attached}개를 옮길 챕터를 고르세요`
            : '이 챕터의 문제를 옮길 챕터를 고르세요'}
        </p>
      ) : null}
    </section>
  );
}

function QuestionList({
  questions,
  nodes,
  busy,
  onAssign,
}: {
  readonly questions: RedistributionList | null;
  readonly nodes: ReturnType<typeof treePickerNodes>;
  readonly busy: boolean;
  readonly onAssign: (question: RedistributionQuestion, target: string | null) => void;
}) {
  const [shown, setShown] = useState(QUESTION_PAGE);
  if (!questions) return null;
  const items = questions.items.slice(0, shown);
  return (
    <section className={styles.questions}>
      <h3 className={styles.bookTitle}>문제</h3>
      {items.length === 0 ? <p className={styles.muted}>옮길 확정 문제가 없습니다</p> : null}
      <ul className={styles.tree} aria-label="문제">
        {items.map((question) => (
          <QuestionRow
            key={question.question_id}
            question={question}
            nodes={nodes}
            busy={busy}
            onAssign={onAssign}
          />
        ))}
      </ul>
      {questions.items.length > shown ? (
        <Button onClick={() => setShown((n) => n + QUESTION_PAGE)}>더 보기</Button>
      ) : null}
    </section>
  );
}

function QuestionRow({
  question,
  nodes,
  busy,
  onAssign,
}: {
  readonly question: RedistributionQuestion;
  readonly nodes: ReturnType<typeof treePickerNodes>;
  readonly busy: boolean;
  readonly onAssign: (question: RedistributionQuestion, target: string | null) => void;
}) {
  const { setNodeRef, listeners } = useDraggable({
    id: `${QUESTION_DRAG}${question.question_id}`,
    disabled: busy,
  });
  return (
    <li className={styles.questionRow} data-question-row={question.question_id}>
      <span
        ref={setNodeRef}
        className={styles.grip}
        data-question-grip=""
        aria-hidden
        {...listeners}
      >
        <GripIcon width={20} height={20} />
      </span>
      <span className={styles.rowTitle}>
        {question.label} · {question.stem_preview}
      </span>
      <ChapterPicker
        label={`${question.label} 챕터로 옮기기`}
        hideLabel
        fieldClassName={styles.questionPicker}
        leading={TARGET_LEADING}
        nodes={nodes}
        value={question.chapter_id ?? NO_TARGET_CHAPTER}
        disabled={busy}
        onValueChange={(value) => onAssign(question, targetChapterId(value))}
      />
    </li>
  );
}
