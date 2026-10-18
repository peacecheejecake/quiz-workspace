// VariationDiffViewer model (QGEN-01, docs/questions.md §5 "DRAFT with diff vs original"): a
// word-level diff of a generated draft against the source revision it was generated from. Pure,
// so the browser never needs a diff library and the rules are unit-tested.
//
// Words are whitespace-separated tokens (Korean eojeol), which is the unit a reviewer reads; the
// whitespace itself is kept on the segments so the joined text equals the original strings.

export type DiffKind = 'same' | 'insert' | 'delete';

export interface DiffSegment {
  readonly kind: DiffKind;
  readonly text: string;
}

/** Above this many LCS cells the diff falls back to "everything replaced" (very long stems). */
export const MAX_DIFF_CELLS = 400_000;

/** Words with their trailing whitespace (`"a b"` → `["a ", "b"]`); leading space stays first. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|\S+\s*/g) ?? [];
}

function word(token: string): string {
  return token.trim();
}

function push(out: DiffSegment[], kind: DiffKind, text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
  else out.push({ kind, text });
}

/**
 * Word diff of `before` → `after`: `same` runs, `delete` runs (only in `before`) and `insert`
 * runs (only in `after`). Words compare without their surrounding whitespace. Deletions come
 * before the insertions that replace them.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const out: DiffSegment[] = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    push(out, 'delete', before);
    push(out, 'insert', after);
    return out;
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..] (flat array, row-major).
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        word(a[i] ?? '') === word(b[j] ?? '')
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  let deleted = '';
  let inserted = '';
  const flush = () => {
    push(out, 'delete', deleted);
    push(out, 'insert', inserted);
    deleted = '';
    inserted = '';
  };
  while (i < a.length || j < b.length) {
    const ta = a[i];
    const tb = b[j];
    if (ta !== undefined && tb !== undefined && word(ta) === word(tb)) {
      flush();
      // The variant's spacing wins for unchanged words.
      push(out, 'same', tb);
      i++;
      j++;
    } else if (
      tb === undefined ||
      (ta !== undefined && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      deleted += ta ?? '';
      i++;
    } else {
      inserted += tb;
      j++;
    }
  }
  flush();
  return out;
}

/** True when the diff has no insertions or deletions. */
export function unchanged(segments: readonly DiffSegment[]): boolean {
  return segments.every((s) => s.kind === 'same');
}

export interface OptionLike {
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
}

export type OptionChange = 'same' | 'changed' | 'added' | 'removed';

export interface OptionDiff {
  readonly change: OptionChange;
  /** The variant's option (null for a removed one). */
  readonly after: OptionLike | null;
  /** The original option it is compared with (null for an added one). */
  readonly before: OptionLike | null;
  /** Word diff of the texts (`changed` only; otherwise a single run). */
  readonly segments: readonly DiffSegment[];
  /** The option's correctness differs from the original's. */
  readonly answerChanged: boolean;
}

function normalized(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Options of the variant against the original's. An option with the same text (any position) is
 * `same`; otherwise the option at the same position is `changed` (word diff); the rest are
 * `added`, and original options left over are `removed` (listed last). `answerChanged` flags an
 * option whose correctness differs from its original (what an inversion is about).
 */
export function diffOptions(
  before: readonly OptionLike[],
  after: readonly OptionLike[],
): OptionDiff[] {
  const used = new Set<number>();
  const byText = new Map<string, number[]>();
  before.forEach((o, index) => {
    const key = normalized(o.text);
    byText.set(key, [...(byText.get(key) ?? []), index]);
  });
  const matched: (number | null)[] = after.map((o) => {
    const candidates = byText.get(normalized(o.text)) ?? [];
    const index = candidates.find((c) => !used.has(c));
    if (index === undefined) return null;
    used.add(index);
    return index;
  });
  // Unmatched variant options pair with the unmatched original at the same position.
  const positional = after.map((_, index) =>
    matched[index] === null && index < before.length && !used.has(index) ? index : null,
  );
  positional.forEach((index) => {
    if (index !== null) used.add(index);
  });

  const out: OptionDiff[] = after.map((option, index) => {
    const same = matched[index];
    if (same !== null && same !== undefined) {
      const original = before[same] ?? null;
      return {
        change: 'same',
        after: option,
        before: original,
        segments: [{ kind: 'same', text: option.text }],
        answerChanged: original !== null && original.correct !== option.correct,
      };
    }
    const pair = positional[index];
    const original = pair !== null && pair !== undefined ? (before[pair] ?? null) : null;
    if (original) {
      return {
        change: 'changed',
        after: option,
        before: original,
        segments: diffWords(original.text, option.text),
        answerChanged: original.correct !== option.correct,
      };
    }
    return {
      change: 'added',
      after: option,
      before: null,
      segments: [{ kind: 'insert', text: option.text }],
      answerChanged: false,
    };
  });
  before.forEach((option, index) => {
    if (used.has(index)) return;
    out.push({
      change: 'removed',
      after: null,
      before: option,
      segments: [{ kind: 'delete', text: option.text }],
      answerChanged: false,
    });
  });
  return out;
}
