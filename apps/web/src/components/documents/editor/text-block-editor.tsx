'use client';

// TextBlockEditor (DOC-02-AC02): the canonical text of one revision as a list of blocks
// (<article>, the current one aria-current="true"). Editors correct one block at a time inline;
// the save goes to the draft revision with the block's `version` as `base_version`, and a
// conflict shows the server's text next to the user's (blockEditReducer). Readers get the same
// list without any edit control.
import { Badge, Button } from '@quiz/ui';
import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import type { BlockEditState } from '@/lib/documents/block-edit';
import type { ContentBlock } from '@/lib/documents/editor-api';
import { blockPage } from '@/lib/documents/outline';
import styles from './editor.module.css';

export interface TextBlockEditorProps {
  readonly blocks: readonly ContentBlock[];
  readonly currentBlockId: string | null;
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
        <span>{page}쪽</span>
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
        <span>{blockPage(block)}쪽</span>
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

export function TextBlockEditor({
  blocks,
  currentBlockId,
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

  if (blocks.length === 0) {
    return <p className={styles.paneNote}>표시할 원문 텍스트가 없습니다.</p>;
  }

  return (
    <div className={styles.blockList}>
      {blocks.map((block) =>
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
            editDisabled={editLocked || editingId !== null}
            onSelect={onSelect}
            onStartEdit={onStartEdit}
          />
        ),
      )}
    </div>
  );
}
