'use client';

import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@quiz/ui';

/**
 * The header's `문제` menu (UX4): 문제 PDF 관리 dialog, 직접 추가 (the QBANK-01 문제 등록 editor)
 * and 변형 출제 (the 문제 생성 dialog); the last two need edit rights. A dialog opens once the menu
 * has returned focus to its trigger, so closing the dialog brings focus back there.
 */
export function QuestionMenu({
  canEdit,
  onPdfs,
  onCreate,
  onGenerate,
}: {
  readonly canEdit: boolean;
  readonly onPdfs: () => void;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}) {
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button>
          문제
          <ChevronDownIcon width={16} height={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="문제">
        <DropdownMenuItem onSelect={afterClose(onPdfs)}>PDF 관리</DropdownMenuItem>
        {canEdit ? (
          <>
            <DropdownMenuItem onSelect={onCreate}>직접 추가</DropdownMenuItem>
            <DropdownMenuItem onSelect={afterClose(onGenerate)}>변형 출제</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
