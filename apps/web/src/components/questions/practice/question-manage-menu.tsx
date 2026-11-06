'use client';

// The practice panel's header menu (docs/screens/questions-practice.md "문제 관리" and "정답·해설·이력
// 보기"). Every member gets the read items 정답·해설 보기 and 수정 이력·출처 (UX7-BANK-2: the 문제
// 상세 dialog, QPLAY-01-AC09/AC10). Editors of a non-archived workspace get them in the `문제 관리`
// menu with 편집 (the 문제 편집 dialog), 보관 and 삭제 (both confirm first; QPLAY-01-AC07/AC08/AC11;
// 변형 출제 went with QGEN-01, QGEN-RM); everyone else gets a read-only `문제 정보` menu. The API
// re-checks every write. Dialogs open once the menu has returned focus to its trigger, so closing
// them brings focus back there. UX12-SRCMENU: `원문 보기` is there only with a source region.
// VIEW-RESET: the practice panel's `초기화` is an item here, only while it has something to reset.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  MoreIcon,
} from '@quiz/ui';
import { useRef } from 'react';
import type { QuestionSourceControls } from '../viewer/question-source-preview';
import type { DetailFocus } from '../viewer/question-viewer';

export interface QuestionManageActions {
  readonly onEdit: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
}

export function QuestionManageMenu({
  busy = false,
  onShowDetail,
  onShowSource = null,
  onReset = null,
  manage = null,
}: {
  /** The question is being loaded for the editor, archived or deleted. */
  readonly busy?: boolean;
  /** `trigger`: the menu button, where focus goes back when the dialog closes. */
  readonly onShowDetail: (focus: DetailFocus, trigger: HTMLElement | null) => void;
  /** Opens the 문제 원문 dialog; null = the question has no source region. */
  readonly onShowSource?: QuestionSourceControls['onShowSource'];
  /** Opens the 풀이 기록 초기화 confirm; null = no reset item (VIEW-RESET). */
  readonly onReset?: QuestionSourceControls['onReset'];
  /** Editors of a non-archived workspace: the write items (null = the read-only 문제 정보 menu). */
  readonly manage?: QuestionManageActions | null;
}) {
  const label = manage ? '문제 관리' : '문제 정보';
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 초기화 runs once the menu has handed focus back to its trigger, so cancelling the confirm
  // returns focus there (VIEW-RESET).
  const resetPending = useRef(false);
  function showDetail(focus: DetailFocus) {
    window.setTimeout(() => onShowDetail(focus, triggerRef.current), 0);
  }
  return (
    // Non-modal: a modal menu that opens a dialog can leave the page inert.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          label={label}
          icon={<MoreIcon />}
          aria-busy={busy || undefined}
          disabled={busy}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={label}
        onCloseAutoFocus={() => {
          if (!resetPending.current) return;
          resetPending.current = false;
          if (onReset) window.setTimeout(() => onReset(triggerRef.current), 0);
        }}
      >
        <DropdownMenuItem onSelect={() => showDetail('answers')}>정답·해설 보기</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => showDetail('history')}>수정 이력·출처</DropdownMenuItem>
        {onShowSource ? (
          <DropdownMenuItem
            onSelect={() => window.setTimeout(() => onShowSource(triggerRef.current), 0)}
          >
            원문 보기
          </DropdownMenuItem>
        ) : null}
        {onReset ? (
          <DropdownMenuItem onSelect={() => (resetPending.current = true)}>초기화</DropdownMenuItem>
        ) : null}
        {manage ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={afterClose(manage.onEdit)}>편집</DropdownMenuItem>
            <DropdownMenuItem onSelect={afterClose(manage.onArchive)}>보관</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={afterClose(manage.onDelete)}>
              삭제
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
