'use client';

// AIEXPL-01 for a share-link guest (QuestionViewer `read-only`, WS-VIEW-01): the AI explanation a
// member already made for this published question, under its explanation as a collapsed
// disclosure "AI 해설 보기" — only when there is one. A guest never makes one: no button, status,
// error, version or cost here; footnotes and sources are plain text (the share has no excerpt
// relay for members' sources).
import { Button } from '@quiz/ui';
import { useEffect, useId, useState } from 'react';
import {
  createExplanationClient,
  type ExplanationClient,
  type SharedExplanation,
} from '@/lib/ai-explanations/client';
import { EXPL_TEXT } from '@/lib/ai-explanations/model';
import { ExplanationView, type QuestionOption } from './ai-explanation';
import styles from './ai-explanation.module.css';

export interface SharedAiExplanationProps {
  readonly shareId: string;
  readonly questionId: string;
  readonly options: readonly QuestionOption[];
  readonly client?: ExplanationClient;
}

export function SharedAiExplanation(props: SharedAiExplanationProps) {
  return <SharedArea key={`${props.shareId}:${props.questionId}`} {...props} />;
}

function SharedArea({
  shareId,
  questionId,
  options,
  client: givenClient,
}: SharedAiExplanationProps) {
  const [defaultClient] = useState(() => createExplanationClient());
  const client = givenClient ?? defaultClient;
  const [found, setFound] = useState<SharedExplanation | null>(null);
  const [expanded, setExpanded] = useState(true);
  const headingId = useId();
  const bodyId = useId();

  useEffect(() => {
    const controller = new AbortController();
    client.shared(shareId, questionId, controller.signal).then(
      (explanation) => {
        if (!controller.signal.aborted) setFound(explanation);
      },
      () => undefined, // an optional extra: nothing shows when it cannot be read
    );
    return () => controller.abort();
  }, [client, shareId, questionId]);

  if (!found) return null;
  return (
    <section className={styles.area} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        {EXPL_TEXT.title}
      </h3>
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
        {expanded ? (
          <ExplanationView
            body={found.body}
            sources={found.sources}
            truncated={false}
            options={options}
            onSource={null}
          />
        ) : null}
      </div>
    </section>
  );
}
