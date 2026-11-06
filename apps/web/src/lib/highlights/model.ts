// HILITE-01 view model (docs/screens/highlights.md): `내 하이라이트` rows (order, filters, labels,
// explanation footnotes) and the explanation text as highlight blocks. Pure; unit-tested.
import { highlightColorLabels, type HighlightColor, type TextHighlight } from '@quiz/ui';
import type { MyHighlight } from '@/lib/notes/model';
import { displayStem } from '@/lib/questions/display-stem';

export const HIGHLIGHT_TEXT = {
  title: '내 하이라이트',
  onlyMine: '나에게만 보입니다.',
  list: '내 하이라이트 목록',
  empty: '아직 하이라이트가 없습니다. 노트나 문제 해설에서 글자를 고르면 여기에 모입니다.',
  filteredEmpty: '고른 조건의 하이라이트가 없습니다.',
  failed: '내 하이라이트를 불러오지 못했습니다.',
  retry: '다시 시도',
  source: '출처',
  color: '색',
  all: '전체',
  note: '노트',
  explanation: '해설',
  aiExplanation: 'AI 해설',
  missing: '해설이 바뀌어 위치를 찾을 수 없습니다',
  previousAi: '이전 AI 해설의 하이라이트',
  menu: '하이라이트 메뉴',
  goto: '위치로 이동',
  gotoMissing: '위치를 찾을 수 없어 이동할 수 없습니다.',
  recolor: '색 바꾸기',
  delete: '삭제',
  deleted: '하이라이트를 지웠습니다',
  copied: '복사했습니다.',
  undo: '되돌리기',
  undoHint: '되돌리려면 F8',
  more: '더 보기',
  less: '접기',
  explanationLabel: '해설',
  noChapter: '챕터 없음',
} as const;

/** "정리 노트의 내 하이라이트에 모았습니다 · <장 제목>" (under an explanation, once). */
export function collectedNotice(chapterTitle: string): string {
  return `정리 노트의 내 하이라이트에 모았습니다 · ${chapterTitle}`;
}

export type SourceFilter = 'all' | 'note' | 'explanation';
export type ColorFilter = 'all' | HighlightColor;

export const isNoteHighlight = (h: MyHighlight): boolean => h.target.kind === 'note';

/** The note version a note highlight belongs to (null for explanation highlights). */
export function noteVersionOf(h: MyHighlight): number | null {
  return h.target.kind === 'note' ? h.target.note_version : null;
}

/** "<색> · 노트 · 버전 k" / "<색> · 해설 · <n>장 <번호>번" / "<색> · AI 해설 · …". */
export function rowMeta(h: MyHighlight): string {
  const color = highlightColorLabels[h.color];
  if (h.target.kind === 'note') return `${color} · 노트 · 버전 ${h.target.note_version}`;
  const source = h.target.kind === 'ai_explanation' ? 'AI 해설' : '해설';
  return `${color} · ${source} · ${h.question?.number_label ?? ''}`.trimEnd();
}

const blockOrder = (block: string): [number, number] => {
  const m = /^s(\d+)\.i(\d+)$/.exec(block);
  return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, 0];
};

/**
 * Display order (HILITE-01 "행"): note highlights by version, newest first ("버전 k"), each in
 * body order; then the explanation highlights in the order the API gives (Heatmap order, then the
 * position in the explanation). The order does not follow the version on screen, so a row never
 * moves while the reader goes to it. A highlight made here sorts into its place at once.
 */
export function orderRows(items: readonly MyHighlight[]): MyHighlight[] {
  const notes = items.filter(isNoteHighlight).sort((a, b) => {
    const va = noteVersionOf(a) ?? 0;
    const vb = noteVersionOf(b) ?? 0;
    if (va !== vb) return vb - va;
    const [sa, ia] = blockOrder(a.anchor.block);
    const [sb, ib] = blockOrder(b.anchor.block);
    return sa - sb || ia - ib || a.anchor.start - b.anchor.start;
  });
  return [...notes, ...items.filter((h) => !isNoteHighlight(h))];
}

export function matchesFilters(h: MyHighlight, source: SourceFilter, color: ColorFilter): boolean {
  if (color !== 'all' && h.color !== color) return false;
  if (source === 'note') return isNoteHighlight(h);
  if (source === 'explanation') return !isNoteHighlight(h);
  return true;
}

/** Footnote numbers `h1`, `h2`… of the explanation rows, in display order (stable under filters). */
export function footnoteNumbers(rows: readonly MyHighlight[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const h of rows) if (!isNoteHighlight(h)) out.set(h.id, out.size + 1);
  return out;
}

/** "[^hk] <n>장 <번호>번 — <발문 앞부분>". */
export function highlightFootnote(h: MyHighlight, k: number): string {
  const label = h.question?.number_label ?? '';
  const stem = h.question ? displayStem(h.question.stem_preview) : '';
  return `[^h${k}] ${label} — ${stem}`.trimEnd();
}

/** The status badge of a row, if any. */
export function rowBadge(h: MyHighlight): string | null {
  if (h.anchor_status !== 'missing') return null;
  return h.target.kind === 'ai_explanation' ? HIGHLIGHT_TEXT.previousAi : HIGHLIGHT_TEXT.missing;
}

/** Whether `위치로 이동` can go anywhere (a missing explanation highlight cannot). */
export function canGoTo(h: MyHighlight): boolean {
  return h.target.kind === 'note' || h.anchor_status !== 'missing';
}

// --- explanation text ----------------------------------------------------------------------------

const PARAGRAPH_SPLIT = /\n\s*\n/;

/** Explanation paragraphs as highlight blocks `p<i>` (the API's split, HILITE-01 H2). */
export function explanationBlocks(text: string): { id: string; text: string }[] {
  return text.split(PARAGRAPH_SPLIT).map((part, i) => ({ id: `p${i}`, text: part }));
}

/** The explanation highlights where they are drawn now (`anchor_current`; missing ones aren't). */
export function explanationHighlightsOf(
  items: readonly MyHighlight[],
  questionId: string,
): TextHighlight[] {
  return items.flatMap((h) => {
    if (h.target.kind !== 'explanation' || h.target.question_id !== questionId) return [];
    const at = h.anchor_current;
    if (!at) return [];
    return [{ id: h.id, block: at.block, start: at.start, end: at.end, color: h.color }];
  });
}

/** `items` after a successful create that replaced `replaced`. */
export function withCreated(
  items: readonly MyHighlight[],
  created: MyHighlight,
  replaced: readonly string[],
): MyHighlight[] {
  return [...items.filter((h) => h.id !== created.id && !replaced.includes(h.id)), created];
}

/** `items` with `updated` in place of the highlight with its id. */
export function withUpdated(items: readonly MyHighlight[], updated: MyHighlight): MyHighlight[] {
  return items.map((h) => (h.id === updated.id ? updated : h));
}

/** At most this many undo toasts at once; a fourth closes the oldest (HILITE-01 "삭제"). */
export const MAX_UNDO_TOASTS = 3;
/** How long an undo toast stays (paused while hovered, focused or the window is hidden). */
export const UNDO_TOAST_MS = 10_000;
