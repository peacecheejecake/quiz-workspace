'use client';

// AIEXPL-01 `AI 해설` (docs/screens/ai-explanations.md "레이아웃 및 컴포넌트"): the area under a
// QuestionViewer result — `practice` / `sequence(bank|mock)` once the position was submitted (the
// caller mounts it only then: nothing is fetched before a submission), `manage` (문제 상세,
// `view: detail`) and `manage(mock)` (`view: manage`) without one. A region named by its h3.
//   layout    a group `AI 해설`: a toolbar (`AI 해설` generate button + `AI 질문하기`) and, only when
//             there is something to show, the region below (none: no region at all)
//   none      the `AI 해설` button; feature off / archived: the reason instead
//   cached    an open disclosure `AI 해설 보기` (the result stays in view); it reads
//             the stored one, no generation
//   making    "AI 해설을 만드는 중" and the text so far (SSE, ASK-W's Markdown and number chips),
//             aria-busy; also joined when someone else started it (the same stream from seq 0)
//   done      `AI 생성` badge, the notice, the body (every option), footnotes `[n]` and the `출처`
//             list (→ 본문 발췌 → PDF에서 보기), "<시각> · 버전 k" and `다시 만들기` (editors)
//   failed    role=alert with the reason + `다시 시도` (a new generation)
// One status region announces the start and the end once each. Making one moves focus to the
// heading; finishing never moves it. The shared, guest version is SharedAiExplanation.
import { Badge, Button } from '@quiz/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnswerMarkdown } from '@/components/ask/ask-answer';
import { AskQuestionButton } from '@/components/ask/ask-launcher';
import askStyles from '@/components/ask/ask.module.css';
import { DocumentExcerptPanel } from '@/components/search/document-excerpt-panel';
import type { AskAttachmentInput } from '@/lib/ask/client';
import {
  createExplanationClient,
  ExplanationApiError,
  readExplanationStream,
  type Explanation,
  type ExplanationBody,
  type ExplanationClient,
  type ExplanationGate,
  type ExplanationSource,
  type ExplanationState,
  type ExplanationTarget,
} from '@/lib/ai-explanations/client';
import {
  emptyMode,
  EXPL_TEXT,
  explanationErrorText,
  explanationFailureText,
  isLive,
  metaText,
  sourceLine,
} from '@/lib/ai-explanations/model';
import { createSearchClient, type SearchClient, type SearchItem } from '@/lib/search/client';
import { formatDateTime } from '../labels';
import styles from './ai-explanation.module.css';

export interface QuestionOption {
  readonly id: string;
  readonly text: string;
}

export interface AiExplanationProps {
  readonly workspaceId: string;
  readonly target: ExplanationTarget;
  readonly gate: ExplanationGate;
  /** The question's options (any order): the body names each by its text. */
  readonly options: readonly QuestionOption[];
  /** `AI 질문하기` attaches this (null: no button). */
  readonly askAttachment?: AskAttachmentInput | null;
  /** The revision shown (manage views): an edit starts the area over. */
  readonly revisionId?: string;
  readonly client?: ExplanationClient;
  readonly searchClient?: Pick<SearchClient, 'block'>;
}

/** The area for one question and gate (a new question or session starts over). */
export function AiExplanation(props: AiExplanationProps) {
  const key = `${props.target.kind}:${props.target.id}:${props.revisionId ?? ''}:${JSON.stringify(props.gate)}`;
  return <AiExplanationArea key={key} {...props} />;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly state: ExplanationState };

interface LiveText {
  readonly id: string;
  readonly text: string;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    });
  });

function AiExplanationArea({
  workspaceId,
  target,
  gate,
  options,
  askAttachment = null,
  revisionId: _revisionId,
  client: givenClient,
  searchClient: givenSearch,
}: AiExplanationProps) {
  const [defaultClient] = useState(() => createExplanationClient());
  const client = givenClient ?? defaultClient;
  const [defaultSearch] = useState(() => createSearchClient());
  const search = givenSearch ?? defaultSearch;
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The area (and its heading) appears only once there is something to show: focus moves to it
  // after the render that mounts it.
  const focusHeading = useRef(false);

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [live, setLive] = useState<LiveText | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The status region joins the area once a generation is asked for or followed (before its first
  // announcement), so a result panel's own status stays the only one until then.
  const [announcer, setAnnouncer] = useState(false);
  /** Why the last create / regenerate was refused, or how a regeneration failed. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** How the last generation followed here failed (shown while another one is current). */
  const [streamFailure, setStreamFailure] = useState<{ id: string; text: string } | null>(null);
  /**
   * A followed generation ended (an `error`, or `done` without its result) and its state could not
   * be read again (access lost, network): it is shown as ended, never as still running.
   */
  const [ended, setEnded] = useState<{
    readonly id: string;
    readonly text: string;
    readonly action: 'create' | 'reload' | null;
  } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Read the state (also after a finished generation, for the fresh permissions).
  const gateRef = useRef(gate);
  const targetRef = useRef(target);
  useEffect(() => {
    const controller = new AbortController();
    client.state(targetRef.current, gateRef.current, controller.signal).then(
      (state) => {
        if (!controller.signal.aborted) setLoad({ status: 'ready', state });
      },
      () => {
        if (!controller.signal.aborted)
          setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      },
    );
    return () => controller.abort();
  }, [client, reload]);

  const state = load.status === 'ready' ? load.state : null;
  const explanation = state?.explanation ?? null;
  const endedHere = ended !== null && explanation?.id === ended.id ? ended : null;
  const liveId = isLive(explanation) && !endedHere ? (explanation?.id ?? null) : null;

  // An explanation being made (started here or by someone else) shows open, with its text from
  // the start, and is announced once.
  const [seenLive, setSeenLive] = useState<string | null>(null);
  if (liveId !== seenLive) {
    setSeenLive(liveId);
    if (liveId) {
      setExpanded(true);
      setAnnouncer(true);
      setAnnouncement(EXPL_TEXT.started);
      if (live?.id !== liveId) setLive({ id: liveId, text: '' });
    }
  }

  // Follow it: its stream from the start (or resumed), then the state again.
  useEffect(() => {
    if (!liveId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let lastEventId = 0;
    const finish = (done: Explanation | null, failure: string | null) => {
      if (signal.aborted) return;
      if (done) {
        setLoad((prev) =>
          prev.status === 'ready' && prev.state.explanation?.id === done.id
            ? { status: 'ready', state: { ...prev.state, explanation: done } }
            : prev,
        );
      }
      setAnnouncement(failure ? '' : EXPL_TEXT.ready);
      // A regeneration that failed leaves the current success shown: it says why (below).
      setStreamFailure(failure ? { id: liveId, text: failure } : null);
      // Read the state again (fresh permissions, the stored result). Not tied to this stream's
      // signal: showing the result ends the stream.
      client.state(targetRef.current, gateRef.current).then(
        (next) => {
          if (mounted.current) setLoad({ status: 'ready', state: next });
        },
        (error: unknown) => {
          if (!mounted.current || done) return;
          const lost = error instanceof ExplanationApiError && error.kind === 'notFound';
          setEnded({
            id: liveId,
            text: lost ? explanationFailureText('notFound') : (failure ?? EXPL_TEXT.loadFailed),
            action: lost ? null : failure ? 'create' : 'reload',
          });
        },
      );
    };
    void (async () => {
      try {
        for (;;) {
          const final = await readExplanationStream(
            targetRef.current.kind,
            liveId,
            gateRef.current,
            {
              lastEventId,
              signal,
              onId: (id) => {
                lastEventId = id;
              },
              onEvent: (event) => {
                if (event.type === 'delta') {
                  setLive((prev) => ({
                    id: liveId,
                    text: (prev?.id === liveId ? prev.text : '') + event.text,
                  }));
                } else if (event.type === 'reset') {
                  setLive({ id: liveId, text: '' });
                } else if (event.type === 'done') {
                  finish(event.explanation, null);
                } else {
                  finish(null, explanationErrorText(event.code));
                }
              },
            },
          );
          if (final || signal.aborted) return;
          // The stream ended early (a relay or time limit): read the state, then go on.
          const next = await client
            .state(targetRef.current, gateRef.current, signal)
            .catch(() => null);
          if (signal.aborted) return;
          if (next && !(next.explanation?.id === liveId && isLive(next.explanation))) {
            setLoad({ status: 'ready', state: next });
            if (next.explanation?.status === 'succeeded') setAnnouncement(EXPL_TEXT.ready);
            return;
          }
          await sleep(1000, signal);
          if (signal.aborted) return;
        }
      } catch {
        // aborted: the area went away or another explanation is shown
      }
    })();
    return () => controller.abort();
  }, [liveId, client]);

  async function request(action: 'create' | 'regenerate') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setRefusal(null);
    setStreamFailure(null);
    setAnnouncer(true);
    focusHeading.current = true;
    try {
      const next =
        action === 'create'
          ? await client.create(target, gate)
          : await client.regenerate(target, gate);
      if (!mounted.current) return;
      setExpanded(true);
      // Only now: clearing an ended one earlier would follow its stream again meanwhile.
      setEnded(null);
      setLoad({ status: 'ready', state: next });
    } catch (error) {
      focusHeading.current = false;
      if (!mounted.current) return;
      const failure =
        error instanceof ExplanationApiError
          ? explanationFailureText(error.kind, error.retryAfterSeconds)
          : explanationFailureText('failed');
      const kind = error instanceof ExplanationApiError ? error.kind : 'failed';
      // Feature off / archived: the state read again shows that reason in place of the button.
      if (kind !== 'disabled' && kind !== 'archived') setRefusal(failure);
      if (kind !== 'rateLimited') setReload((n) => n + 1);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  // --- excerpt panel ---------------------------------------------------------------------------
  const [excerpt, setExcerpt] = useState<{ item: SearchItem; outdated: boolean } | null>(null);
  const [excerptOpen, setExcerptOpen] = useState(false);
  const excerptRequest = useRef(0);
  const openSource = (source: ExplanationSource) => {
    const requestId = ++excerptRequest.current;
    setExcerpt({ item: sourceItem(source, '발췌를 불러오는 중…'), outdated: source.outdated });
    setExcerptOpen(true);
    // The pinned passage: the cited blocks of the revision the explanation was made from (kept
    // after a republish; `outdated` says so above the excerpt).
    const ids = [...new Set(source.block_ids)].slice(0, 12);
    const failed = () => {
      if (requestId !== excerptRequest.current) return;
      setExcerpt({
        item: sourceItem(source, '발췌를 불러오지 못했습니다. PDF에서 보세요.'),
        outdated: source.outdated,
      });
    };
    if (ids.length === 0) {
      failed();
      return;
    }
    Promise.all(
      ids.map((blockId) => search.block(source.document_id, blockId, source.revision_id)),
    ).then((blocks) => {
      if (requestId !== excerptRequest.current) return;
      const text = blocks.map((b) => b.text).join('\n\n');
      setExcerpt({ item: sourceItem(source, text), outdated: source.outdated });
    }, failed);
  };

  let content: ReactNode;
  if (load.status === 'loading') {
    content = <p className={styles.hint}>{EXPL_TEXT.loading}</p>;
  } else if (load.status === 'error' || !state) {
    content = (
      <div role="alert" className={styles.alert}>
        <p className={styles.text}>{EXPL_TEXT.loadFailed}</p>
        <Button
          size="sm"
          onClick={() => {
            setLoad({ status: 'loading' });
            setReload((n) => n + 1);
          }}
        >
          {EXPL_TEXT.retry}
        </Button>
      </div>
    );
  } else if (explanation === null) {
    // Nothing to show: no area, only the toolbar's button (or the reason).
    content = null;
  } else if (endedHere) {
    content = (
      <>
        <div role="alert" className={styles.alert}>
          <p className={styles.text}>{endedHere.text}</p>
        </div>
        {endedHere.action && (endedHere.action !== 'create' || state.available) ? (
          <div className={styles.row}>
            <Button
              size="sm"
              loading={pending}
              onClick={() => {
                if (endedHere.action === 'create') {
                  void request('create');
                } else {
                  setEnded(null);
                  setReload((n) => n + 1);
                }
              }}
            >
              {EXPL_TEXT.retry}
            </Button>
          </div>
        ) : null}
      </>
    );
  } else if (isLive(explanation)) {
    const text = live?.id === explanation.id ? live.text : '';
    content = (
      <div className={styles.done} aria-busy="true">
        <p className={styles.progress}>{EXPL_TEXT.working}</p>
        {text ? (
          <AnswerMarkdown text={text} sourceNumbers={null} renderCite={(n) => `[${n}]`} />
        ) : null}
      </div>
    );
  } else if (explanation.status === 'failed') {
    const mode = emptyMode(state);
    content = (
      <>
        <div role="alert" className={styles.alert}>
          <p className={styles.text}>{explanationErrorText(explanation.error_code)}</p>
        </div>
        {mode === 'create' ? (
          <div className={styles.row}>
            <Button size="sm" loading={pending} onClick={() => void request('create')}>
              {EXPL_TEXT.retry}
            </Button>
          </div>
        ) : (
          <p className={styles.hint}>
            {mode === 'disabled' ? EXPL_TEXT.disabled : EXPL_TEXT.archived}
          </p>
        )}
      </>
    );
  } else {
    content = (
      <>
        <div className={styles.row}>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}
          >
            {EXPL_TEXT.show}
          </Button>
        </div>
        <div id={bodyId} hidden={!expanded}>
          {expanded && explanation.body ? (
            <ExplanationView
              body={explanation.body}
              sources={explanation.sources}
              truncated={explanation.truncated}
              options={options}
              onSource={openSource}
              meta={metaText(explanation, formatDateTime)}
              actions={
                state.can_regenerate ? (
                  <div className={styles.row}>
                    <Button size="sm" loading={pending} onClick={() => void request('regenerate')}>
                      {EXPL_TEXT.regenerate}
                    </Button>
                  </div>
                ) : null
              }
            />
          ) : null}
        </div>
      </>
    );
  }

  const mode = state && explanation === null ? emptyMode(state) : null;
  const showArea = content !== null && load.status === 'ready';
  useEffect(() => {
    if (focusHeading.current && headingRef.current) {
      focusHeading.current = false;
      headingRef.current.focus();
    }
  });

  return (
    <div role="group" aria-label={EXPL_TEXT.title} className={styles.root}>
      <div className={styles.row}>
        {mode === 'create' ? (
          <Button size="sm" loading={pending} onClick={() => void request('create')}>
            {EXPL_TEXT.create}
          </Button>
        ) : null}
        <AskQuestionButton attachment={askAttachment} label={EXPL_TEXT.ask} variant="secondary">
          {EXPL_TEXT.ask}
        </AskQuestionButton>
      </div>
      {mode === 'disabled' || mode === 'archived' ? (
        <p className={styles.hint}>
          {mode === 'disabled' ? EXPL_TEXT.disabled : EXPL_TEXT.archived}
        </p>
      ) : null}
      {load.status === 'loading' || load.status === 'error' || !state ? content : null}
      {showArea ? (
        <section className={styles.area} aria-labelledby={headingId}>
          <h3 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
            {EXPL_TEXT.title}
          </h3>
          {content}
          {streamFailure &&
          !refusal &&
          explanation?.status === 'succeeded' &&
          explanation.id !== streamFailure.id ? (
            <p role="alert" className={styles.alert}>
              {streamFailure.text}
            </p>
          ) : null}
        </section>
      ) : null}
      {refusal ? (
        <p role="alert" className={styles.alert}>
          {refusal}
        </p>
      ) : null}
      {announcer ? (
        <p role="status" className="qz-visually-hidden">
          {announcement}
        </p>
      ) : null}
      {/* Inside the group, so over a modal panel or dialog it is that layer's own child layer. */}
      {excerpt ? (
        <DocumentExcerptPanel
          workspaceId={workspaceId}
          client={search}
          item={excerpt.item}
          open={excerptOpen}
          onClose={() => setExcerptOpen(false)}
          notice={excerpt.outdated ? EXPL_TEXT.outdated : null}
        />
      ) : null}
    </div>
  );
}

/** The finished explanation: badge, notice, body, footnotes and sources (members and guests). */
export function ExplanationView({
  body,
  sources,
  truncated,
  options,
  onSource,
  meta,
  actions,
}: {
  readonly body: ExplanationBody;
  readonly sources: readonly ExplanationSource[];
  readonly truncated: boolean;
  readonly options: readonly QuestionOption[];
  /** Footnotes and source rows open the excerpt (null: plain text, the shared view). */
  readonly onSource: ((source: ExplanationSource) => void) | null;
  readonly meta?: string | null;
  readonly actions?: ReactNode;
}) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const numbers = new Set(byNumber.keys());
  const text = new Map(options.map((o) => [o.id, o.text]));
  const renderCite = (n: number): ReactNode => {
    const source = byNumber.get(n);
    if (!source || !onSource) return `[${n}]`;
    return (
      <button
        type="button"
        className={`${askStyles.cite} qz-focus-ring`}
        aria-label={`출처 ${n}`}
        onClick={() => onSource(source)}
      >
        [{n}]
      </button>
    );
  };
  const markdown = (value: string) => (
    <AnswerMarkdown text={value} sourceNumbers={numbers} renderCite={renderCite} />
  );
  return (
    <div className={styles.done}>
      <div className={styles.row}>
        <Badge tone="accent">{EXPL_TEXT.badge}</Badge>
        <p className={styles.hint}>{EXPL_TEXT.notice}</p>
      </div>
      {body.summary_md ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>{EXPL_TEXT.summary}</h4>
          {markdown(body.summary_md)}
        </div>
      ) : null}
      {body.options.length > 0 ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>{EXPL_TEXT.options}</h4>
          <ol className={styles.optionList}>
            {body.options.map((option, i) => (
              <li key={option.option_id}>
                <span className={styles.optionName}>
                  {`${i + 1}. ${text.get(option.option_id) ?? '보기'}`}
                </span>
                {markdown(option.why_md)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {body.points_md ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>{EXPL_TEXT.points}</h4>
          {markdown(body.points_md)}
        </div>
      ) : null}
      {body.concepts_md ? (
        <div className={styles.part}>
          <h4 className={styles.partTitle}>{EXPL_TEXT.concepts}</h4>
          {markdown(body.concepts_md)}
        </div>
      ) : null}
      {truncated ? <p className={styles.hint}>{EXPL_TEXT.truncated}</p> : null}
      {sources.length > 0 ? (
        <ol className={onSource ? askStyles.sources : styles.plainSources} aria-label="출처">
          {sources.map((source) => (
            <li key={source.n}>
              {onSource ? (
                <button
                  type="button"
                  className={`${askStyles.sourceButton} qz-focus-ring`}
                  onClick={() => onSource(source)}
                >
                  {sourceLine(source)}
                </button>
              ) : (
                sourceLine(source)
              )}
              {source.outdated ? <span className={styles.hint}> {EXPL_TEXT.outdated}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {meta ? <p className={styles.meta}>{meta}</p> : null}
      {actions}
    </div>
  );
}

/** The excerpt panel's hit for a cited source (its blocks of the pinned document revision). */
function sourceItem(source: ExplanationSource, text: string): SearchItem {
  const blockId = source.block_id ?? source.block_ids[0] ?? '';
  return {
    document_id: source.document_id,
    document_title: source.document_title,
    document_type: 'book',
    revision_id: source.revision_id,
    chunk_id: `ai-explanation:${source.n}:${source.document_id}:${blockId}`,
    chapter_id: null,
    section_id: null,
    breadcrumb: [source.document_title, ...(source.chapter_title ? [source.chapter_title] : [])],
    block_id: blockId,
    block_ids: [...source.block_ids],
    context_block_ids: [...source.block_ids],
    page: source.page,
    bbox: null,
    locations: [],
    text,
    highlights: [],
    term_highlights: [],
    truncated_start: false,
    truncated_end: false,
    language: null,
    rank: source.n,
    score: 0,
    score_type: 'rerank',
  };
}
