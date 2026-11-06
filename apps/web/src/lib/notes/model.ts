// CHNOTE-01 정리 노트 view model (docs/screens/chapter-notes.md, docs/questions.md §9): what the
// panel shows for a chapter's note state, the failure reasons, footnote lines and the small
// Markdown subset of item text. Pure; unit-tested without a browser.
import type { Schemas } from '@quiz/api-client';
import { displayStem } from '@/lib/questions/display-stem';

export type ChapterNoteState = Schemas['ChapterNoteState'];
export type ChapterNote = Schemas['ChapterNote'];
export type ChapterNoteList = Schemas['ChapterNoteList'];
export type ChapterNoteSummary = Schemas['ChapterNoteSummary'];
export type NoteGeneration = Schemas['NoteGeneration'];
export type NoteSection = Schemas['NoteSection'];
export type NoteFootnote = Schemas['NoteFootnote'];
export type NoteVersion = Schemas['NoteVersion'];
export type SharedChapterNote = Schemas['SharedChapterNote'];
export type SharedChapterNoteList = Schemas['SharedChapterNoteList'];
export type QuestionPreview = Schemas['QuestionPreview'];
export type MyHighlight = Schemas['Highlight'];

export const NOTE_PROBLEMS = {
  noQuestions: 'urn:quiz-workspace:problem:no-chapter-questions',
  running: 'urn:quiz-workspace:problem:note-generation-running',
  disabled: 'urn:quiz-workspace:problem:note-generation-disabled',
} as const;

export const NOTE_TEXT = {
  title: '정리 노트',
  aiBadge: 'AI 생성',
  stale: '문제가 바뀌어 최신이 아닙니다',
  empty: '아직 정리 노트가 없습니다.',
  noQuestions: '이 장에는 확정된 문제가 없습니다.',
  notFound: '장을 찾을 수 없습니다.',
  generating: '정리 노트를 만드는 중',
  failed: '정리 노트를 만들지 못했습니다',
  unavailable: '이 환경에서는 AI 정리 노트를 사용할 수 없습니다.',
  previous: '이전 버전입니다. 최신 버전은 버전 선택에서 고를 수 있습니다.',
  answersNotice: '이 노트에는 문제의 정답과 해설 내용이 들어 있습니다.',
  search: '노트에서 찾기',
  bodyLabel: '정리 노트 본문',
  preview: '문제 미리보기',
  previewLoading: '미리보기를 불러오는 중',
  previewFailed: '미리보기를 불러오지 못했습니다',
  openQuestion: '문제 열기',
  footnoteGone: '삭제되었거나 옮긴 문제',
  sharedMissing: '정리 노트가 갱신 중이거나 없습니다.',
} as const;

/** "이 장의 확정 문제 n개와 해설로 정리합니다. …" (shown with `정리 노트 만들기`). */
export function sendNotice(count: number): string {
  return `이 장의 확정 문제 ${count}개와 해설로 정리합니다. 문제와 해설이 AI 서비스로 전송됩니다.`;
}

const REASONS: Readonly<Record<string, string>> = {
  llm_unavailable: 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
  llm_timeout: 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
  note_citation_invalid: '문제 출처를 확인할 수 있는 내용을 만들지 못했습니다. 다시 시도하세요.',
};

/** The failure reason shown under "정리 노트를 만들지 못했습니다" (spec "오류 이유 문구"). */
export function failureReason(errorCode: string | null | undefined): string {
  return (errorCode && REASONS[errorCode]) || '정리 노트를 만들지 못했습니다. 다시 시도하세요.';
}

export function isActive(generation: NoteGeneration | null | undefined): boolean {
  return generation?.status === 'queued' || generation?.status === 'running';
}

/** "k/m 묶음" for a large chapter's running generation, else null. */
export function batchProgress(generation: NoteGeneration | null | undefined): string | null {
  const p = generation?.progress;
  if (!isActive(generation) || !p || p.batches_total < 2) return null;
  return `${p.batches_done}/${p.batches_total} 묶음`;
}

/** Fixed zone and locale so the server render and hydration agree. */
const DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

export function formatNoteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date);
}

/** "문제 n개 기준 · <생성 시각>". */
export function metaLine(questionCount: number, createdAt: string): string {
  return `문제 ${questionCount}개 기준 · ${formatNoteTime(createdAt)}`;
}

/** `버전` option: "버전 k · <시각>", the newest with "(최신)". */
export function versionLabel(version: NoteVersion, newest: boolean): string {
  return `버전 ${version.version} · ${formatNoteTime(version.created_at)}${newest ? ' (최신)' : ''}`;
}

/** Footnote line: "[^k] <n>장 <번호>번 — <발문 앞 40자>" or "… — 삭제되었거나 옮긴 문제". */
export function footnoteText(footnote: NoteFootnote): string {
  const tail =
    footnote.question_id !== null && footnote.stem_preview !== null
      ? displayStem(footnote.stem_preview)
      : NOTE_TEXT.footnoteGone;
  return `[^${footnote.number}] ${footnote.label} — ${tail}`;
}

/** Whether a footnote line links its question (a CONFIRMED question of the chapter). */
export function footnoteLinks(footnote: NoteFootnote): footnote is NoteFootnote & {
  question_id: string;
} {
  return footnote.question_id !== null && footnote.stem_preview !== null;
}

/**
 * What the member panel shows for a loaded state (docs/screens/chapter-notes.md "화면 상태").
 * The note and the generation status are independent: a running or failed generation keeps the
 * previous note visible.
 */
export interface NoteView {
  /** `noQuestions`: no confirmed question and no note; `empty`: questions but no note yet. */
  readonly kind: 'note' | 'empty' | 'noQuestions';
  readonly generating: boolean;
  readonly failed: boolean;
  /** `정리 노트 만들기` (no note yet) is offered. */
  readonly canCreate: boolean;
  /** `다시 만들기` (a note exists) is offered. */
  readonly canRegenerate: boolean;
  /** `다시 시도` in the failure alert is offered. */
  readonly canRetry: boolean;
  /** Creating is offered but this environment has the feature off (shown disabled + reason). */
  readonly createDisabled: boolean;
  /** The shown note is an older version than the newest. */
  readonly previous: boolean;
}

export function noteView(state: ChapterNoteState, canEdit: boolean): NoteView {
  const generating = isActive(state.generation);
  const failed = state.generation?.status === 'failed';
  const hasQuestions = state.confirmed_question_count > 0;
  const kind = state.note ? 'note' : hasQuestions ? 'empty' : 'noQuestions';
  const actions = canEdit && hasQuestions && !generating;
  const newest = state.versions[0]?.version;
  return {
    kind,
    generating,
    failed,
    canCreate: actions && kind === 'empty' && !failed,
    canRegenerate: actions && kind === 'note' && !failed,
    canRetry: actions && failed,
    createDisabled: !state.available,
    previous: state.note !== null && newest !== undefined && state.note.version !== newest,
  };
}

/** The Heatmap header's "만드는 중" chapters from the workspace list. */
export function generatingChapters(list: ChapterNoteList | null): ReadonlySet<string> {
  return new Set((list?.items ?? []).filter((i) => i.generating).map((i) => i.chapter_id));
}

// --- item text: paragraphs, lists and emphasis only ---------------------------------------------

export type InlinePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly text: string };

const EMPHASIS = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|__([^_\n]+)__|_([^_\n]+)_/g;

/**
 * Item text as plain text with `**strong**` / `*em*` (and `__`/`_`) emphasis. Everything else —
 * HTML, links, images — stays literal text (React escapes it).
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const at = m.index;
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) });
    const strong = m[1] ?? m[3];
    parts.push(
      strong !== undefined
        ? { kind: 'strong', text: strong }
        : { kind: 'em', text: m[2] ?? m[4] ?? '' },
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

// --- CHNOTE-02 reading tools --------------------------------------------------------------------

/** Highlight block name of note item `sections[s].items[i]` (the API's anchor `block`). */
export function noteItemBlock(section: number, item: number): string {
  return `s${section}.i${item}`;
}

export interface PlainText {
  /** The item text as shown: emphasis delimiters (`**`, `*`, `__`, `_`) removed. */
  readonly text: string;
  readonly emphasis: readonly { start: number; end: number; kind: 'strong' | 'em' }[];
  /** For each character of `text`, its index in the raw item text. */
  readonly rawIndex: readonly number[];
}

/** Item text as shown (emphasis marks removed) with the emphasis ranges over it. */
export function plainItemText(text: string): PlainText {
  let out = '';
  const emphasis: { start: number; end: number; kind: 'strong' | 'em' }[] = [];
  const rawIndex: number[] = [];
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i++) rawIndex.push(i);
    out += text.slice(from, to);
  };
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    copy(last, m.index);
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const delimiter = (m[0].length - inner.length) / 2;
    const start = out.length;
    copy(m.index + delimiter, m.index + delimiter + inner.length);
    const strong = m[1] !== undefined || m[3] !== undefined;
    emphasis.push({ start, end: out.length, kind: strong ? 'strong' : 'em' });
    last = m.index + m[0].length;
  }
  copy(last, text.length);
  return { text: out, emphasis, rawIndex };
}

/**
 * A highlight range in raw item text (the API's anchor offsets: `**`/`*` delimiters included) as
 * a range of the shown text. An end inside a delimiter snaps to the nearest shown character; a
 * range that covers delimiters only is null.
 */
export function rawRangeToPlain(
  plain: PlainText,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const from = plain.rawIndex.findIndex((r) => r >= start);
  const to = plain.rawIndex.filter((r) => r < end).length;
  if (from === -1 || to <= from) return null;
  return { start: from, end: to };
}

/**
 * The inverse: a range of the shown text as raw item text offsets, for creating a highlight from
 * a selection (the API anchors raw item text).
 */
export function plainRangeToRaw(
  plain: PlainText,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const first = plain.rawIndex[start];
  const last = plain.rawIndex[end - 1];
  if (end <= start || first === undefined || last === undefined) return null;
  return { start: first, end: last + 1 };
}

const PREVIEW_TYPES: Readonly<Record<QuestionPreview['question_type'], string>> = {
  MCQ: '객관식',
  SHORT_ANSWER: '단답형',
  ESSAY: '서술형',
};

/** Footnote preview heading: "12번 · 객관식". */
export function previewHeading(preview: QuestionPreview): string {
  return `${preview.number_label} · ${PREVIEW_TYPES[preview.question_type]}`;
}

/**
 * Note highlights of the shown version, where they are drawn now, in shown-text offsets (the API
 * anchors raw item text). Highlights of unknown blocks or of delimiters only are left out.
 */
export function noteHighlightsOf(
  items: readonly MyHighlight[],
  noteId: string,
  sections: readonly NoteSection[],
): { id: string; block: string; start: number; end: number; color: MyHighlight['color'] }[] {
  const plain = new Map<string, PlainText>();
  sections.forEach((section, s) =>
    section.items.forEach((item, i) => plain.set(noteItemBlock(s, i), plainItemText(item.text))),
  );
  return items.flatMap((h) => {
    if (h.target.kind !== 'note' || h.target.chapter_note_id !== noteId) return [];
    const at = h.anchor_current ?? h.anchor;
    const text = plain.get(at.block);
    const range = text ? rawRangeToPlain(text, at.start, at.end) : null;
    return range ? [{ id: h.id, block: at.block, ...range, color: h.color }] : [];
  });
}
