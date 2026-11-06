'use client';

// The Markdown of an AI answer (UX12-ASKMD, docs/screens/ux12-ask-markdown.md) with its footnotes,
// or streaming tags, in place of `[n]`: the AI 질문 answer and the AI 해설 body. Everything here is a
// React element made from lib/ask/markdown.ts's allow list; the model's text is never HTML.
import { Fragment, useMemo, type ReactNode } from 'react';
import { parseAnswerMarkdown, type Block, type Inline, type ListItem } from '@/lib/ask/markdown';
import { splitFootnotes } from '@/lib/ask/model';
import tableStyles from '@/components/shared/printed-table.module.css';
import styles from './ask.module.css';

const ALIGN_CLASS = { center: styles.alignCenter, right: styles.alignRight } as const;

function alignClass(align: 'left' | 'center' | 'right' | null | undefined): string | undefined {
  return align === 'center' || align === 'right' ? ALIGN_CLASS[align] : undefined;
}

function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.text;
      return node.kind === 'break' ? ' ' : plainText(node.children);
    })
    .join('');
}

function HeadingBlock({
  level,
  children,
}: {
  readonly level: number;
  readonly children: ReactNode;
}) {
  const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
  return <Tag>{children}</Tag>;
}

export function AnswerMarkdown({
  text,
  sourceNumbers,
  renderCite,
  headingLevel = 3,
}: {
  readonly text: string;
  /** The answer's validated footnotes; null while it streams. */
  readonly sourceNumbers: ReadonlySet<number> | null;
  readonly renderCite: (n: number) => ReactNode;
  /** The element level of the answer's top heading, after the headings around it. */
  readonly headingLevel?: number;
}) {
  const blocks = useMemo(
    () =>
      parseAnswerMarkdown(text, {
        streaming: sourceNumbers === null,
        headingBase: headingLevel,
      }),
    [text, sourceNumbers, headingLevel],
  );

  const words = (value: string): ReactNode =>
    splitFootnotes(value, sourceNumbers).map((part, i) =>
      part.kind === 'text' ? (
        <Fragment key={i}>{part.text}</Fragment>
      ) : part.kind === 'tag' ? (
        <span key={i} className={styles.tag}>
          [{part.number}]
        </span>
      ) : (
        <Fragment key={i}>{renderCite(part.number)}</Fragment>
      ),
    );

  const inline = (nodes: readonly Inline[], inLink = false): ReactNode =>
    nodes.map((node, i) => {
      switch (node.kind) {
        case 'text':
          return <Fragment key={i}>{inLink ? node.text : words(node.text)}</Fragment>;
        case 'strong':
          return <strong key={i}>{inline(node.children, inLink)}</strong>;
        case 'em':
          return <em key={i}>{inline(node.children, inLink)}</em>;
        case 'del':
          return <del key={i}>{inline(node.children, inLink)}</del>;
        case 'code':
          return <code key={i}>{node.text}</code>;
        case 'break':
          return <br key={i} />;
        case 'link':
          return (
            <a
              key={i}
              className={`${styles.link} qz-focus-ring`}
              href={node.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              aria-label={`${plainText(node.children)} (새 탭에서 열림)`}
            >
              {inline(node.children, true)}
            </a>
          );
      }
    });

  const listItem = (item: ListItem, key: number) => {
    const [first, ...rest] = item.blocks;
    const lead = first?.kind === 'paragraph' ? first : null;
    return (
      <li key={key} className={item.checked === null ? undefined : styles.task}>
        {item.checked === null ? null : (
          <input type="checkbox" disabled checked={item.checked} aria-label={taskLabel(item)} />
        )}
        {lead ? inline(lead.content) : null}
        {(lead ? rest : item.blocks).map(block)}
      </li>
    );
  };

  const block = (node: Block, key: number): ReactNode => {
    switch (node.kind) {
      case 'paragraph':
        return <p key={key}>{inline(node.content)}</p>;
      case 'heading':
        return (
          <HeadingBlock key={key} level={node.level}>
            {inline(node.content)}
          </HeadingBlock>
        );
      case 'rule':
        return <hr key={key} />;
      case 'quote':
        return <blockquote key={key}>{node.blocks.map(block)}</blockquote>;
      case 'code':
        return (
          <div
            key={key}
            role="group"
            aria-label="코드"
            // A keyboard user scrolls long lines, so it takes focus.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={`${styles.codeBlock} qz-focus-ring`}
          >
            <pre>
              <code>{node.text}</code>
            </pre>
          </div>
        );
      case 'list':
        return node.ordered ? (
          <ol key={key} start={node.start ?? undefined}>
            {node.items.map(listItem)}
          </ol>
        ) : (
          <ul key={key}>{node.items.map(listItem)}</ul>
        );
      case 'table':
        return (
          // A group, not a region: an answer can hold many tables, and landmark names must differ.
          <div
            key={key}
            role="group"
            aria-label="표"
            // A keyboard user scrolls a wide table, so it takes focus.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={`${tableStyles.tableScroll} qz-focus-ring`}
          >
            <table className={tableStyles.table}>
              <thead>
                <tr>
                  {node.header.map((cell, c) =>
                    // Table rows and cells have no ids; their position is their identity.
                    cell.length === 0 ? (
                      <td key={c} />
                    ) : (
                      <th key={c} scope="col" className={alignClass(node.align[c])}>
                        {inline(cell)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className={alignClass(node.align[c])}>
                        {inline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  };

  return <div className={styles.markdown}>{blocks.map(block)}</div>;
}

const taskLabel = (item: ListItem) => (item.checked ? '완료' : '미완료');
