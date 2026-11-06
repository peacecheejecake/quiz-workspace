'use client';

// The 본문 search's `AI에게 묻기` (ASK-01 "본문 검색의 AI에게 묻기"): opens the AI 질문 panel on a new
// conversation with the search text in its input (never sent) and the search's document/chapter
// filter as its 질문 범위. The page renders it only while new questions are available.
import { Button } from '@quiz/ui';

export function AskSearchButton({ onAsk }: { readonly onAsk: () => void }) {
  return (
    <Button size="sm" variant="ghost" aria-label="본문 검색어로 AI에게 묻기" onClick={onAsk}>
      AI에게 묻기
    </Button>
  );
}
