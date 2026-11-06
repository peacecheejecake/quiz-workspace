'use client';

// AIEXPL-01 for a share-link guest (QuestionViewer `read-only`, WS-VIEW-01): the AI explanation a
// member already made for this published question, under its explanation as an open
// disclosure "AI 해설" (the same one as 관련 본문) — only when there is one. A guest never makes one: no button, status,
// error, version or cost here; footnotes and sources are plain text (the share has no excerpt
// relay for members' sources).
import { useEffect, useState } from 'react';
import {
  createExplanationClient,
  type ExplanationClient,
  type SharedExplanation,
} from '@/lib/ai-explanations/client';
import { EXPL_TEXT } from '@/lib/ai-explanations/model';
import { SectionDisclosure } from '../section-disclosure/section-disclosure';
import { ExplanationView, type QuestionOption } from './ai-explanation';

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
    <SectionDisclosure
      title={EXPL_TEXT.title}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
    >
      {expanded ? (
        <ExplanationView
          body={found.body}
          sources={found.sources}
          truncated={false}
          options={options}
          onSource={null}
        />
      ) : null}
    </SectionDisclosure>
  );
}
