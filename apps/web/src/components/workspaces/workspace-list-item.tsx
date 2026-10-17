'use client';

// One WS-01 list row: name link, role badge, status and — for owners — the "더보기" menu
// (이름 변경 · 공유 설정 · 보관/복원 · 삭제). Every action is decided by the API; the list is
// refreshed from the server afterwards (no optimistic edits), failures arrive as toasts.
import type { Schemas } from '@quiz/api-client';
import {
  Badge,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ModalDialog,
  MoreIcon,
  useToast,
} from '@quiz/ui';
import Link from 'next/link';
import { useId, useRef, useState, useTransition } from 'react';
import {
  archiveWorkspaceAction,
  deleteWorkspaceAction,
  renameWorkspaceAction,
  restoreWorkspaceAction,
  type WorkspaceActionResult,
  type WorkspaceFormState,
} from '@/lib/workspaces/actions';
import { ROLE_LABELS, sharingHref, workspaceHref } from './labels';
import { WorkspaceNameForm } from './workspace-name-form';
import styles from './workspaces.module.css';

type Workspace = Schemas['Workspace'];

export function WorkspaceListItem({ workspace }: { workspace: Workspace }) {
  const archived = workspace.status === 'archived';
  const isOwner = workspace.role === 'owner';
  return (
    <li className={styles.item} data-status={workspace.status}>
      <div className={styles.itemText}>
        <Link href={workspaceHref(workspace.id)} className={styles.itemLink}>
          {workspace.name}
        </Link>
        <div className={styles.itemMeta}>
          <Badge tone={isOwner ? 'accent' : 'neutral'}>{ROLE_LABELS[workspace.role]}</Badge>
          {archived ? <Badge tone="warning">읽기 전용</Badge> : null}
        </div>
      </div>
      {isOwner ? <OwnerActions workspace={workspace} /> : null}
    </li>
  );
}

function OwnerActions({ workspace }: { workspace: Workspace }) {
  const archived = workspace.status === 'archived';
  const { toast } = useToast();
  const [busy, startTransition] = useTransition();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const renameInputId = useId();

  function run(
    action: (id: string) => Promise<WorkspaceActionResult>,
    success: string,
    after?: () => void,
  ) {
    startTransition(async () => {
      const result = await action(workspace.id);
      after?.();
      if (result.ok) toast({ tone: 'success', title: success });
      else toast({ tone: 'error', title: result.error });
    });
  }

  function onRenamed(state: WorkspaceFormState) {
    if (state.status !== 'done' || !state.workspace) return;
    setRenameOpen(false);
    toast({ tone: 'success', title: `이름을 ‘${state.workspace.name}’(으)로 바꿨습니다.` });
  }

  return (
    <>
      {/* Non-modal: a modal menu that opens a dialog can leave the page inert. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton
            ref={moreRef}
            label={`${workspace.name} 더보기`}
            icon={<MoreIcon />}
            aria-busy={busy || undefined}
            disabled={busy}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={`${workspace.name} 작업`}>
          {archived ? null : (
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>이름 변경</DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href={sharingHref(workspace.id)}>공유 설정</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {archived ? (
            <DropdownMenuItem
              onSelect={() =>
                run(restoreWorkspaceAction, `‘${workspace.name}’ Workspace를 복원했습니다.`)
              }
            >
              복원
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() =>
                run(
                  archiveWorkspaceAction,
                  `‘${workspace.name}’ Workspace를 보관했습니다. 보관됨 탭에서 복원할 수 있습니다.`,
                )
              }
            >
              보관
            </DropdownMenuItem>
          )}
          <DropdownMenuItem tone="danger" onSelect={() => setDeleteOpen(true)}>
            삭제
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ModalDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Workspace 이름 변경"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(renameInputId)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          moreRef.current?.focus();
        }}
      >
        <WorkspaceNameForm
          action={renameWorkspaceAction}
          submitLabel="저장"
          initialName={workspace.name}
          inputId={renameInputId}
          prepare={(formData) => formData.set('workspaceId', workspace.id)}
          onResult={onRenamed}
        />
      </ModalDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Workspace 삭제"
        description={`‘${workspace.name}’을(를) 삭제하면 목록에서 사라지고 문서·문제·공유 링크에 더 이상 접근할 수 없습니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        loading={busy}
        returnFocusRef={moreRef}
        onConfirm={() =>
          run(deleteWorkspaceAction, `‘${workspace.name}’ Workspace를 삭제했습니다.`, () =>
            setDeleteOpen(false),
          )
        }
      />
    </>
  );
}
