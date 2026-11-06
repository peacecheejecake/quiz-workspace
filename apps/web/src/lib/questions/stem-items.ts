// STEM-ITEMS (docs/questions.md §4 item 11, QPLAY-01-AC14): exam papers put labelled items
// ("(가) …", "ㄱ. …", "㉠ …") between the question sentence and the numbered options. Imported
// stems may hold them on one line. Screens that show the whole stem find the item list here and
// show it one item per line in a box (제시 항목). Display only: stored stems, revisions, the API,
// fingerprints, search and editor values keep the original text.
//
// Rules: labels of one family and one format, consecutive from the family's first label, at least
// two; any label of that family in the paragraph (any format, the lead included) outside that 1..n
// sequence means no list in that paragraph. Spaces inside brackets are ignored. A label starts the
// text or follows whitespace and is followed by whitespace and content (so "(가)와 (나)에 …" is a
// mention, not a list). Option labels (①~⑳, ❶~❿, ➀~➓) and "1." are never
// item labels. A question sentence before the first item must end with ? . : ) 」 > (or fullwidth
// ？ ： ）) or an empty answer mark ( ) / （ ）, whose mark is not shown. The list runs from the
// first item to a blank line or the end.
import { displayStem, stemParagraphs } from './display-stem';
import { hasStemTable } from './stem-table';

export interface StemItem {
  /** The label as printed ("(가)", "ㄱ.", "㉠"); never renumbered. */
  readonly label: string;
  readonly text: string;
}

export interface StemLayout {
  /** Paragraphs before the list (the question sentence), without its trailing empty answer mark. */
  readonly lead: readonly string[];
  readonly items: readonly StemItem[];
  /** Paragraphs after the blank line that ends the list. */
  readonly trailing: readonly string[];
}

function range(first: string, last: string): string[] {
  const out: string[] = [];
  for (let c = first.codePointAt(0) as number; c <= (last.codePointAt(0) as number); c += 1) {
    out.push(String.fromCodePoint(c));
  }
  return out;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Families whose labels take a format: `(x)`, `（x）`, `x)` or `x.`. */
const FORMATTED: readonly { readonly members: readonly string[]; readonly dot: boolean }[] = [
  { members: [...'가나다라마바사아자차카타파하'], dot: true },
  { members: [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'], dot: true },
  { members: range('A', 'Z'), dot: true },
  { members: range('a', 'z'), dot: true },
  { members: range('Ⅰ', 'Ⅻ'), dot: true },
  { members: range('ⅰ', 'ⅻ'), dot: true },
  { members: ROMAN, dot: true },
  // "1." is the option numbering: arabic items only in brackets or with ")".
  { members: Array.from({ length: 20 }, (_, i) => String(i + 1)), dot: false },
];

/** Families whose label is one enclosed character. */
const ENCLOSED: readonly (readonly string[])[] = [
  range('㉠', '㉭'),
  range('㉮', '㉻'),
  range('㈀', '㈍'),
  range('㈎', '㈛'),
  range('ⓐ', 'ⓩ'),
  range('Ⓐ', 'Ⓩ'),
  range('⑴', '⒇'),
  range('⒜', '⒵'),
];

type Format = 'paren' | 'wide' | 'close' | 'dot' | 'char';

/** One reading of a label: family, format and position in the family. */
interface Reading {
  readonly family: number;
  readonly format: Format;
  readonly index: number;
}

/** Bracket-less core ("가", "12", "XII") → [family, index] of every family that has it. */
const CORES = new Map<string, [number, number][]>();
FORMATTED.forEach(({ members }, family) =>
  members.forEach((m, index) => CORES.set(m, [...(CORES.get(m) ?? []), [family, index]])),
);
const CHARS = new Map<string, Reading>();
ENCLOSED.forEach((members, i) =>
  members.forEach((m, index) =>
    CHARS.set(m, { family: FORMATTED.length + i, format: 'char', index }),
  ),
);

/** The longest core is "VIII". */
const MAX_CORE = 4;
/** A core with a few spaces inside its brackets. */
const MAX_BRACKETED = MAX_CORE + 4;

function isBlank(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

interface Label {
  readonly start: number;
  /** Index after the label. */
  readonly end: number;
  readonly readings: readonly Reading[];
}

function readings(core: string, format: Format): Reading[] {
  return (CORES.get(core) ?? [])
    .filter(([family]) => format !== 'dot' || (FORMATTED[family] as { dot: boolean }).dot)
    .map(([family, index]) => ({ family, format, index }));
}

/** The label at `p`, if `p` starts one (whatever comes after it). */
function labelAt(s: string, p: number): Label | undefined {
  const ch = s[p] as string;
  const char = CHARS.get(ch);
  if (char) return { start: p, end: p + 1, readings: [char] };
  if (ch === '(' || ch === '（') {
    const close = ch === '(' ? ')' : '）';
    const j = s.indexOf(close, p + 1);
    if (j < 0 || j - p - 1 > MAX_BRACKETED) return undefined;
    // Spaces inside the brackets do not count: "( 가 )" reads as "(가)".
    const found = readings(s.slice(p + 1, j).trim(), ch === '(' ? 'paren' : 'wide');
    return found.length > 0 ? { start: p, end: j + 1, readings: found } : undefined;
  }
  let j = p;
  if (/[A-Za-z0-9]/.test(ch)) {
    while (j < s.length && j - p < MAX_CORE && /[A-Za-z0-9]/.test(s[j] as string)) j += 1;
  } else {
    j = p + 1;
  }
  const mark = s[j];
  if (mark !== ')' && mark !== '.') return undefined;
  const found = readings(s.slice(p, j), mark === ')' ? 'close' : 'dot');
  return found.length > 0 ? { start: p, end: j + 1, readings: found } : undefined;
}

/** A line break followed by one or more blank lines (as in display-stem). */
const PARAGRAPH_BREAK = /\r?\n(?:[^\S\r\n]*\r?\n)+/gu;

/** [start, end) of each blank-line-separated block of `s`. */
function blocks(s: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (const m of s.matchAll(PARAGRAPH_BREAK)) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, s.length]);
  return out;
}

/** Labels in `s[start, end)` that sit at a line/word start and are followed by blank + content. */
function labelsIn(s: string, start: number, end: number): Label[] {
  const out: Label[] = [];
  const references = [
    ...s
      .slice(start, end)
      .matchAll(/[（(][^()（）\r\n]+[)）]\s*[~～]\s*[（(][^()（）\r\n]+[)）]/gu),
  ].map((match) => [start + match.index, start + match.index + match[0].length] as const);
  for (let p = start; p < end; p += 1) {
    if (p > start && !isBlank(s[p - 1])) continue;
    if (isBlank(s[p])) continue;
    const label = labelAt(s, p);
    if (!label || label.end >= end || !isBlank(s[label.end])) continue;
    if (s.slice(label.end, end).trim() === '') continue;
    if (references.some(([a, b]) => p >= a && p < b)) continue;
    out.push(label);
  }
  return out;
}

/** Sentence ends before a list, with the fullwidth ？ ： ） (the empty mark is checked apart). */
const SENTENCE_ENDS = new Set(['?', '.', ':', ')', '」', '>', '？', '：', '）']);

/** The question sentence may precede a list: empty, or ending like a sentence or answer mark. */
function leadEnds(lead: string): boolean {
  const text = lead.trimEnd();
  if (text === '') return true;
  return SENTENCE_ENDS.has(text[text.length - 1] as string) || displayStem(text) !== text;
}

function paragraphs(text: string): string[] {
  return text.trim() === '' ? [] : stemParagraphs(text.trim());
}

function has(label: Label, family: number, format: Format, index?: number): boolean {
  return label.readings.some(
    (r) => r.family === family && r.format === format && (index === undefined || r.index === index),
  );
}

/**
 * The list of `family`/`format` in one block's labels: every label of the family in the block, in
 * any format and wherever it is (the lead sentence included), must be exactly the 1..n sequence in
 * that one format, at least two; otherwise none (a stray, repeated or mixed-format label means no
 * list rather than a partial one).
 */
function strictList(labels: readonly Label[], family: number, format: Format): Label[] | null {
  const list = labels.filter((l) => l.readings.some((r) => r.family === family));
  if (list.length < 2 || !list.every((l, k) => has(l, family, format, k))) return null;
  return list;
}

/**
 * The stem's labelled item list with the paragraphs before and after it, or null when the stem
 * has none (it is then shown as before). Takes the stored or the displayed stem: the trailing
 * empty answer marks of the stem and of the question sentence are not shown either way. A stem
 * with a table has none as a whole: labels in cells are no items, so the text around a table is
 * read on its own (`stemSegments`, QTABLE-01).
 */
export function stemItems(stem: string): StemLayout | null {
  if (hasStemTable(stem)) return null;
  const s = displayStem(stem);
  for (const [start, end] of blocks(s)) {
    const labels = labelsIn(s, start, end);
    for (const label of labels) {
      for (const reading of label.readings) {
        if (reading.index !== 0) continue;
        const group = strictList(labels, reading.family, reading.format);
        if (!group || group[0] !== label || !leadEnds(s.slice(0, label.start))) continue;
        const lead = s.slice(0, label.start).trimEnd();
        return {
          lead: lead === '' ? [] : paragraphs(displayStem(lead)),
          items: group.map((item, g) => ({
            label: s.slice(item.start, item.end),
            text: s.slice(item.end, group[g + 1]?.start ?? end).trim(),
          })),
          trailing: paragraphs(s.slice(end)),
        };
      }
    }
  }
  const allBullets: RegExpMatchArray[] = [];
  const sentenceEnd = /[.!?。！？][)）"'’”」』]*\s*$/u;
  for (const candidate of s.matchAll(/(?<!\S)-\s+(?=\S)/gu)) {
    const prefix = s.slice(0, candidate.index);
    const lineStart = prefix.trim() === '' || /\n[^\S\r\n]*$/u.test(prefix);
    const boundary = allBullets.length === 0 ? leadEnds(prefix) : sentenceEnd.test(prefix);
    if (lineStart || boundary) allBullets.push(candidate);
  }
  const firstBullet = allBullets[0]?.index ?? s.length;
  const blockEnd =
    blocks(s).find(([start, end]) => firstBullet >= start && firstBullet < end)?.[1] ?? s.length;
  const bullets = allBullets.filter((bullet) => (bullet.index ?? s.length) < blockEnd);
  const bulletBodies = bullets.map((bullet, i) =>
    s.slice((bullet.index ?? 0) + bullet[0].length, bullets[i + 1]?.index ?? blockEnd).trim(),
  );
  if (
    bullets.length >= 2 &&
    leadEnds(s.slice(0, bullets[0]?.index)) &&
    bulletBodies.every((body) => sentenceEnd.test(body))
  ) {
    const first = bullets[0]?.index ?? 0;
    return {
      lead: paragraphs(displayStem(s.slice(0, first).trimEnd())),
      items: bullets.map((bullet, i) => ({
        label: '-',
        text: bulletBodies[i] ?? '',
      })),
      trailing: paragraphs(s.slice(blockEnd)),
    };
  }
  return null;
}

/** Split only an explicit question answer mark followed by a substantial passage. */
export function stemPassageParagraphs(stem: string): string[] {
  const text = displayStem(stem);
  const match = /[?？]\s*\(\s*\)\s+(?=\S)/u.exec(text);
  if (!match || text.slice(match.index + match[0].length).trim().length < 40) {
    return stemParagraphs(text);
  }
  const boundary = match.index + match[0].length;
  return [
    ...paragraphs(displayStem(text.slice(0, boundary).trimEnd())),
    ...stemParagraphs(text.slice(boundary).trimStart()),
  ];
}
