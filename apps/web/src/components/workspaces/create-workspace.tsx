'use client';

// "Workspace 만들기": one dialog shared by the page header button and the empty-state CTA.
// Submission and its result live in this provider, not in the dialog: dismissing the dialog
// while a create is in flight still delivers the success toast (or an error toast) and clears
// the Idempotency-Key. The key lives in a ref across attempts (lib/workspaces/idempotency.ts),
// so a retry after a lost response cannot create a second workspace.
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
import { useNameSubmit } from './use-name-submit';
import { WorkspaceNameForm } from './workspace-name-form';

const CREATE_LABEL = 'Workspace 만들기';

const OpenCreateContext = createContext<(() => void) | null>(null);

export function CreateWorkspaceProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const pendingKey = useRef<PendingCreate | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();

  const changeOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  function onResult(state: WorkspaceFormState) {
    if (state.status === 'done' && state.workspace) {
      pendingKey.current = null;
      changeOpen(false);
      toast({ tone: 'success', title: `‘${state.workspace.name}’ Workspace를 만들었습니다.` });
      // New workspaces are active: show that tab.
      if (pathname === '/workspaces') window.history.replaceState(null, '', '/workspaces');
      else router.push('/workspaces');
      return;
    }
    if (state.failure === 'idempotencyKeyReused') pendingKey.current = null;
    // Dismissed while in flight: the form is gone, so report the failure here.
    if (!openRef.current && state.error) toast({ tone: 'error', title: state.error });
  }

  const submission = useNameSubmit(createWorkspaceAction, onResult);
  const { reset } = submission;

  const openCreate = useCallback(() => {
    // CTAs are not Radix triggers: remember the opener to return focus to it on close.
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reset();
    changeOpen(true);
  }, [reset, changeOpen]);

  return (
    <OpenCreateContext.Provider value={openCreate}>
      {children}
      <ModalDialog
        open={open}
        onOpenChange={changeOpen}
        title={CREATE_LABEL}
        description="새 Workspace를 만들면 내가 소유자가 됩니다."
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(inputId)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = opener.current;
          // After a successful create the empty-state CTA may be gone; Radix's default applies.
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <WorkspaceNameForm
          submission={submission}
          submitLabel="만들기"
          inputId={inputId}
          prepare={(formData, name) => {
            pendingKey.current = keyForAttempt(pendingKey.current, name);
            formData.set('idempotencyKey', pendingKey.current.key);
          }}
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
