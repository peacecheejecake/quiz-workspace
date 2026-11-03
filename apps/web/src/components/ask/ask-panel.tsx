'use client';

// ASK-01 AI 질문 panel (docs/screens/ask-llm.md): the shared non-modal FloatingSidePanel of the
// workspace home, `?panel=ask` (the conversation list, or a new conversation) and
// `?panel=ask&conversation=<id>` (one conversation). It opens at once and loads behind a skeleton
// (QOV-01-AC09).
//
//   body    toolbar (`대화 목록` · `새 대화` · `질문 범위`) and "범위: …"; the list (rows with a
//           `삭제` menu → ConfirmDialog) or the conversation log (role=log "대화": "내 질문" and
//           "AI 답변" articles, ask-answer.tsx)
//   footer  the attachment chip (display only here; the question-side buttons are ASK-Q), the
//           question input (Enter sends, Shift+Enter breaks the line, never while an IME composes),
//           the counter from 80% of the limit, the reason when new questions are off, `보내기` /
//           `답변 중지`, and the one visually hidden live region (answer started / finished, copied)
//
// Streaming: the answer being made is read from the same-origin SSE relay (fetch streaming, the
// relay adds the token); a broken stream resumes with Last-Event-ID, then falls back to polling
// GET /ask/messages/{id} every second. `done` replaces the streamed text with the validated answer.
// FastAPI owns every rule (who may read or ask, limits, disclosure); the panel shows its answers.
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FloatingSidePanel,
  IconButton,
  CloseIcon,
  MoreIcon,
  Skeleton,
  Textarea,
} from '@quiz/ui';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { DocumentExcerptPanel } from '@/components/search/document-excerpt-panel';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  AskApiError,
  normalizeScope,
  readAnswerStream,
  type AskClient,
  type AskMessage,
  type AskScope,
  type AskSource,
  type AskState,
  type Conversation,
  type ConversationSummary,
  type MessageAccepted,
} from '@/lib/ask/client';
import {
  ASK_TEXT,
  askFailureText,
  conversationTime,
  conversationTurns,
  copyText,
  counterText,
  disclosureText,
  EMPTY_SCOPE,
  isEmptyScope,
  isTerminal,
  liveDoneText,
  regenerateLimitText,
  runningAnswer,
  sameScope,
  scopeText,
  turnLimitText,
  unavailableReason,
  unavailableText,
} from '@/lib/ask/model';
import { createSearchClient, type OutlineItem, type SearchItem } from '@/lib/search/client';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';
import { AskAnswer } from './ask-answer';
import { SendIcon } from './ask-icons';
import { AskScopePopover, type ScopeDocument } from './ask-scope';
import styles from './ask.module.css';

/** What `AI에게 묻기` hands the panel: a new conversation with this text and scope (not sent). */
export interface AskIntent {
  readonly key: number;
  readonly text: string;
  readonly scope: AskScope;
}

export interface AskPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly raiseKey?: number;
  readonly container: HTMLElement | null;
  readonly workspaceId: string;
  readonly archived: boolean;
  readonly askState: AskState | null;
  readonly client: AskClient;
  /** The URL's conversation (null: the list or a new conversation). */
  readonly conversationId: string | null;
  /** Shows another conversation (null: the list / a new one) — push or replace the entry. */
  readonly onNavigate: (conversationId: string | null, how: 'push' | 'replace') => void;
  /** The workspace's published books (the 질문 범위 choices and source titles). */
  readonly documents: readonly ScopeDocument[];
  readonly intent: AskIntent | null;
  readonly screenId?: string;
}

type ViewMode = 'list' | 'new';
type Load = 'loading' | 'ready' | 'notFound' | 'error';

/** The excerpt panel's hit, built from a pinned source and its blocks of the pinned revision. */
function sourceItem(message: AskMessage, source: AskSource, text: string): SearchItem {
  return {
    document_id: source.document_id,
    document_title: source.document_title,
    document_type: source.document_type,
    revision_id: source.revision_id,
    chunk_id: `ask:${message.id}:${source.number}`,
    chapter_id: source.chapter_id,
    section_id: null,
    breadcrumb: [source.document_title, ...(source.chapter_title ? [source.chapter_title] : [])],
    block_id: source.block_ids[0] ?? '',
    block_ids: source.block_ids,
    context_block_ids: source.block_ids,
    page: source.page_from,
    bbox: null,
    locations: [],
    text,
    highlights: [],
    term_highlights: [],
    truncated_start: false,
    truncated_end: false,
    language: null,
    rank: source.number,
    score: 0,
    score_type: 'rerank',
  };
}

function mergeMessages(list: readonly AskMessage[], next: readonly AskMessage[]): AskMessage[] {
  const out = [...list];
  for (const message of next) {
    const at = out.findIndex((m) => m.id === message.id);
    if (at === -1) out.push(message);
    else out[at] = message;
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    });
  });

export function AskPanel(props: AskPanelProps) {
  const { open, onOpenChange, raiseKey, container, screenId } = props;
  const body = useAskPanel(props);
  return (
    <>
      <FloatingSidePanel
        open={open}
        onOpenChange={onOpenChange}
        raiseKey={raiseKey}
        modal={false}
        container={container}
        title={ASK_TEXT.title}
        description={body.subtitle ?? undefined}
        closeLabel="AI 질문 닫기"
        mobileLayout="full"
        footer={body.footer}
      >
        <div data-screen-id={screenId} className={styles.body}>
          {body.content}
        </div>
      </FloatingSidePanel>
      {body.overlays}
    </>
  );
}

function useAskPanel({
  open,
  workspaceId,
  archived,
  askState,
  client,
  conversationId,
  onNavigate,
  documents,
  intent,
}: AskPanelProps) {
  const router = useRouter();
  const search = useMemo(() => createSearchClient(), []);
  const reason = unavailableReason(askState, archived);
  const limits = askState?.limits ?? {
    max_question_chars: 1000,
    max_turns: 20,
    max_regenerations: 5,
  };

  // --- view ----------------------------------------------------------------------------------
  const [mode, setMode] = useState<ViewMode>(intent ? 'new' : 'list');
  const [draft, setDraft] = useState(intent?.text ?? '');
  const [scope, setScope] = useState<AskScope>(intent?.scope ?? EMPTY_SCOPE);
  const [seenIntent, setSeenIntent] = useState(intent?.key ?? null);
  if (intent && intent.key !== seenIntent) {
    setSeenIntent(intent.key);
    setMode('new');
    setDraft(intent.text);
    setScope(intent.scope);
  }

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [load, setLoad] = useState<Load>(conversationId ? 'loading' : 'ready');
  const [reloadKey, setReloadKey] = useState(0);
  const [live, setLive] = useState<{ id: string; text: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  /** Why the last request was refused; `seconds` counts a 429's Retry-After down. */
  const [refusal, setRefusal] = useState<{ text: string; seconds: number | null } | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  // What a request started for: closing the panel or showing another conversation (or the list)
  // moves it on, and a late answer then changes neither the view nor the URL (the server still
  // answers; the question is in the conversation when it is opened again).
  const viewEpochRef = useRef(0);
  useEffect(() => {
    viewEpochRef.current += 1;
  }, [open, conversationId]);
  const viewToken = () => {
    const epoch = viewEpochRef.current;
    return () => viewEpochRef.current === epoch;
  };

  const signIn = useCallback(() => {
    router.push(loginRedirectPath(`${window.location.pathname}${window.location.search}`));
  }, [router]);

  // The URL's conversation: load it unless it is the one held (just created or already shown).
  const [shownId, setShownId] = useState(conversationId);
  if (shownId !== conversationId) {
    setShownId(conversationId);
    if (conversationId === null) {
      setConversation(null);
      setLoad('ready');
    } else {
      // Back from a conversation lands on the list.
      setMode('list');
      if (conversation?.id !== conversationId) {
        setConversation(null);
        setLoad('loading');
      }
    }
  }
  const reload = useCallback(() => {
    setConversation(null);
    setLoad('loading');
    setReloadKey((n) => n + 1);
  }, [setConversation]);
  useEffect(() => {
    if (conversationId === null || load !== 'loading') return;
    const controller = new AbortController();
    client.get(conversationId, controller.signal).then(
      (next) => {
        setConversation(next);
        setScope(normalizeScope(next.scope));
        setVersions({});
        setLoad('ready');
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof AskApiError && error.kind === 'unauthenticated') signIn();
        setLoad(error instanceof AskApiError && error.kind === 'notFound' ? 'notFound' : 'error');
      },
    );
    return () => controller.abort();
  }, [client, conversationId, load, reloadKey, signIn]);

  // --- the list ------------------------------------------------------------------------------
  const listing = conversationId === null && mode === 'list';
  const [rows, setRows] = useState<readonly ConversationSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listKey, setListKey] = useState(0);
  useEffect(() => {
    if (!listing) return;
    const controller = new AbortController();
    client.list(workspaceId, null, controller.signal).then(
      (page) => {
        setListFailed(false);
        setRows(page.items);
        setCursor(page.next_cursor);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof AskApiError && error.kind === 'unauthenticated') signIn();
        setListFailed(true);
      },
    );
    return () => controller.abort();
  }, [client, listing, listKey, signIn, workspaceId]);
  const loadMore = () => {
    if (!cursor) return;
    void client.list(workspaceId, cursor).then(
      (page) => {
        setRows((current) => [...(current ?? []), ...page.items]);
        setCursor(page.next_cursor);
      },
      () => setListFailed(true),
    );
  };

  // --- chapters of the scoped document (the 장 Select and "범위: …") ---------------------------
  const scopeDocument = scope.document_ids[0] ?? null;
  const [chapters, setChapters] = useState<{ doc: string; items: readonly OutlineItem[] } | null>(
    null,
  );
  useEffect(() => {
    if (!scopeDocument) return;
    const controller = new AbortController();
    search.chapters(scopeDocument, controller.signal).then(
      (items) => setChapters({ doc: scopeDocument, items }),
      () => undefined,
    );
    return () => controller.abort();
  }, [scopeDocument, search]);
  const scopeChapters = chapters && chapters.doc === scopeDocument ? chapters.items : null;
  const scopeLine = scopeText(
    scope,
    documents.find((d) => d.id === scopeDocument)?.title ?? null,
    scopeChapters?.find((c) => c.id === scope.chapter_ids[0])?.title ?? null,
  );

  // --- streaming ------------------------------------------------------------------------------
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const running = runningAnswer(messages);
  const runningId = running?.id ?? null;
  const applyMessage = useCallback(
    (message: AskMessage) => {
      setConversation((current) =>
        current && current.id === message.conversation_id
          ? { ...current, messages: mergeMessages(current.messages, [message]) }
          : current,
      );
    },
    [setConversation],
  );
  useEffect(() => {
    if (!runningId) return;
    const id = runningId;
    const controller = new AbortController();
    const { signal } = controller;
    let lastSeq = 0;
    let text: string | null = null;
    // Once the answer is final the stream only drains to its close (no abort: see readAnswerStream).
    let finished = false;
    const finish = (message: AskMessage) => {
      finished = true;
      applyMessage(message);
      setLive(null);
      if (message.status === 'succeeded' || message.status === 'no_sources') {
        setAnnouncement(liveDoneText(message.sources.length));
      } else if (message.status === 'stopped') {
        setAnnouncement(ASK_TEXT.stopped);
      }
    };
    const fetchFinal = async (): Promise<boolean> => {
      try {
        const message = await client.message(id, signal);
        if (isTerminal(message)) {
          finish(message);
          return true;
        }
        if (text === null && message.text) setLive({ id, text: message.text });
        return false;
      } catch (error) {
        if (signal.aborted) return true;
        if (error instanceof AskApiError && error.kind === 'notFound') {
          setLive(null);
          reload();
          return true;
        }
        return false;
      }
    };
    void (async () => {
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
        let final: boolean;
        try {
          final = await readAnswerStream(id, {
            lastEventId: lastSeq,
            signal,
            onEvent: (event) => {
              if (event.type === 'delta') {
                if (event.seq <= lastSeq) return;
                lastSeq = event.seq;
                text = (text ?? '') + event.text;
                setLive({ id, text });
              } else if (event.type === 'reset') {
                lastSeq = Math.max(lastSeq, event.seq);
                text = '';
                setLive({ id, text });
              } else if (event.type === 'done' && event.message) {
                finish(event.message);
              } else {
                void fetchFinal();
              }
            },
          });
        } catch {
          return; // aborted
        }
        if (final) return;
        await sleep(1000, signal);
      }
      // The stream keeps breaking: poll the message every second until it is finished.
      while (!signal.aborted) {
        if (await fetchFinal()) return;
        await sleep(1000, signal);
      }
    })();
    return () => {
      if (!finished) controller.abort();
    };
  }, [applyMessage, client, reload, runningId]);

  // --- follow the newest content unless the reader scrolled up --------------------------------
  const endRef = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const end = endRef.current;
    if (!end || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting ?? true;
      setAtEnd(visible);
      if (visible) setUnseen(false);
    });
    observer.observe(end);
    return () => observer.disconnect();
  });
  const contentSize = messages.length + (live?.text?.length ?? 0) + (pending ? 1 : 0);
  const atEndRef = useRef(atEnd);
  useEffect(() => {
    atEndRef.current = atEnd;
  });
  useEffect(() => {
    if (contentSize === 0) return;
    if (atEndRef.current) endRef.current?.scrollIntoView({ block: 'nearest' });
    else setUnseen(true);
  }, [contentSize]);

  // --- refusal countdown (429) -----------------------------------------------------------------
  const [countdown, setCountdown] = useState<{ of: typeof refusal; left: number }>({
    of: null,
    left: 0,
  });
  if (countdown.of !== refusal) setCountdown({ of: refusal, left: refusal?.seconds ?? 0 });
  const left = countdown.of === refusal ? countdown.left : (refusal?.seconds ?? 0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = window.setTimeout(
      () => setCountdown((c) => ({ ...c, left: Math.max(0, c.left - 1) })),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [left]);
  const waiting = refusal?.seconds != null && left > 0;
  const refusalText =
    refusal?.seconds != null
      ? waiting
        ? askFailureText('rateLimited', askState, left)
        : null
      : (refusal?.text ?? null);

  const refuse = (error: unknown) => {
    const failure = error instanceof AskApiError ? error : new AskApiError('network');
    if (failure.kind === 'unauthenticated') {
      signIn();
      return;
    }
    setRefusal({
      text: askFailureText(failure.kind, askState, failure.retryAfterSeconds),
      seconds:
        failure.kind === 'rateLimited'
          ? Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 60))
          : null,
    });
  };

  // --- asking -----------------------------------------------------------------------------------
  const questions = messages.filter((m) => m.role === 'user').length;
  const turnLimited = conversation !== null && questions >= limits.max_turns;
  const blockedReason = reason
    ? unavailableText(reason)
    : turnLimited
      ? turnLimitText(limits.max_turns)
      : null;
  const tooLong = draft.trim().length > limits.max_question_chars;
  const canSend =
    !blockedReason && !tooLong && draft.trim() !== '' && !running && !sending && !waiting;

  // A request whose answer was lost (network, 5xx) may still have been accepted. Sending the
  // same operation again reuses its Idempotency-Key (the API replays the first result); any
  // other operation first re-reads the conversation so a landed one shows up, then starts afresh.
  const ambiguousRef = useRef<{ op: string; key: string; conversationId: string } | null>(null);
  const operationKey = async (op: string): Promise<string> => {
    const last = ambiguousRef.current;
    if (last?.op === op) return last.key;
    ambiguousRef.current = null;
    if (last) {
      try {
        const fresh = await client.get(last.conversationId);
        setConversation((current) => (current?.id === fresh.id ? fresh : current));
      } catch {
        // Unreadable now: the next read shows it.
      }
    }
    return newIdempotencyKey();
  };
  const settleOperation = (op: string, key: string, conversationId: string, error?: unknown) => {
    const lost =
      error !== undefined &&
      (!(error instanceof AskApiError) ||
        error.kind === 'network' ||
        (error.kind === 'failed' && (error.status === 0 || error.status >= 500)));
    ambiguousRef.current = lost ? { op, key, conversationId } : null;
  };

  const accepted = (conv: Conversation, result: MessageAccepted) => {
    setConversation({
      ...conv,
      messages: mergeMessages(conv.messages, [result.user_message, result.answer]),
    });
    const question = result.answer.question_message_id ?? '';
    setVersions((v) => Object.fromEntries(Object.entries(v).filter(([key]) => key !== question)));
  };

  async function send() {
    const question = draft.trim();
    if (sendingRef.current || !canSend) return;
    const current = viewToken();
    sendingRef.current = true;
    setSending(true);
    setPending(question);
    setRefusal(null);
    // Asking from the list starts a new conversation: show it, not the list.
    if (!conversation) setMode('new');
    let created: Conversation | null = null;
    try {
      let conv = conversation;
      if (!conv) {
        conv = await client.create(workspaceId, isEmptyScope(scope) ? {} : { scope });
        if (!current()) return;
        created = conv;
        setConversation(conv);
      }
      const body = sameScope(scope, normalizeScope(conv.scope))
        ? { question }
        : { question, scope };
      const op = `ask:${conv.id}:${JSON.stringify(body)}`;
      const key = await operationKey(op);
      let result: MessageAccepted;
      try {
        result = await client.ask(conv.id, body, key);
        settleOperation(op, key, conv.id);
      } catch (error) {
        settleOperation(op, key, conv.id, error);
        throw error;
      }
      if (!current()) return;
      accepted({ ...conv, scope }, result);
      setAnnouncement(ASK_TEXT.liveWriting);
      setDraft('');
      setAtEnd(true);
      atEndRef.current = true;
    } catch (error) {
      if (current()) refuse(error);
    } finally {
      sendingRef.current = false;
      setSending(false);
      setPending(null);
      if (created && current()) onNavigate(created.id, 'replace');
    }
  }

  async function again(message: AskMessage) {
    if (sendingRef.current || running || !conversation) return;
    const current = viewToken();
    sendingRef.current = true;
    setSending(true);
    setRefusal(null);
    const action =
      message.status === 'failed' || message.status === 'stopped' ? 'retry' : 'regenerate';
    try {
      const op = `${action}:${message.id}`;
      const key = await operationKey(op);
      let result: MessageAccepted;
      try {
        result = await client.again(message.id, action, key);
        settleOperation(op, key, conversation.id);
      } catch (error) {
        settleOperation(op, key, conversation.id, error);
        throw error;
      }
      if (!current()) return;
      accepted(conversation, result);
      setAnnouncement(ASK_TEXT.liveWriting);
    } catch (error) {
      if (current()) refuse(error);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function stop() {
    if (!running) return;
    try {
      const stopped = await client.cancel(running.id);
      applyMessage(stopped);
      if (isTerminal(stopped)) {
        setLive(null);
        if (stopped.status === 'stopped') setAnnouncement(ASK_TEXT.stopped);
      }
    } catch (error) {
      refuse(error);
    }
  }

  async function detach() {
    if (!conversation) return;
    try {
      const next = await client.detach(conversation.id);
      setConversation((current) => (current ? { ...current, attachment: next.attachment } : next));
    } catch (error) {
      refuse(error);
    }
  }

  // --- excerpt panel, copy, feedback ------------------------------------------------------------
  const [excerpt, setExcerpt] = useState<{ item: SearchItem; outdated: boolean } | null>(null);
  const [excerptOpen, setExcerptOpen] = useState(false);
  const excerptRequest = useRef(0);
  const openSource = (message: AskMessage, source: AskSource) => {
    const request = ++excerptRequest.current;
    setExcerpt({
      item: sourceItem(message, source, '발췌를 불러오는 중…'),
      outdated: source.outdated,
    });
    setExcerptOpen(true);
    const ids = [...new Set(source.block_ids)].slice(0, 12);
    void Promise.all(
      ids.map((blockId) => search.block(source.document_id, blockId, source.revision_id)),
    ).then(
      (blocks) => {
        if (request !== excerptRequest.current) return;
        const text = blocks.map((b) => b.text).join('\n\n');
        setExcerpt({ item: sourceItem(message, source, text), outdated: source.outdated });
      },
      () => {
        if (request !== excerptRequest.current) return;
        setExcerpt({
          item: sourceItem(message, source, '발췌를 불러오지 못했습니다. PDF에서 보세요.'),
          outdated: source.outdated,
        });
      },
    );
  };
  const copy = (message: AskMessage) => {
    void navigator.clipboard?.writeText(copyText(message)).then(
      () => setAnnouncement(ASK_TEXT.copied),
      () => setAnnouncement('복사하지 못했습니다'),
    );
  };
  const feedback = async (message: AskMessage, value: Parameters<AskClient['feedback']>[1]) => {
    await client.feedback(message.id, value);
    applyMessage({ ...message, feedback: value });
  };

  // --- delete ---------------------------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const menuButtonRef = useRef<HTMLElement | null>(null);
  const pendingDelete = useRef<ConversationSummary | null>(null);
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await client.remove(deleteTarget.id);
      setRows((current) => current?.filter((r) => r.id !== deleteTarget.id) ?? current);
      setDeleteTarget(null);
      setListKey((n) => n + 1);
    } catch (error) {
      refuse(error);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  // --- navigation -------------------------------------------------------------------------------
  const showList = () => {
    viewEpochRef.current += 1;
    setMode('list');
    if (conversationId !== null) onNavigate(null, 'push');
  };
  const startNew = () => {
    viewEpochRef.current += 1;
    setMode('new');
    setDraft('');
    setScope(EMPTY_SCOPE);
    setRefusal(null);
    if (conversationId !== null) onNavigate(null, 'push');
  };

  // --- input ------------------------------------------------------------------------------------
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  };

  const counterId = useId();
  const reasonId = useId();
  const counter = counterText(draft.trim().length, limits.max_question_chars);
  const describedBy = [blockedReason ? reasonId : null, counter ? counterId : null]
    .filter(Boolean)
    .join(' ');

  // --- render -----------------------------------------------------------------------------------
  const turns = conversationTurns(messages);
  const lastTurn = turns.at(-1);
  const attachment = conversation?.attachment ?? null;

  const content = (
    <>
      <div className={styles.toolbar}>
        {conversationId !== null || mode === 'new' ? (
          <Button size="sm" variant="ghost" onClick={showList}>
            대화 목록
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={startNew}>
          새 대화
        </Button>
        <AskScopePopover
          scope={scope}
          documents={documents}
          chapters={scopeChapters}
          onChange={setScope}
        />
      </div>
      {scopeLine ? <p className={styles.scopeText}>{scopeLine}</p> : null}

      {conversationId === null && mode === 'list' ? (
        rows === null && !listFailed ? (
          <LoadingRows />
        ) : listFailed && rows === null ? (
          <p className={styles.hint}>대화 목록을 불러오지 못했습니다.</p>
        ) : rows && rows.length > 0 ? (
          <>
            <ul className={styles.list} aria-label="대화 목록">
              {rows.map((row) => {
                const title = row.title || '제목 없는 대화';
                return (
                  <li key={row.id} className={styles.row}>
                    <button
                      type="button"
                      className={`${styles.rowOpen} qz-focus-ring`}
                      aria-label={title}
                      onClick={() => onNavigate(row.id, 'push')}
                    >
                      <span className={styles.rowTitle}>{title}</span>
                      <span className={styles.meta}>{conversationTime(row.last_message_at)}</span>
                    </button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label={`${title} 메뉴`}
                          icon={<MoreIcon />}
                          size="sm"
                          onPointerDown={(event) => {
                            menuButtonRef.current = event.currentTarget;
                          }}
                          onKeyDown={(event) => {
                            menuButtonRef.current = event.currentTarget;
                          }}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        aria-label={`${title} 메뉴`}
                        onCloseAutoFocus={(event) => {
                          const target = pendingDelete.current;
                          pendingDelete.current = null;
                          if (!target) return;
                          event.preventDefault();
                          menuButtonRef.current?.focus();
                          setDeleteTarget(target);
                        }}
                      >
                        <DropdownMenuItem
                          tone="danger"
                          onSelect={() => {
                            pendingDelete.current = row;
                          }}
                        >
                          삭제
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
            {cursor ? (
              <Button size="sm" variant="ghost" onClick={loadMore}>
                더 보기
              </Button>
            ) : null}
          </>
        ) : (
          <p className={styles.empty}>{ASK_TEXT.empty}</p>
        )
      ) : conversationId !== null && load === 'loading' ? (
        <LoadingRows />
      ) : conversationId !== null && load === 'notFound' ? (
        <p className={styles.empty}>{ASK_TEXT.notFound}</p>
      ) : conversationId !== null && load === 'error' ? (
        <div className={styles.actions}>
          <p className={styles.hint}>대화를 불러오지 못했습니다.</p>
          <Button size="sm" onClick={reload}>
            다시 시도
          </Button>
        </div>
      ) : (
        <div role="log" aria-label="대화" className={styles.log}>
          {turns.length === 0 && !pending ? <p className={styles.empty}>{ASK_TEXT.empty}</p> : null}
          {turns.map((turn) => {
            const count = turn.answers.length;
            const chosen = Math.min(versions[turn.question.id] ?? count - 1, count - 1);
            const shown = turn.answers[chosen];
            const isLast = turn === lastTurn && chosen === count - 1;
            const againBlocked =
              count >= limits.max_regenerations
                ? regenerateLimitText(limits.max_regenerations)
                : running || sending
                  ? '답을 만드는 중입니다.'
                  : null;
            return (
              <div key={turn.question.id} className={styles.log}>
                <article className={styles.user} aria-label="내 질문">
                  <p>{turn.question.text}</p>
                </article>
                {shown ? (
                  <AskAnswer
                    message={shown}
                    liveText={live && live.id === shown.id ? live.text : null}
                    version={{ index: chosen, count }}
                    onVersion={(index) => setVersions((v) => ({ ...v, [turn.question.id]: index }))}
                    actions={{
                      onSource: openSource,
                      onCopy: copy,
                      onFeedback: feedback,
                      onAgain: isLast && !reason ? (m) => void again(m) : null,
                      againBlocked,
                    }}
                  />
                ) : null}
              </div>
            );
          })}
          {pending ? (
            <div className={styles.log}>
              <article className={styles.user} aria-label="내 질문">
                <p>{pending}</p>
              </article>
              <AskAnswer
                message={PENDING_ANSWER}
                liveText={null}
                pending
                version={null}
                onVersion={() => undefined}
                actions={NO_ACTIONS}
              />
            </div>
          ) : null}
        </div>
      )}
      <div ref={endRef} aria-hidden="true" />
      {unseen && !atEnd ? (
        <Button
          size="sm"
          className={styles.newAnswer}
          onClick={() => {
            endRef.current?.scrollIntoView({ block: 'end' });
            setUnseen(false);
          }}
        >
          새 답변
        </Button>
      ) : null}
    </>
  );

  const footer = (
    <div className={styles.composer}>
      {attachment ? (
        <div role="group" aria-label="첨부한 문제" className={styles.chip}>
          <span className={styles.chipText}>
            <span className={styles.chipLabel}>{attachment.label}</span>
            <span>{disclosureText(attachment)}</span>
          </span>
          <IconButton
            label="첨부한 문제 빼기"
            icon={<CloseIcon />}
            size="sm"
            onClick={() => void detach()}
          />
        </div>
      ) : null}
      <div className={styles.inputRow}>
        <Textarea
          ref={inputRef}
          label="질문"
          hideLabel
          placeholder={ASK_TEXT.placeholder}
          rows={1}
          value={draft}
          readOnly={blockedReason !== null}
          aria-disabled={blockedReason !== null || undefined}
          aria-describedby={describedBy || undefined}
          className={styles.input}
          fieldClassName={styles.inputField}
          enterKeyHint="send"
          {...(composing ? { 'data-own-escape': '' } : {})}
          onChange={(event) => {
            setDraft(event.target.value);
            if (refusal && refusal.seconds == null) setRefusal(null);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
          }}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <Button size="sm" onClick={() => void stop()}>
            답변 중지
          </Button>
        ) : (
          <IconButton
            label="보내기"
            icon={<SendIcon />}
            variant="primary"
            aria-disabled={!canSend || undefined}
            aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void send()}
          />
        )}
      </div>
      {counter || blockedReason || refusalText ? (
        <div className={styles.composerMeta}>
          {blockedReason ? (
            <p id={reasonId} className={styles.hint}>
              {blockedReason}
            </p>
          ) : null}
          {refusalText ? (
            <p role="alert" className={styles.refusal}>
              {refusalText}
            </p>
          ) : null}
          {counter ? (
            <p id={counterId} className={tooLong ? styles.refusal : styles.hint}>
              {counter}
            </p>
          ) : null}
        </div>
      ) : null}
      <p role="status" className="qz-visually-hidden">
        {announcement}
      </p>
    </div>
  );

  const overlays = (
    <>
      <DocumentExcerptPanel
        workspaceId={workspaceId}
        client={search}
        item={excerpt?.item ?? null}
        open={excerptOpen}
        onClose={() => setExcerptOpen(false)}
        notice={excerpt?.outdated ? ASK_TEXT.outdated : null}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title="대화를 삭제할까요?"
        description="질문과 답이 모두 지워지고 되돌릴 수 없습니다."
        confirmLabel="삭제"
        onConfirm={() => void confirmDelete()}
        loading={deleting}
        returnFocusRef={menuButtonRef}
      />
    </>
  );

  const subtitle = conversationId !== null && conversation ? (conversation.title ?? null) : null;
  return { content, footer, overlays, subtitle };
}

const PENDING_ANSWER: AskMessage = {
  id: 'pending',
  conversation_id: 'pending',
  role: 'assistant',
  status: 'retrieving',
  text: '',
  sources: [],
  searched_sources: [],
  disclosure: 'none',
  error_code: null,
  uncited: false,
  truncated: false,
  degraded: [],
  question_message_id: null,
  retry_of_message_id: null,
  regenerated_from_message_id: null,
  feedback: null,
  created_at: new Date(0).toISOString(),
};

const NO_ACTIONS = {
  onSource: () => undefined,
  onCopy: () => undefined,
  onFeedback: async () => undefined,
  onAgain: null,
  againBlocked: null,
} as const;

function LoadingRows() {
  return (
    <div className={styles.loading} aria-busy="true">
      <p role="status" className="qz-visually-hidden">
        불러오는 중
      </p>
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
    </div>
  );
}
