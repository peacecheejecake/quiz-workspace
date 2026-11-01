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
 * The header's `문제` menu (UX4): 직접 추가 (the 문제 등록 editor on the home,
 * `?panel=question-create`, UX7-BANK) and 변형 출제 (the 문제 생성 dialog). The 전체 문제 link
 * (UX6-PROGRESS) went with its page (UX7-BANK) and PDF 관리 with the 문제 PDF 관리 dialog, merged
 * into 문서 관리 (UX7-DOCS, DOC-01-AC09). Both items need edit rights, so without them there is no
 * menu at all. A dialog opens once the menu has returned focus to its trigger, so closing the
 * dialog brings focus back there.
 */
export function QuestionMenu({
  canEdit,
  onCreate,
  onGenerate,
}: {
  readonly canEdit: boolean;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}) {
  if (!canEdit) return null;
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
        <DropdownMenuItem onSelect={afterClose(onCreate)}>직접 추가</DropdownMenuItem>
        <DropdownMenuItem onSelect={afterClose(onGenerate)}>변형 출제</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
