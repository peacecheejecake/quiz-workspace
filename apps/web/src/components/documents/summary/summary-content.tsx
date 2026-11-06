'use client';

// The summary itself (DOCSUM-01 "레이아웃 및 컴포넌트"), shared by the member panel and the share
// guest's panel: the meta line "<발행 시각> 발행본 기준 · 장 n개", `전체 요약` (h3) with its body and
// `핵심` list, and `장별 요약` (h3) with one disclosure per top-level chapter (title + page range,
// collapsed at first). Key points end with a page link (`p.12–14`, named "12–14쪽 열기"): the member
// panel opens it in place (UX12-SOURCE), a share guest goes to the shared document. Bodies are the Markdown subset rendered as React elements;
// nothing from the model is ever inserted as HTML or used as a URL.
import { ChevronDownIcon } from '@quiz/ui';
import Link from 'next/link';
import { Fragment, useId, useState, type ReactNode } from 'react';
import {
  pageLinkLabel,
  pageRangeText,
  type PageRange,
  parseSummaryMarkdown,
  summaryMetaLine,
  type ChapterSummary,
  type InlineNode,
  type SummaryContent,
  type SummaryUnit,
} from '@/lib/documents/summary';
import styles from './summary.module.css';

export interface SummaryContentViewProps {
  readonly content: SummaryContent;
  /** The shared document at `page`, for a guest. */
  readonly pageHref?: (page: number) => string;
  /** The member panel's 원본 PDF dialog at `page`. */
  readonly onOpenPage?: (page: number) => void;
}

type PageLinks = Pick<SummaryContentViewProps, 'pageHref' | 'onOpenPage'>;

export function SummaryContentView({ content, ...links }: SummaryContentViewProps) {
  const overallId = useId();
  const chaptersId = useId();
  return (
    <div className={styles.content}>
      <p className={styles.meta}>{summaryMetaLine(content)}</p>
      <section className={styles.section} aria-labelledby={overallId}>
        <h3 id={overallId} className={styles.heading}>
          전체 요약
        </h3>
        <UnitBody unit={content.document} links={links} />
      </section>
      <section className={styles.section} aria-labelledby={chaptersId}>
        <h3 id={chaptersId} className={styles.heading}>
          장별 요약
        </h3>
        {content.chapters.length === 0 ? (
          <p className={styles.note}>요약할 장이 없습니다.</p>
        ) : (
          <ul className={styles.chapters}>
            {content.chapters.map((chapter) => (
              <li key={chapter.section_key}>
                <ChapterDisclosure chapter={chapter} links={links} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ChapterDisclosure({
  chapter,
  links,
}: {
  readonly chapter: ChapterSummary;
  readonly links: PageLinks;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <div className={styles.chapter}>
      <button
        type="button"
        className={`${styles.chapterToggle} qz-focus-ring`}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.chapterTitle}>{chapter.title}</span>{' '}
        {chapter.page_from !== null ? (
          <span className={styles.chapterPages}>
            {pageRangeText({ from: chapter.page_from, to: chapter.page_to ?? chapter.page_from })}
          </span>
        ) : null}
        <ChevronDownIcon className={styles.chevron} aria-hidden="true" />
      </button>
      <div id={regionId} className={styles.chapterBody} hidden={!open}>
        {open ? <UnitBody unit={chapter} links={links} /> : null}
      </div>
    </div>
  );
}

function UnitBody({ unit, links }: { readonly unit: SummaryUnit; readonly links: PageLinks }) {
  const keyPointsId = useId();
  if (!unit.summary_md.trim() && unit.key_points.length === 0) {
    return <p className={styles.note}>요약할 본문이 없습니다.</p>;
  }
  return (
    <div className={styles.unit}>
      <SummaryMarkdown markdown={unit.summary_md} />
      {unit.key_points.length > 0 ? (
        <>
          <h4 id={keyPointsId} className={styles.subheading}>
            핵심
          </h4>
          <ul aria-labelledby={keyPointsId} className={styles.keyPoints}>
            {unit.key_points.map((point, i) => (
              <li key={i}>
                <span>{point.text}</span>
                {point.pages ? (
                  <>
                    {' '}
                    <PageLink pages={point.pages} links={links} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PageLink({ pages, links }: { readonly pages: PageRange; readonly links: PageLinks }) {
  const { pageHref, onOpenPage } = links;
  const className = `${styles.pageLink} qz-focus-ring`;
  const label = pageLinkLabel(pages);
  if (onOpenPage) {
    return (
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => onOpenPage(pages.from)}
      >
        {pageRangeText(pages)}
      </button>
    );
  }
  if (!pageHref) return <span>{pageRangeText(pages)}</span>;
  return (
    <Link href={pageHref(pages.from)} className={className} aria-label={label}>
      {pageRangeText(pages)}
    </Link>
  );
}

export function SummaryMarkdown({ markdown }: { readonly markdown: string }) {
  const blocks = parseSummaryMarkdown(markdown);
  if (blocks.length === 0) return null;
  return (
    <div className={styles.markdown}>
      {blocks.map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i}>{inline(block.content)}</p>
        ) : block.ordered ? (
          <ol key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function inline(nodes: readonly InlineNode[]): ReactNode {
  return nodes.map((node, i) =>
    node.kind === 'text' ? (
      <Fragment key={i}>{node.text}</Fragment>
    ) : node.kind === 'strong' ? (
      <strong key={i}>{inline(node.children)}</strong>
    ) : (
      <em key={i}>{inline(node.children)}</em>
    ),
  );
}
