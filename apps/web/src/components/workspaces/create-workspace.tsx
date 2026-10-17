'use client';

// "Workspace 만들기": one dialog shared by the page header button and the empty-state CTA.
// The Idempotency-Key lives in a ref across attempts (see lib/workspaces/idempotency.ts), so a
// retry after a lost response cannot create a second workspace.
import { Button, ModalDialog, useToast } from '@quiz/ui';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createWorkspaceAction, type WorkspaceFormState } from '@/lib/workspaces/actions';
import { keyForAttempt, type PendingCreate } from '@/lib/workspaces/idempotency';
import { WorkspaceNameForm } from './workspace-name-form';

const CREATE_LABEL = 'Workspace 만들기';

const OpenCreateContext = createContext<(() => void) | null>(null);

export function CreateWorkspaceProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<PendingCreate | null>(null);
  const inputId = useId();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const openCreate = useCallback(() => setOpen(true), []);

  function onResult(state: WorkspaceFormState) {
    if (state.status === 'done' && state.workspace) {
      pending.current = null;
      setOpen(false);
      toast({ tone: 'success', title: `‘${state.workspace.name}’ Workspace를 만들었습니다.` });
      // New workspaces are active: show that tab.
      if (pathname === '/workspaces') window.history.replaceState(null, '', '/workspaces');
      else router.push('/workspaces');
      return;
    }
    if (state.failure === 'idempotencyKeyReused') pending.current = null;
  }

  return (
    <OpenCreateContext.Provider value={openCreate}>
      {children}
      <ModalDialog
        open={open}
        onOpenChange={setOpen}
        title={CREATE_LABEL}
        description="새 Workspace를 만들면 내가 소유자가 됩니다."
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(inputId)?.focus();
        }}
      >
        <WorkspaceNameForm
          action={createWorkspaceAction}
          submitLabel="만들기"
          inputId={inputId}
          prepare={(formData, name) => {
            pending.current = keyForAttempt(pending.current, name);
            formData.set('idempotencyKey', pending.current.key);
          }}
          onResult={onResult}
        />
      </ModalDialog>
    </OpenCreateContext.Provider>
  );
}

export function CreateWorkspaceButton({
  variant = 'primary',
}: {
  variant?: 'primary' | 'secondary';
}) {
  const openCreate = useContext(OpenCreateContext);
  if (!openCreate) throw new Error('CreateWorkspaceButton must be inside CreateWorkspaceProvider.');
  return (
    <Button variant={variant} onClick={openCreate} aria-haspopup="dialog">
      {CREATE_LABEL}
    </Button>
  );
}
