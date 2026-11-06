// UX12-PASSAGE (docs/questions.md §4 12): flattened stems can hold "<제목>" passages after the
// question sentence. Screens that show the whole stem find them here and show each in its own box,
// with its `∙` items and ` - ` sub-items on lines. Display only, like STEM-ITEMS.
//
// Mirrors `_passage_parts` in packages/core/src/book_core/question/labels.py;
// tests/fixtures/stem-passages.json holds their shared cases.
import { displayStem } from './display-stem';
import { itemListStart, leadEnds, paragraphs } from './stem-items';

export interface StemPassageLine {
  /** The marker as printed ("∙", "-"). */
  readonly marker: string;
  readonly text: string;
  readonly subs: readonly { readonly marker: string; readonly text: string }[];
}

export interface StemPassage {
  /** The heading as printed, brackets included. */
  readonly heading: string;
  /** Text before the first item; empty when there is none. */
  readonly intro: string;
  readonly lines: readonly StemPassageLine[];
}

export interface StemPassageLayout {
  /** Paragraphs before the first passage (the question sentence). */
  readonly lead: readonly string[];
  readonly passages: readonly StemPassage[];
  /** What follows the passages, read as any stem text (the item list, trailing paragraphs). */
  readonly rest: string;
}

/** `<…>`, `〈…〉`, `＜…＞` or `[…]`, on one line, 40 characters at most, then a blank and content. */
const HEADING =
  /(?<!\S)(?:<[^\s<>](?:[^<>\r\n]{0,38}[^\s<>])?>|〈[^\s〈〉](?:[^〈〉\r\n]{0,38}[^\s〈〉])?〉|＜[^\s＜＞](?:[^＜＞\r\n]{0,38}[^\s＜＞])?＞|\[[^\s[\]](?:[^[\]\r\n]{0,38}[^\s[\]])?\])(?=\s+\S)/gu;
/** A particle word after the bracket ("<보기> 에 대한"): the bracket is a mention. */
const PARTICLE = /^(?:은|는|이|가|을|를|의|에|에서|에게|와|과|로|으로|도|만|및|중)(?=[\s,.]|$)/u;
const BLANK_LINE = /\r?\n(?:[^\S\r\n]*\r?\n)+/u;
const BULLETS = '∙•·ㆍ';
const SENTENCE_END = /[.!?。！？][)）"'’”」』]*\s*$/u;
const AT_LINE_START = /\n[^\S\r\n]*$/u;
const ENDS_QUESTION = /[?？](?:\s*[(（]\s*[)）])*\s*$/u;
/** "이름 : 값" right after a ` - `; `10:30` is no name. */
const NAME_VALUE = /^\s*[^\n∙•·ㆍ:：-]{1,30}(?<!\d)[:：]\s*\S/u;

interface Heading {
  readonly start: number;
  readonly end: number;
}

/** The headings of the passages that run on from the first one, in order. */
function passageHeadings(s: string, afterTable: boolean): Heading[] {
  const found: Heading[] = [];
  for (const match of s.matchAll(HEADING)) {
    const start = match.index;
    const end = start + match[0].length;
    const next = s.slice(end).trimStart();
    if (PARTICLE.test(next)) continue;
    const bulletNext = BULLETS.includes(next[0] as string);
    if (match[0].startsWith('[') && !bulletNext) continue;
    const last = found[found.length - 1];
    if (!last) {
      const lead = s.slice(0, start);
      if (lead.trim() === '' ? afterTable : leadEnds(lead)) found.push({ start, end });
      continue;
    }
    const body = s.slice(last.end, start);
    if (body.trim() === '') continue;
    const blank = BLANK_LINE.exec(body);
    if (blank && body.slice(blank.index).trim() !== '') break;
    if (blank || AT_LINE_START.test(body) || SENTENCE_END.test(body) || bulletNext) {
      found.push({ start, end });
    }
  }
  return found;
}

interface Marker {
  readonly start: number;
  readonly char: string;
  /** Inline ` - ` taken for its "이름 : 값" shape alone. */
  readonly named: boolean;
}

/** The item markers of a trimmed passage body: only at item boundaries (questions.md §4 12). */
function passageMarkers(body: string): Marker[] {
  const out: Marker[] = [];
  let bullet: string | null = null;
  for (const match of body.matchAll(/[∙•·ㆍ]|(?<!\S)-(?=\s)/gu)) {
    const start = match.index;
    const char = match[0];
    const before = body.slice(0, start);
    const after = body.slice(start + 1);
    if (after.trim() === '') continue;
    const atLine = before === '' || AT_LINE_START.test(before);
    let named = false;
    if (!atLine) {
      if (!/\s$/u.test(before)) continue;
      if (char === '-') {
        if (/^\s*\d/u.test(after)) continue;
        if (!SENTENCE_END.test(before)) {
          if (!NAME_VALUE.test(after)) continue;
          named = true;
        }
      } else {
        if (/\d\s*$/u.test(before) && /^\s*\d/u.test(after)) continue;
        const opens = bullet === null && (SENTENCE_END.test(before) || /[:：]\s*$/u.test(before));
        if (char !== bullet && !opens) continue;
      }
    }
    if (char !== '-') bullet ??= char;
    out.push({ start, char, named });
  }
  // Sub-items come in groups: a lone ` - 이름 : 값` is a range, `월요일 - 금요일 : 휴무`.
  return out.filter((m, i) => !m.named || out[i - 1]?.char === '-' || out[i + 1]?.char === '-');
}

function passage(heading: string, rawBody: string): StemPassage {
  const body = rawBody.trim();
  const markers = passageMarkers(body);
  const lines: { marker: string; text: string; subs: { marker: string; text: string }[] }[] = [];
  markers.forEach(({ start, char }, i) => {
    const text = body.slice(start + 1, markers[i + 1]?.start ?? body.length).trim();
    const parent = lines[lines.length - 1];
    if (char === '-' && parent && parent.marker !== '-') parent.subs.push({ marker: char, text });
    else lines.push({ marker: char, text, subs: [] });
  });
  return { heading, intro: body.slice(0, markers[0]?.start ?? body.length).trim(), lines };
}

/**
 * The stem's passages with the text before and after them, or null without a passage (the stem is
 * then read as before). `afterTable`: the text follows a table in the stem, so nothing need come
 * before the first heading.
 */
export function stemPassageLayout(
  stem: string,
  { afterTable = false }: { readonly afterTable?: boolean } = {},
): StemPassageLayout | null {
  const s = displayStem(stem);
  const headings = passageHeadings(s, afterTable);
  const last = headings[headings.length - 1];
  if (!last) return null;
  const tail = s.length - s.slice(last.end).trimStart().length;
  const blank = BLANK_LINE.exec(s.slice(tail));
  const tailEnd = blank ? tail + blank.index : s.length;
  const list = itemListStart(s.slice(tail, tailEnd));
  const end = list === null ? tailEnd : tail + list;
  // A heading with no body is no passage: "<보기>" right above an item list.
  if (end === tail) headings.pop();
  const first = headings[0];
  if (!first) return null;
  const bodies = headings.map((h, i) => s.slice(h.end, headings[i + 1]?.start ?? end));
  if (bodies.some((body) => ENDS_QUESTION.test(body))) return null;
  return {
    lead: paragraphs(displayStem(s.slice(0, first.start).trimEnd())),
    passages: headings.map((h, i) => passage(s.slice(h.start, h.end), bodies[i] as string)),
    rest: s.slice(end).trim(),
  };
}
