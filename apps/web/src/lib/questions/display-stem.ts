// UX7-QDISPLAY (docs/questions.md §4 item 10): exam papers end a question with an empty answer
// mark, e.g. "옳은 것은? ( )". Screens show a stem without it; empty parentheses inside the
// sentence are fill-in blanks and stay. Display only: stored stems, editor values and API bodies
// keep the original text.

const OPEN = new Set(['(', '（']);
const CLOSE = new Set([')', '）']);

/** Whitespace, NBSP, ideographic space and zero-width space/BOM. */
function isBlank(ch: string): boolean {
  return /\s/u.test(ch) || ch === '​' || ch === '﻿';
}

/**
 * `stem` without its trailing empty answer marks (`( )`, `（ ）`, `()`, several in a row) and the
 * whitespace around them. A stem without one comes back unchanged; so does a stem that is only
 * marks (shown as stored rather than as nothing). Linear in the length of the stem.
 */
export function displayStem(stem: string): string {
  let end = stem.length;
  let cut = -1;
  for (;;) {
    let i = end;
    while (i > 0 && isBlank(stem[i - 1] as string)) i -= 1;
    if (i === 0 || !CLOSE.has(stem[i - 1] as string)) break;
    let j = i - 1;
    while (j > 0 && isBlank(stem[j - 1] as string)) j -= 1;
    if (j === 0 || !OPEN.has(stem[j - 1] as string)) break;
    end = j - 1;
    cut = end;
  }
  if (cut < 0) return stem;
  let keep = cut;
  while (keep > 0 && isBlank(stem[keep - 1] as string)) keep -= 1;
  return keep === 0 ? stem : stem.slice(0, keep);
}

/** A line break followed by one or more blank (whitespace-only) lines. */
const PARAGRAPH_BREAK = /\r?\n(?:[^\S\r\n]*\r?\n)+/u;

/**
 * UX9-QTYPE: a displayed stem split into paragraphs at blank lines, so the screen sets the gap
 * between paragraphs instead of drawing a full empty line. Single line breaks stay inside their
 * paragraph; empty paragraphs (leading/trailing blank lines) are dropped. A stem without any text
 * comes back as itself.
 */
export function stemParagraphs(stem: string): string[] {
  const paragraphs = stem.split(PARAGRAPH_BREAK).filter((p) => p.trim() !== '');
  return paragraphs.length > 0 ? paragraphs : [stem];
}
