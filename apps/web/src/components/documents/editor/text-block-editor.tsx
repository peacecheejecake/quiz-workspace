'use client';

// TextBlockEditor (DOC-02-AC02): the canonical text of one revision as a list of blocks
// (<article>, the current one aria-current="true"), grouped by the page they start on under an
// `N쪽` heading (DOCVIEW, DOC-02-AC09; the current page's heading is aria-current="page").
// Editors correct one block at a time inline; the save goes to the draft revision with the
// block's `version` as `base_version`, and a conflict shows the server's text next to the user's
// (blockEditReducer). Readers get the same list without any edit control. Each page group is
// memoized: a page change or a selection re-renders only the groups it touches.
import { Badge, Button } from '@quiz/ui';
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { IDLE, type BlockEditState } from '@/lib/documents/block-edit';
import type { ContentBlock } from '@/lib/documents/editor-api';
import { blockPage } from '@/lib/documents/outline';
import { answerLines, optionLabel, QUESTION_TYPE_LABELS } from '@/lib/documents/document-questions';
import { blockPageSpan, type PageGroup, type QuestionItem } from '@/lib/documents/text-groups';
import styles from './editor.module.css';

export interface TextBlockEditorProps {
  /** The revision's blocks grouped by page (lib/documents/text-groups pageGroups). */
  readonly groups: readonly PageGroup[];
  readonly currentBlockId: string | null;
  /** The PDF viewer's current page: its group heading is aria-current="page". */
  readonly currentPage: number;
  readonly canEdit: boolean;
  /** Edits are paused (publish in progress). */
  readonly editLocked: boolean;
  readonly editState: BlockEditState;
  readonly onSelect: (block: ContentBlock) => void;
  readonly onStartEdit: (block: ContentBlock) => void;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

const TYPE_LABELS: Readonly<Record<ContentBlock['type'], string>> = {
  heading: '제목',
  text: '본문',
  table: '표',
  image: '그림',
  formula: '수식',
};

function BlockContent({ block }: { readonly block: ContentBlock }) {
  if (block.type === 'table' && block.table) {
    const { rows, header_rows: headerRows } = block.table;
    return (
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <tbody>
            {rows.map((row, r) => (
              // Table rows and cells have no ids; their position is their identity.
              <tr key={r}>
                {row.map((cell, c) =>
                  r < headerRows ? (
                    <th key={c} scope="col">
                      {cell}
                    </th>
                  ) : (
                    <td key={c}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p
      className={styles.blockText}
      data-type={block.type}
      data-level={block.heading_level ?? undefined}
    >
      {block.text}
    </p>
  );
}

/** The page heading names the first page; only a block running onto later pages says so. */
function PageSpan({ block }: { readonly block: ContentBlock }) {
  const [first, last] = blockPageSpan(block);
  return last > first ? (
    <span>
      {first}–{last}쪽
    </span>
  ) : null;
}

interface BlockItemProps {
  readonly block: ContentBlock;
  readonly current: boolean;
  readonly canEdit: boolean;
  readonly editDisabled: boolean;
  readonly onSelect: (block: ContentBlock) => void;
  readonly onStartEdit: (block: ContentBlock) => void;
}

const BlockItem = memo(function BlockItem({
  block,
  current,
  canEdit,
  editDisabled,
  onSelect,
  onStartEdit,
}: BlockItemProps) {
  const page = blockPage(block);
  return (
    <article
      className={styles.block}
      aria-current={current ? 'true' : undefined}
      data-block-id={block.block_id}
      data-type={block.type}
    >
      <div className={styles.blockMeta}>
        <span className={styles.blockType}>{TYPE_LABELS[block.type]}</span>
        <PageSpan block={block} />
        {block.edited ? <Badge tone="accent">수정됨</Badge> : null}
        <span className={styles.blockActions}>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${page}쪽 원문 위치 보기`}
            onClick={() => onSelect(block)}
          >
            위치
          </Button>
          {canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStartEdit(block)}
              disabled={editDisabled}
            >
              편집
            </Button>
          ) : null}
        </span>
      </div>
      {/* Pointer shortcut for the "위치" button above (keyboard users use that button). */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className={styles.blockBody} onClick={() => onSelect(block)}>
        <BlockContent block={block} />
      </div>
    </article>
  );
});

interface EditingItemProps {
  readonly block: ContentBlock;
  readonly current: boolean;
  readonly state: Exclude<BlockEditState, { phase: 'idle' }>;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

function EditingItem({ block, current, state, onChange, onSave, onCancel }: EditingItemProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const saving = state.phase === 'saving';
  const failure = state.phase === 'editing' ? state.failure : undefined;
  const conflict = state.phase === 'editing' ? state.conflict : undefined;
  const fieldId = `block-edit-${block.block_id}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !saving) {
      event.preventDefault();
      onSave();
    }
  };

  return (
    <article
      className={styles.block}
      aria-current={current ? 'true' : undefined}
      data-block-id={block.block_id}
      data-editing="true"
    >
      <div className={styles.blockMeta}>
        <span className={styles.blockType}>{TYPE_LABELS[block.type]}</span>
        <PageSpan block={block} />
        <span>편집 중</span>
      </div>
      <label htmlFor={fieldId} className={styles.fieldLabel}>
        블록 텍스트
      </label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        className={styles.blockField}
        value={state.text}
        rows={Math.min(Math.max(state.text.split('\n').length + 2, 4), 16)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        readOnly={saving}
        aria-describedby={failure ? `${hintId} ${errorId}` : hintId}
        aria-invalid={failure ? true : undefined}
      />
      <p id={hintId} className={styles.fieldHint}>
        {block.type === 'table' ? '표는 한 줄에 한 행, 칸은 | 로 구분합니다. ' : ''}
        저장하면 초안에 반영되고, 발행해야 검색에 쓰입니다. PDF 원본은 바뀌지 않습니다.
      </p>
      {failure ? (
        <div id={errorId} role="alert" className={styles.inlineAlert}>
          <p>{failure.message}</p>
          {conflict ? (
            <>
              <p className={styles.conflictLabel}>현재 저장된 내용:</p>
              <blockquote className={styles.conflictText}>{conflict.serverText}</blockquote>
              <p>내 수정 내용으로 덮어쓰려면 다시 저장하고, 저장된 내용을 유지하려면 취소하세요.</p>
            </>
          ) : null}
        </div>
      ) : null}
      <div className={styles.editActions}>
        <Button variant="primary" size="sm" onClick={onSave} loading={saving}>
          저장
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          취소
        </Button>
      </div>
    </article>
  );
}

interface QuestionCardProps {
  readonly item: QuestionItem;
  readonly currentBlockId: string | null;
  readonly renderBlock: (block: ContentBlock) => ReactNode;
  /** One of its source blocks is being edited: the source blocks stay open. */
  readonly editingInside: boolean;
  readonly onSelect: (block: ContentBlock) => void;
}

/**
 * DOC-02-AC11: a confirmed imported question in question format — number, type, stem and the
 * options in their registered order — with the answer and explanation folded away until asked
 * for, and the source blocks (correctable by editors) behind `원문 블록 보기`.
 */
function QuestionCard({
  item,
  currentBlockId,
  renderBlock,
  editingInside,
  onSelect,
}: QuestionCardProps) {
  const { question, blocks } = item;
  const [answerOpen, setAnswerOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const id = useId();
  const showSource = sourceOpen || editingInside;
  const title = question.number !== null ? `${question.number}번 문제` : '문제';
  const holdsCurrent = currentBlockId !== null && blocks.some((b) => b.block_id === currentBlockId);
  const first = blocks[0];
  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      className={styles.questionCard}
      // The selection is marked on the card while its source blocks are folded, else on the block.
      aria-current={holdsCurrent && !showSource ? 'true' : undefined}
      data-block-ids={blocks.map((b) => b.block_id).join(' ')}
    >
      <div className={styles.blockMeta}>
        <span id={`${id}-title`} className={styles.questionTitle}>
          {title}
        </span>
        <span>{QUESTION_TYPE_LABELS[question.type]}</span>
        {first ? <PageSpan block={first} /> : null}
        <span className={styles.blockActions}>
          {first ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${title} 원문 위치 보기`}
              onClick={() => onSelect(first)}
            >
              위치
            </Button>
          ) : null}
        </span>
      </div>
      <p className={styles.questionStem}>{question.stem}</p>
      {question.options.length > 0 ? (
        <ol className={styles.optionList} aria-label="보기">
          {question.options.map((option, index) => (
            <li key={option.id} className={styles.option}>
              <span className={styles.optionLabel}>{optionLabel(index)}</span>
              <span>{option.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className={styles.questionActions}>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={answerOpen}
          aria-controls={`${id}-answer`}
          onClick={() => setAnswerOpen((open) => !open)}
        >
          정답·해설 보기
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showSource}
          aria-controls={`${id}-source`}
          onClick={() => setSourceOpen((open) => !open)}
          disabled={editingInside}
        >
          원문 블록 보기 ({blocks.length})
        </Button>
      </div>
      {answerOpen ? (
        <div id={`${id}-answer`} className={styles.answer}>
          {answerLines(question).map((line, index) => (
            // Lines have no ids; their order is their identity.
            <p key={index}>{line}</p>
          ))}
        </div>
      ) : null}
      {showSource ? (
        <div id={`${id}-source`} className={styles.questionSource}>
          {blocks.map((block) => renderBlock(block))}
        </div>
      ) : null}
    </div>
  );
}

interface PageGroupViewProps {
  readonly group: PageGroup;
  readonly current: boolean;
  /** The selection when it is in this group, else null (so other groups do not re-render). */
  readonly currentBlockId: string | null;
  readonly canEdit: boolean;
  readonly editLocked: boolean;
  /** Another block (in any group) is being edited: no second edit. */
  readonly editingAny: boolean;
  /** The edit state when the edited block is in this group, else IDLE. */
  readonly editState: BlockEditState;
  readonly onSelect: (block: ContentBlock) => void;
  readonly onStartEdit: (block: ContentBlock) => void;
  readonly onChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

const PageGroupView = memo(function PageGroupView({
  group,
  current,
  currentBlockId,
  canEdit,
  editLocked,
  editingAny,
  editState,
  onSelect,
  onStartEdit,
  onChange,
  onSave,
  onCancel,
}: PageGroupViewProps) {
  const headingId = `text-page-${group.page}`;
  const editingId = editState.phase === 'idle' ? null : editState.blockId;
  const renderBlock = (block: ContentBlock) =>
    canEdit && editState.phase !== 'idle' && block.block_id === editingId ? (
      <EditingItem
        key={block.block_id}
        block={block}
        current={block.block_id === currentBlockId}
        state={editState}
        onChange={onChange}
        onSave={onSave}
        onCancel={onCancel}
      />
    ) : (
      <BlockItem
        key={block.block_id}
        block={block}
        current={block.block_id === currentBlockId}
        canEdit={canEdit}
        editDisabled={editLocked || editingAny}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
      />
    );
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={styles.pageGroup}
      data-page-group={group.page}
    >
      <h3 id={headingId} className={styles.pageHeading} aria-current={current ? 'page' : undefined}>
        {group.page}쪽
      </h3>
      {group.items.map((item) =>
        item.kind === 'question' ? (
          <QuestionCard
            key={`q-${item.question.id}`}
            item={item}
            currentBlockId={currentBlockId}
            renderBlock={renderBlock}
            editingInside={editingId !== null && item.blocks.some((b) => b.block_id === editingId)}
            onSelect={onSelect}
          />
        ) : (
          renderBlock(item.block)
        ),
      )}
    </div>
  );
});

/** Memoized: the screen re-renders on every page change, the text only when its props change. */
export const TextBlockEditor = memo(function TextBlockEditor({
  groups,
  currentBlockId,
  currentPage,
  canEdit,
  editLocked,
  editState,
  onSelect,
  onStartEdit,
  onChange,
  onSave,
  onCancel,
}: TextBlockEditorProps) {
  const editingId = editState.phase === 'idle' ? null : editState.blockId;

  if (groups.length === 0) {
    return <p className={styles.paneNote}>표시할 원문 텍스트가 없습니다.</p>;
  }

  return (
    <div className={styles.blockList}>
      {groups.map((group) => (
        <PageGroupView
          key={group.page}
          group={group}
          current={group.page === currentPage}
          currentBlockId={
            currentBlockId !== null && group.blockIds.has(currentBlockId) ? currentBlockId : null
          }
          canEdit={canEdit}
          editLocked={editLocked}
          editingAny={editingId !== null}
          editState={editingId !== null && group.blockIds.has(editingId) ? editState : IDLE}
          onSelect={onSelect}
          onStartEdit={onStartEdit}
          onChange={onChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
});
