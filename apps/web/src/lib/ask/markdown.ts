// UX12-ASKMD: the Markdown of an AI answer as data (docs/screens/ux12-ask-markdown.md). An allow
// list: whatever is not parsed here stays text, and the renderer only makes React elements, so
// model output can never inject markup. Emphasis uses the DOCSUM pattern rather than CommonMark's
// flanking rules, which leave `**"정답"**은` unbolded; tables split rows as QTABLE-01 does.
// With `streaming`, the unfinished end of the text is shown as if it were closed, or held back.
import { EMPHASIS } from '@/lib/documents/summary';
import { pipeCells } from '@/lib/questions/stem-table';

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'em' | 'del'; readonly children: readonly Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: 'break' };

export type TableAlign = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** A task item's box; null for a plain item. */
  readonly checked: boolean | null;
  readonly blocks: readonly Block[];
}

export type Block =
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: number; readonly content: readonly Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      /** The first number of an ordered list that does not start at 1. */
      readonly start: number | null;
      readonly items: readonly ListItem[];
    }
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly kind: 'rule' };

export interface MarkdownOptions {
  /** The text is still arriving. */
  readonly streaming?: boolean;
  /** The element level of the answer's top heading (the page's next free level). */
  readonly headingBase?: number;
}

interface Context {
  readonly headingBase: number;
  lastHeading: number;
}

const MAX_DEPTH = 8;
/** Spans inside spans; deeper markers stay text, so unclosed markers cannot exhaust the stack. */
const MAX_INLINE_DEPTH = 16;
const MAX_HEADING = 6;

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const UNDERLINE = /^ {0,3}=+[ \t]*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const DELIMITER = /^:?-+:?$/;
/** A last line that is only the start of a block, shown once more of it arrives. */
const PARTIAL_LINE =
  /^\s*(?:[-*+]|\d{1,9}[.)]?|#{1,6}|>|`{1,2}|~{1,2}|=+|[-*_]{2,}|\|[\s:|-]*|[-*+]\s+\[[ xX]?\]?)?\s*$/;
const PARTIAL_DELIMITER = /^[\s|:-]*$/;

const isBlank = (line: string | undefined) => !line?.trim();
const expandTabs = (line: string) =>
  line.replace(/^[ \t]+/, (space) => space.replace(/\t/g, '    '));
const indentOf = (line: string) => /^ */.exec(expandTabs(line))?.[0].length ?? 0;
const dedent = (line: string, width: number) => {
  const expanded = expandTabs(line);
  return expanded.slice(Math.min(width, indentOf(expanded)));
};

/** The fence a line opens: a backtick fence's info string has no backtick. */
function fenceOf(line: string): { readonly indent: number; readonly marker: string } | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  const marker = match[2] as string;
  if (marker.startsWith('`') && match[3]?.includes('`')) return null;
  return { indent: match[1]?.length ?? 0, marker };
}

function closesFence(line: string, marker: string): boolean {
  const body = line.trim();
  return (
    indentOf(line) <= 3 &&
    body.length >= marker.length &&
    [...body].every((char) => char === marker[0])
  );
}

function headingText(line: string): string | null {
  const match = HEADING.exec(line);
  return match?.[2]?.trim() || null;
}

/** A row's raw cells, with or without its outer pipes; null without any pipe. */
function rowCells(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes('|')) return null;
  if (!row.startsWith('|')) row = `|${row}`;
  if (!/(?:^|[^\\])\|$/.test(row) || row === '|') row = `${row}|`;
  return pipeCells(row);
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return left ? 'left' : null;
}

/** The table's alignment when a table starts at `at`. */
function tableAt(lines: readonly string[], at: number): TableAlign[] | null {
  const delimiter = lines[at + 1];
  if (!delimiter?.includes('|')) return null;
  const header = rowCells(lines[at] as string);
  const cells = rowCells(delimiter);
  if (!header || !cells || cells.length !== header.length) return null;
  return cells.every((cell) => DELIMITER.test(cell)) ? cells.map(alignOf) : null;
}

/** The end of a streaming text may become a table: its header, with no full delimiter yet. */
function mayBecomeTable(lines: readonly string[], at: number): boolean {
  if (!(lines[at] as string).trim().startsWith('|')) return false;
  return at === lines.length - 1 || (at === lines.length - 2 && isPartialDelimiter(lines[at + 1]));
}

const isPartialDelimiter = (line: string | undefined) => PARTIAL_DELIMITER.test(line ?? '');

function startsBlock(lines: readonly string[], at: number, nest: boolean): boolean {
  const line = lines[at] as string;
  return (
    fenceOf(line) !== null ||
    headingText(line) !== null ||
    RULE.test(line) ||
    (nest && (QUOTE.test(line) || LIST_ITEM.test(line))) ||
    tableAt(lines, at) !== null
  );
}

function headingLevel(source: number, context: Context): number {
  const { headingBase, lastHeading } = context;
  const ceiling = lastHeading === 0 ? headingBase : lastHeading + 1;
  const level = Math.min(headingBase + source - 1, ceiling, MAX_HEADING);
  context.lastHeading = level;
  return level;
}

/** Paragraph lines as one inline text: a `\n` is a hard break, any other line end a space. */
function joinLines(lines: readonly string[]): string {
  let text = '';
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    const body = line.trim();
    if (last) text += body;
    else if (/\\$/.test(body)) text += `${body.slice(0, -1)}\n`;
    else text += `${body}${line.endsWith('  ') ? '\n' : ' '}`;
  });
  return text;
}

function parseTable(
  lines: readonly string[],
  start: number,
  align: readonly TableAlign[],
  tail: boolean,
  nest: boolean,
): { readonly block: Block; readonly next: number } {
  const width = align.length;
  const cellInline = (raw: string, open: boolean) =>
    parseAnswerInline(raw.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n'), open);
  const header = (rowCells(lines[start] as string) ?? []).map((cell) => cellInline(cell, false));
  const rows: Inline[][][] = [];
  let at = start + 2;
  while (at < lines.length && !isBlank(lines[at]) && !startsBlock(lines, at, nest)) {
    const cells = rowCells(lines[at] as string);
    if (!cells) break;
    const open = tail && lines.slice(at + 1).every(isBlank);
    const kept = cells.slice(0, width);
    const row = kept.map((cell, c) => cellInline(cell, open && c === kept.length - 1));
    while (row.length < width) row.push([]);
    rows.push(row);
    at += 1;
  }
  return { block: { kind: 'table', align, header, rows }, next: at };
}

interface RawItem {
  readonly lines: string[];
}

function parseList(
  lines: readonly string[],
  start: number,
  context: Context,
  tail: boolean,
  depth: number,
): { readonly block: Block; readonly next: number } {
  const first = LIST_ITEM.exec(lines[start] as string) as RegExpExecArray;
  const listIndent = indentOf(lines[start] as string);
  const ordered = /\d/.test(first[2] as string);
  const sameKind = (line: string) => {
    const marker = LIST_ITEM.exec(line);
    return (
      marker !== null &&
      !RULE.test(line) &&
      /\d/.test(marker[2] as string) === ordered &&
      indentOf(line) < listIndent + 2
    );
  };
  const items: RawItem[] = [];
  let offset = 0;
  let at = start;
  while (at < lines.length) {
    const line = lines[at] as string;
    if (sameKind(line)) {
      const marker = LIST_ITEM.exec(line) as RegExpExecArray;
      const spaces = (marker[3] as string).length;
      offset = indentOf(line) + (marker[2] as string).length + (spaces > 4 ? 1 : spaces);
      items.push({ lines: [marker[4] as string] });
      at += 1;
      continue;
    }
    const item = items.at(-1) as RawItem;
    if (isBlank(line)) {
      let next = at + 1;
      while (next < lines.length && isBlank(lines[next])) next += 1;
      const after = lines[next];
      if (after === undefined) {
        at = next;
        break;
      }
      if (indentOf(after) < listIndent + 2 && !sameKind(after)) break;
      if (!sameKind(after)) item.lines.push('');
      at = next;
      continue;
    }
    if (indentOf(line) >= listIndent + 2) {
      item.lines.push(dedent(line, offset));
      at += 1;
      continue;
    }
    if (startsBlock(lines, at, true) || isBlank(item.lines.at(-1))) break;
    item.lines.push(line.trim());
    at += 1;
  }
  const ended = lines.slice(at).every(isBlank);
  const parsed = items.map((item, i): ListItem => {
    const task = TASK.exec(item.lines[0] as string);
    const body = task ? [task[2] ?? '', ...item.lines.slice(1)] : item.lines;
    return {
      checked: task ? task[1] !== ' ' : null,
      blocks: parseBlocks(body, context, tail && ended && i === items.length - 1, depth + 1),
    };
  });
  const number = Number.parseInt(first[2] as string, 10);
  return {
    block: {
      kind: 'list',
      ordered,
      start: ordered && number !== 1 ? number : null,
      items: parsed,
    },
    next: at,
  };
}

function parseBlocks(
  input: readonly string[],
  context: Context,
  tail: boolean,
  depth: number,
): Block[] {
  const lines = tail && PARTIAL_LINE.test(input.at(-1) ?? '') ? input.slice(0, -1) : input;
  const count = lines.length;
  const nest = depth < MAX_DEPTH;
  const blocks: Block[] = [];
  const atEnd = (at: number) => tail && lines.slice(at).every(isBlank);
  let i = 0;
  while (i < count) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < count && !closesFence(lines[i] as string, fence.marker)) {
        code.push(dedent(lines[i] as string, fence.indent));
        i += 1;
      }
      i += 1;
      if (code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const text = heading[2]?.trim();
      if (text) {
        blocks.push({
          kind: 'heading',
          level: headingLevel((heading[1] as string).length, context),
          content: parseAnswerInline(text, atEnd(i + 1)),
        });
      }
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    if (nest && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < count) {
        const quoted = QUOTE.exec(lines[i] as string);
        if (!quoted) break;
        inner.push(quoted[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner, context, atEnd(i), depth + 1) });
      continue;
    }
    if (nest && LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i, context, tail, depth);
      blocks.push(block);
      i = Math.max(next, i + 1);
      continue;
    }
    const align = tableAt(lines, i);
    if (align) {
      const { block, next } = parseTable(lines, i, align, tail, nest);
      blocks.push(block);
      i = Math.max(next, i + 1);
      continue;
    }
    if (tail && mayBecomeTable(lines, i)) break;

    const paragraph: string[] = [];
    while (i < count) {
      const current = lines[i] as string;
      if (paragraph.length > 0) {
        if (isBlank(current) || startsBlock(lines, i, nest)) break;
        if (tail && mayBecomeTable(lines, i)) break;
        if (UNDERLINE.test(current)) break;
      }
      paragraph.push(current);
      i += 1;
    }
    const text = joinLines(paragraph);
    if (i < count && UNDERLINE.test(lines[i] as string)) {
      i += 1;
      blocks.push({
        kind: 'heading',
        level: headingLevel(1, context),
        content: parseAnswerInline(text, atEnd(i)),
      });
    } else {
      blocks.push({ kind: 'paragraph', content: parseAnswerInline(text, atEnd(i)) });
    }
  }
  return blocks;
}

export function parseAnswerMarkdown(markdown: string, options: MarkdownOptions = {}): Block[] {
  const { streaming = false, headingBase = 3 } = options;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines, { headingBase, lastHeading: 0 }, streaming, 0);
}

// --- inline --------------------------------------------------------------------------------------

/** A link is http(s) only and carries no user name: anything else stays text. */
export function safeHref(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

type Hit = { readonly nodes: readonly Inline[]; readonly end: number } | null;

const SPECIAL = /[\\\n`*_~[!<h]/;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;
const WORD = /^[A-Za-z0-9]$/;
const TRIPLE = /(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/y;
const SPAN = new RegExp(EMPHASIS.source, 'y');
const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;
const CITE_LABEL = /^S?\d{1,3}$/;
const PARTIAL_CITE = /^\[S?\d{0,3}$/;
const PARTIAL_LINK = /^\[([^\]]*)\]\([^)]*$/;
const ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/y;

const text = (value: string): Inline => ({ kind: 'text', text: value });

/** A match at `at`. Read its end with `endOf`: recursion reuses these patterns' `lastIndex`. */
function stickyMatch(pattern: RegExp, value: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(value);
}

const endOf = (match: RegExpExecArray) => match.index + match[0].length;

function codeAt(value: string, at: number, open: boolean): Hit {
  let end = at;
  while (value[end] === '`') end += 1;
  const fence = value.slice(at, end);
  for (let i = value.indexOf(fence, end); i !== -1; i = value.indexOf(fence, i + 1)) {
    let close = i;
    while (value[close] === '`') close += 1;
    if (close - i === fence.length) {
      const body = value.slice(end, i).replace(/\n/g, ' ');
      const padded = body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '';
      return { nodes: [{ kind: 'code', text: padded ? body.slice(1, -1) : body }], end: close };
    }
    i = close - 1;
  }
  if (!open) return { nodes: [text(fence)], end };
  const rest = value.slice(end);
  return { nodes: rest ? [{ kind: 'code', text: rest }] : [], end: value.length };
}

function emphasisAt(value: string, at: number, open: boolean, inLink: boolean, depth: number): Hit {
  const char = value[at] as string;
  if (char === '_' && WORD.test(value[at - 1] ?? '')) return null;
  const closed = (end: number) => char !== '_' || !WORD.test(value[end] ?? '');
  const triple = stickyMatch(TRIPLE, value, at);
  if (triple && closed(endOf(triple))) {
    const inner = parseAnswerInline(triple[2] ?? '', false, inLink, depth + 1);
    return {
      nodes: [{ kind: 'strong', children: [{ kind: 'em', children: inner }] }],
      end: endOf(triple),
    };
  }
  const double = value[at + 1] === char;
  const match = stickyMatch(SPAN, value, at);
  if (match && closed(endOf(match)) && (!open || !double || match[1] !== undefined)) {
    const strong = match[1] !== undefined;
    return {
      nodes: [
        {
          kind: strong ? 'strong' : 'em',
          children: parseAnswerInline(
            (strong ? match[2] : match[4]) ?? '',
            false,
            inLink,
            depth + 1,
          ),
        },
      ],
      end: endOf(match),
    };
  }
  if (!open) return null;
  const width = double ? 2 : 1;
  const rest = value.slice(at + width);
  if (rest === '') return { nodes: [], end: value.length };
  if (/^\s/.test(rest)) return null;
  return {
    nodes: [
      {
        kind: double ? 'strong' : 'em',
        children: parseAnswerInline(rest, true, inLink, depth + 1),
      },
    ],
    end: value.length,
  };
}

function strikeAt(value: string, at: number, open: boolean, inLink: boolean, depth: number): Hit {
  if (value[at + 1] !== '~') {
    return open && at === value.length - 1 ? { nodes: [], end: value.length } : null;
  }
  const match = stickyMatch(STRIKE, value, at);
  if (match) {
    return {
      nodes: [
        { kind: 'del', children: parseAnswerInline(match[1] ?? '', false, inLink, depth + 1) },
      ],
      end: endOf(match),
    };
  }
  if (!open) return null;
  const rest = value.slice(at + 2);
  if (rest === '') return { nodes: [], end: value.length };
  return /^\s/.test(rest)
    ? null
    : {
        nodes: [{ kind: 'del', children: parseAnswerInline(rest, true, inLink, depth + 1) }],
        end: value.length,
      };
}

interface LinkSyntax {
  readonly label: string;
  readonly url: string;
  readonly end: number;
}

/** `[label](url "title")` at `at`, by its syntax only. */
function linkSyntaxAt(value: string, at: number): LinkSyntax | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < value.length && close < 0; i += 1) {
    const char = value[i];
    if (char === '\\') i += 1;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) close = i;
    }
  }
  if (close < 0 || value[close + 1] !== '(') return null;
  let i = close + 2;
  while (value[i] === ' ') i += 1;
  const urlStart = i;
  let url: string;
  if (value[i] === '<') {
    const end = value.indexOf('>', i);
    if (end < 0) return null;
    url = value.slice(i + 1, end);
    i = end + 1;
  } else {
    let parens = 0;
    while (i < value.length && !/[\s]/.test(value[i] as string)) {
      if (value[i] === '(') parens += 1;
      if (value[i] === ')') {
        if (parens === 0) break;
        parens -= 1;
      }
      i += 1;
    }
    url = value.slice(urlStart, i);
  }
  const title = /^\s+(?:"[^"]*"|'[^']*')/.exec(value.slice(i));
  if (title) i += title[0].length;
  while (value[i] === ' ') i += 1;
  if (value[i] !== ')') return null;
  return { label: value.slice(at + 1, close), url, end: i + 1 };
}

function linkAt(value: string, at: number, open: boolean, depth: number): Hit {
  const link = linkSyntaxAt(value, at);
  if (link) {
    if (CITE_LABEL.test(link.label)) return null;
    const href = safeHref(link.url);
    if (!href) return { nodes: [text(value.slice(at, link.end))], end: link.end };
    return {
      nodes: [
        { kind: 'link', href, children: parseAnswerInline(link.label, false, true, depth + 1) },
      ],
      end: link.end,
    };
  }
  if (!open) return null;
  const rest = value.slice(at);
  if (PARTIAL_CITE.test(rest)) return { nodes: [], end: value.length };
  const partial = PARTIAL_LINK.exec(rest);
  if (!partial || CITE_LABEL.test(partial[1] ?? '')) return null;
  return { nodes: parseAnswerInline(partial[1] ?? '', false, true, depth + 1), end: value.length };
}

function bareUrlAt(value: string, at: number): Hit {
  if (WORD.test(value[at - 1] ?? '')) return null;
  const match = stickyMatch(BARE_URL, value, at);
  if (!match) return null;
  let url = match[0].replace(/[.,;:!?'"*_~]+$/, '');
  while (url.endsWith(')') && url.split('(').length < url.split(')').length) {
    url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, '');
  }
  const href = safeHref(url);
  return href
    ? { nodes: [{ kind: 'link', href, children: [text(url)] }], end: at + url.length }
    : null;
}

function angleUrlAt(value: string, at: number): Hit {
  const match = stickyMatch(ANGLE_URL, value, at);
  const url = match?.[1];
  const href = url ? safeHref(url) : null;
  return match && href && url
    ? { nodes: [{ kind: 'link', href, children: [text(url)] }], end: endOf(match) }
    : null;
}

function tokenAt(value: string, at: number, open: boolean, inLink: boolean, depth: number): Hit {
  const nestable = depth < MAX_INLINE_DEPTH;
  switch (value[at]) {
    case '\n':
      return { nodes: [{ kind: 'break' }], end: at + 1 };
    case '\\': {
      const next = value[at + 1];
      if (next === undefined) return open ? { nodes: [], end: at + 1 } : null;
      // Its own node: an escaped `\[1\]` must not read as a footnote once joined.
      return ESCAPABLE.test(next) ? { nodes: [text(next)], end: at + 2 } : null;
    }
    case '`':
      return codeAt(value, at, open);
    case '*':
    case '_':
      return nestable ? emphasisAt(value, at, open, inLink, depth) : null;
    case '~':
      return nestable ? strikeAt(value, at, open, inLink, depth) : null;
    case '[':
      return inLink || !nestable ? null : linkAt(value, at, open, depth);
    case '!': {
      if (value[at + 1] !== '[') return null;
      const image = linkSyntaxAt(value, at + 1);
      if (image) return { nodes: [text(value.slice(at, image.end))], end: image.end };
      return open ? { nodes: [text(value.slice(at))], end: value.length } : null;
    }
    case '<':
      return inLink ? null : angleUrlAt(value, at);
    case 'h':
      return inLink ? null : bareUrlAt(value, at);
    default:
      return null;
  }
}

/**
 * Inline nodes of `value`. `open`: the text ends here for now, so unclosed spans run to its end
 * and a marker with nothing after it is dropped. `inLink`: no links inside a link.
 */
export function parseAnswerInline(
  value: string,
  open = false,
  inLink = false,
  depth = 0,
): Inline[] {
  const nodes: Inline[] = [];
  let plain = '';
  let at = 0;
  while (at < value.length) {
    const hit = SPECIAL.test(value[at] as string) ? tokenAt(value, at, open, inLink, depth) : null;
    if (hit) {
      if (plain) nodes.push(text(plain));
      plain = '';
      nodes.push(...hit.nodes);
      at = Math.max(hit.end, at + 1);
    } else {
      plain += value[at];
      at += 1;
    }
  }
  if (plain) nodes.push(text(plain));
  return nodes;
}
