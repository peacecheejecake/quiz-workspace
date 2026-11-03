'use client';

// One answer of the AI 질문 panel (ASK-01 "답 메시지"): `AI 생성` badge, the answer's Markdown
// subset (the DOCSUM renderer's parser: HTML, links and images stay text) with its footnote buttons,
// the `출처` list, the state lines (progress, stopped, failed, not found, uncited, truncated), the
// action row (`복사`, `도움이 안 됨`, `다시 생성` / `다시 시도`) and the answer versions ("답 k/n").
// While it streams the article is aria-busy and the model's `[Sn]` tags show as number chips; the
// validated `[n]` footnotes replace them when it is done.
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, RadioGroup } from '@quiz/ui';
import { Fragment, useId, useState, type ReactNode } from 'react';
import { parseSummaryMarkdown, type InlineNode } from '@/lib/documents/summary';
import type { AskMessage, AskSource, FeedbackReason } from '@/lib/ask/client';
import {
  ASK_TEXT,
  answerErrorText,
  FEEDBACK_REASONS,
  footnoteLabel,
  isTerminal,
  searchedLine,
  sourceLine,
  splitFootnotes,
} from '@/lib/ask/model';
import styles from './ask.module.css';

export interface AnswerActions {
  readonly onSource: (message: AskMessage, source: AskSource) => void;
  readonly onCopy: (message: AskMessage) => void;
  readonly onFeedback: (message: AskMessage, reason: FeedbackReason) => Promise<void>;
  /** `다시 생성` / `다시 시도` (only on the latest version of the last question). */
  readonly onAgain: ((message: AskMessage) => void) | null;
  /** Why `다시 생성` / `다시 시도` is not possible (text under it; aria-disabled). */
  readonly againBlocked: string | null;
}

export interface AskAnswerProps {
  readonly message: AskMessage;
  /** The text streamed so far (null: use the message's own text). */
  readonly liveText: string | null;
  /** A placeholder while the question is being accepted. */
  readonly pending?: boolean;
  readonly version: { readonly index: number; readonly count: number } | null;
  readonly onVersion: (index: number) => void;
  readonly actions: AnswerActions;
}

export function AskAnswer({
  message,
  liveText,
  pending = false,
  version,
  onVersion,
  actions,
}: AskAnswerProps) {
  const busy = pending || !isTerminal(message);
  const text = liveText ?? message.text;
  const finished = !busy;
  const sourceNumbers = finished ? new Set(message.sources.map((s) => s.number)) : null;
  const byNumber = new Map(message.sources.map((s) => [s.number, s]));
  const writing = !pending && (message.status === 'streaming' || (busy && text.length > 0));
  const againLabel =
    message.status === 'failed' || message.status === 'stopped' ? '다시 시도' : '다시 생성';
  const againReasonId = useId();

  return (
    <article className={styles.answer} aria-label="AI 답변" aria-busy={busy ? 'true' : 'false'}>
      {version && version.count > 1 ? (
        <div className={styles.versions}>
          <Button
            size="sm"
            variant="ghost"
            aria-label="이전 답 보기"
            aria-disabled={version.index === 0 || undefined}
            onClick={() => version.index > 0 && onVersion(version.index - 1)}
          >
            이전
          </Button>
          <span>{`답 ${version.index + 1}/${version.count}`}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="다음 답 보기"
            aria-disabled={version.index === version.count - 1 || undefined}
            onClick={() => version.index < version.count - 1 && onVersion(version.index + 1)}
          >
            다음
          </Button>
        </div>
      ) : null}
      <div className={styles.answerHead}>
        <Badge tone="accent">AI 생성</Badge>
        {busy ? (
          <p className={styles.progress}>{writing ? ASK_TEXT.writing : ASK_TEXT.searching}</p>
        ) : null}
      </div>

      {message.degraded.includes('attachment_only') ? (
        <p className={styles.notice}>{ASK_TEXT.attachmentOnly}</p>
      ) : null}
      {message.degraded.includes('dense_unavailable') ? (
        <p className={styles.notice}>{ASK_TEXT.denseUnavailable}</p>
      ) : null}

      {text ? (
        <AnswerMarkdown
          text={text}
          sourceNumbers={sourceNumbers}
          renderCite={(n) => {
            const source = byNumber.get(n);
            return source ? (
              <button
                type="button"
                className={`${styles.cite} qz-focus-ring`}
                aria-label={footnoteLabel(source)}
                onClick={() => actions.onSource(message, source)}
              >
                [{n}]
              </button>
            ) : (
              `[${n}]`
            );
          }}
        />
      ) : null}
      {finished && message.truncated ? <p className={styles.notice}>{ASK_TEXT.truncated}</p> : null}
      {finished && message.status === 'stopped' ? (
        <p className={styles.notice}>{ASK_TEXT.stopped}</p>
      ) : null}
      {finished && message.status === 'failed' ? (
        <p role="alert" className={styles.alert}>
          {answerErrorText(message.error_code)}
        </p>
      ) : null}
      {finished && message.uncited && message.status === 'succeeded' ? (
        <p className={styles.notice}>{ASK_TEXT.uncited}</p>
      ) : null}

      {finished && message.status === 'no_sources' && message.searched_sources.length > 0 ? (
        <div className={styles.searched}>
          <p className={styles.notice}>검색한 구절</p>
          <ul aria-label="검색한 구절">
            {message.searched_sources.map((source) => (
              <li key={`${source.number}:${source.document_id}:${source.page_from}`}>
                {searchedLine(source)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {finished && message.sources.length > 0 ? (
        <ol className={styles.sources} aria-label="출처">
          {message.sources.map((source) => (
            <li key={source.number}>
              <button
                type="button"
                className={`${styles.sourceButton} qz-focus-ring`}
                onClick={() => actions.onSource(message, source)}
              >
                {sourceLine(source)}
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      {finished ? (
        <div className={styles.actions}>
          {message.status !== 'failed' && text ? (
            <Button size="sm" variant="ghost" onClick={() => actions.onCopy(message)}>
              복사
            </Button>
          ) : null}
          {message.status !== 'failed' ? (
            <FeedbackButton message={message} onFeedback={actions.onFeedback} />
          ) : null}
          {actions.onAgain ? (
            <Button
              size="sm"
              variant="ghost"
              aria-disabled={actions.againBlocked ? true : undefined}
              aria-describedby={actions.againBlocked ? againReasonId : undefined}
              onClick={() => {
                if (!actions.againBlocked) actions.onAgain?.(message);
              }}
            >
              {againLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {finished && actions.onAgain && actions.againBlocked ? (
        <p id={againReasonId} className={styles.notice}>
          {actions.againBlocked}
        </p>
      ) : null}
      <p className={styles.notice}>{ASK_TEXT.notice}</p>
    </article>
  );
}

function FeedbackButton({
  message,
  onFeedback,
}: {
  readonly message: AskMessage;
  readonly onFeedback: (message: AskMessage, reason: FeedbackReason) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<FeedbackReason | null>(message.feedback ?? null);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const label = FEEDBACK_REASONS.find((r) => r.value === chosen)?.label;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost">
            도움이 안 됨
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-labelledby={titleId}
          closeLabel="도움이 안 됨 닫기"
          className={styles.feedback}
        >
          <p id={titleId} className={styles.feedbackTitle}>
            도움이 안 된 이유
          </p>
          <RadioGroup
            label="이유"
            hideLabel
            options={FEEDBACK_REASONS.map((r) => ({ value: r.value, label: r.label }))}
            value={chosen ?? undefined}
            onValueChange={(value) => {
              const reason = value as FeedbackReason;
              setChosen(reason);
              setFailed(false);
              onFeedback(message, reason).then(
                () => setOpen(false),
                () => setFailed(true),
              );
            }}
          />
          {failed ? <p className={styles.refusal}>의견을 보내지 못했습니다.</p> : null}
        </PopoverContent>
      </Popover>
      {label ? <span className={styles.meta}>{`의견: ${label}`}</span> : null}
    </>
  );
}

/** The answer's Markdown subset with its footnotes (or streaming tags) in place of `[n]`. */
function AnswerMarkdown({
  text,
  sourceNumbers,
  renderCite,
}: {
  readonly text: string;
  readonly sourceNumbers: ReadonlySet<number> | null;
  readonly renderCite: (n: number) => ReactNode;
}) {
  const blocks = parseSummaryMarkdown(text);
  const inline = (nodes: readonly InlineNode[]): ReactNode =>
    nodes.map((node, i) =>
      node.kind === 'text' ? (
        <Fragment key={i}>
          {splitFootnotes(node.text, sourceNumbers).map((part, j) =>
            part.kind === 'text' ? (
              <Fragment key={j}>{part.text}</Fragment>
            ) : part.kind === 'tag' ? (
              <span key={j} className={styles.tag}>
                [{part.number}]
              </span>
            ) : (
              <Fragment key={j}>{renderCite(part.number)}</Fragment>
            ),
          )}
        </Fragment>
      ) : node.kind === 'strong' ? (
        <strong key={i}>{inline(node.children)}</strong>
      ) : (
        <em key={i}>{inline(node.children)}</em>
      ),
    );
  return (
    <div className={styles.markdown}>
      {blocks.map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i}>{inline(block.content)}</p>
        ) : block.ordered ? (
          <ol key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
