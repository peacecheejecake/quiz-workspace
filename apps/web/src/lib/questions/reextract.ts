// UX12-REEXTRACT (docs/screens/ux12-reextract.md): the words of the re-extraction review. FastAPI
// compares each draft with what it replaces (`ImportDraft.previous`); this only says it.
import type { Schemas } from '@quiz/api-client';

export type DraftPrevious = Schemas['DraftPrevious'];

const CHANGED_LABELS: Readonly<Record<DraftPrevious['changed'][number], string>> = {
  type: '유형',
  stem: '발문',
  table: '표',
  options: '보기',
  answer: '정답',
};

/** "이전 문제 5번과 달라진 항목: 발문, 보기"; null when nothing differs. */
export function changedText(previous: DraftPrevious): string | null {
  if (previous.changed.length === 0) return null;
  const kind = previous.question_id ? '문제' : '초안';
  const fields = previous.changed.map((field) => CHANGED_LABELS[field]).join(', ');
  const name =
    previous.number !== null
      ? `이전 ${kind} ${previous.number}번과`
      : `이전 ${kind}${kind === '문제' ? '와' : '과'}`;
  return `${name} 달라진 항목: ${fields}`;
}

/** "이전 문제 5번을", the object of a sentence about the earlier question. */
export function previousObject(previous: DraftPrevious): string {
  return previous.number === null ? '이전 문제를' : `이전 문제 ${previous.number}번을`;
}

/** The line above a re-extracted list: what changed, what is new and what is gone. */
export function reextractSummary(
  drafts: readonly { readonly previous?: DraftPrevious | null | undefined }[],
  missing: readonly number[],
): string {
  const changed = drafts.filter((d) => d.previous && d.previous.changed.length > 0).length;
  const added = drafts.filter((d) => !d.previous).length;
  const same = drafts.length - changed - added;
  const gone = missing.length
    ? ` · 이번에 없는 이전 문제: ${missing.map((n) => `${n}번`).join(', ')}`
    : '';
  return `다시 추출 결과: 변경 ${changed}개 · 새 문제 ${added}개 · 같음 ${same}개${gone}`;
}
