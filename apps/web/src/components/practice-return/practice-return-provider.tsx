'use client';

import { ArrowLeftIcon, CloseIcon, IconButton, useDragDismiss, useModalLayerOpen } from '@quiz/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { navigateForIdentity } from '@/lib/auth/identity-navigation';
import { isProtectedPath, isSignedOutOnlyPath } from '@/lib/auth/routes';
import { publishVerifiedUser, suspendVerifiedUser } from '@/lib/auth/verified-user-events';
import {
  initialReturnState,
  makeReturnTarget,
  reduceReturnState,
  RETURN_TARGET_GONE,
  returnHref,
  type ReturnTarget,
} from '@/lib/questions/practice-return';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './practice-return.module.css';

interface ReturnContextValue {
  recordActivity: (target: ReturnTarget) => void;
  clearTarget: () => void;
  setVerifiedUser: (id: string) => void;
  /** The destination could not read this target: clears it when it is the current one. */
  releaseTarget: (target: ReturnTarget) => boolean;
  /** The workspace itself is gone for this user: clears a target in it. */
  releaseWorkspace: (workspaceId: string) => boolean;
  holdsWorkspace: (workspaceId: string) => boolean;
}
const ReturnContext = createContext<ReturnContextValue | null>(null);
const IDENTITY_RETRY_MS = 5000;
const IDENTITY_NOTICE_DELAY_MS = 10_000;
const subscribeHydration = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function useOptionalPracticeReturn(): ReturnContextValue | null {
  return useContext(ReturnContext);
}

export function usePracticeReturn(): ReturnContextValue {
  const value = useContext(ReturnContext);
  if (!value) throw new Error('usePracticeReturn requires PracticeReturnProvider');
  return value;
}

export function PracticeReturnProvider({
  children,
  userId,
}: {
  readonly children: ReactNode;
  readonly userId: string | null;
}) {
  const [state, dispatch] = useReducer(reduceReturnState, initialReturnState);
  const [verifiedUser, setUser] = useState(userId);
  const identity = useRef(userId);
  const identityReady = useRef(!!userId);
  const pendingActivity = useRef<ReturnTarget | null>(null);
  const acceptPendingActivity = useRef(false);
  const verification = useRef(0);
  const verificationPending = useRef(false);
  const verificationSilent = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitioning = useRef(false);
  const confirmedOwner = useRef<string | null | undefined>(undefined);
  const [identityPending, setIdentityPending] = useState(false);
  const [identityNotice, setIdentityNotice] = useState(false);
  const setVerifiedUser = useCallback((id: string) => {
    if (
      transitioning.current ||
      verificationPending.current ||
      (confirmedOwner.current !== undefined && confirmedOwner.current !== id)
    )
      return;
    identityReady.current = true;
    publishVerifiedUser(id);
    setIdentityPending(false);
    setUser(id);
    if (identity.current !== id) {
      identity.current = id;
      dispatch({ type: 'clear' });
    }
  }, []);
  const portalReady = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  const modalOpen = useModalLayerOpen();
  const pathname = usePathname();
  const protectedRef = useRef(isProtectedPath(pathname));
  const router = useRouter();
  const recordActivity = useCallback((target: ReturnTarget) => {
    if (!identityReady.current) {
      if (acceptPendingActivity.current) pendingActivity.current = makeReturnTarget(target);
      return;
    }
    dispatch({ type: 'activity', target });
  }, []);
  const targetRef = useRef<ReturnTarget | null>(null);
  targetRef.current = state.target;
  const releaseTarget = useCallback((target: ReturnTarget) => {
    const current = targetRef.current;
    const wanted = makeReturnTarget(target);
    if (!current || !wanted || returnHref(current) !== returnHref(wanted)) return false;
    dispatch({ type: 'clear' });
    targetRef.current = null;
    return true;
  }, []);
  const holdsWorkspace = useCallback(
    (workspaceId: string) => targetRef.current?.workspaceId === workspaceId.toLowerCase(),
    [],
  );
  const releaseWorkspace = useCallback((workspaceId: string) => {
    const current = targetRef.current;
    if (!current || current.workspaceId !== workspaceId.toLowerCase()) return false;
    dispatch({ type: 'clear' });
    targetRef.current = null;
    return true;
  }, []);
  const clearTarget = useCallback(() => {
    dispatch({ type: 'clear' });
  }, []);

  const stopIdentityNotice = useCallback(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setIdentityNotice(false);
  }, []);

  const clearIdentity = useCallback(() => {
    clearTarget();
    stopIdentityNotice();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    identity.current = null;
    identityReady.current = false;
    acceptPendingActivity.current = false;
    pendingActivity.current = null;
    confirmedOwner.current = undefined;
    verificationPending.current = false;
    verification.current++;
    transitioning.current = false;
    publishVerifiedUser(null);
  }, [clearTarget, stopIdentityNotice]);
  useLayoutEffect(() => {
    protectedRef.current = isProtectedPath(pathname);
    if (isSignedOutOnlyPath(pathname)) clearIdentity();
    else if (!protectedRef.current) publishVerifiedUser(identity.current);
    else if (verificationPending.current && !verificationSilent.current) suspendVerifiedUser();
  }, [clearIdentity, pathname]);

  /**
   * Silent checks leave the page, drafts and return control in place and only buffer activity; the
   * fail-closed path starts when the server confirms a different account or a sign-out.
   */
  const verifyIdentity = useCallback(
    async function checkIdentity({ silent = false }: { silent?: boolean } = {}): Promise<boolean> {
      const sequence = ++verification.current;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      // A silent re-check never lifts a stricter check that has not resolved yet.
      const quiet = silent && (!verificationPending.current || verificationSilent.current);
      const retryLater = () => {
        if (sequence === verification.current && protectedRef.current) {
          // A hidden page has nothing else to explain why it stays blank.
          if (!quiet) setIdentityNotice(true);
          retryTimer.current = setTimeout(
            () => void checkIdentity({ silent: quiet }),
            IDENTITY_RETRY_MS,
          );
        }
        return false;
      };
      verificationPending.current = true;
      verificationSilent.current = quiet;
      identityReady.current = false;
      acceptPendingActivity.current = true;
      if (protectedRef.current) {
        noticeTimer.current ??= setTimeout(() => setIdentityNotice(true), IDENTITY_NOTICE_DELAY_MS);
        if (!quiet) {
          suspendVerifiedUser();
          setIdentityPending(true);
        }
      }
      try {
        const response = await fetch('/api/auth/identity', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) return retryLater();
        const body: unknown = await response.json();
        if (sequence !== verification.current) return false;
        if (!body || typeof body !== 'object' || !('id' in body)) return retryLater();
        const id = body.id;
        if (
          id !== null &&
          (typeof id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        )
          return retryLater();
        verificationPending.current = false;
        stopIdentityNotice();
        confirmedOwner.current = id;
        if (id !== identity.current) {
          identity.current = id;
          acceptPendingActivity.current = false;
          pendingActivity.current = null;
          dispatch({ type: 'clear' });
          setUser(null);
          const needsShell = protectedRef.current;
          if (needsShell) {
            suspendVerifiedUser();
            setIdentityPending(true);
          } else setIdentityPending(false);
          publishVerifiedUser(id, needsShell);
          if (needsShell) {
            transitioning.current = true;
            navigateForIdentity(id);
          }
          return false;
        }
        if (protectedRef.current && transitioning.current) {
          publishVerifiedUser(id, true);
          return false;
        }
        identityReady.current = id !== null;
        acceptPendingActivity.current = false;
        if (identityReady.current && pendingActivity.current) {
          dispatch({ type: 'activity', target: pendingActivity.current });
          pendingActivity.current = null;
        }
        publishVerifiedUser(id);
        setIdentityPending(false);
        return id !== null;
      } catch {
        return retryLater();
      }
    },
    [stopIdentityNotice],
  );

  useEffect(() => {
    if (isProtectedPath(pathname) && verificationPending.current)
      void verifyIdentity({ silent: verificationSilent.current });
  }, [pathname, verifyIdentity]);

  useEffect(() => {
    const {
      data: { subscription },
    } = getSupabaseBrowserClient().auth.onAuthStateChange((event, session) => {
      // Supabase also emits SIGNED_IN on every tab return, so only a different or missing session
      // user is an account signal. The session only picks the mode; the server decides identity.
      const sameUser = event === 'SIGNED_IN' && session?.user?.id === identity.current;
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN')
        void verifyIdentity({ silent: sameUser && identity.current !== null });
    });
    return () => subscription.unsubscribe();
  }, [verifyIdentity]);

  useEffect(() => {
    const verify = () => {
      void verifyIdentity({ silent: true });
    };
    window.addEventListener('focus', verify);
    window.addEventListener('pageshow', verify);
    return () => {
      window.removeEventListener('focus', verify);
      window.removeEventListener('pageshow', verify);
      verification.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    };
  }, [verifyIdentity]);

  // No pre-check: FastAPI authorises every read of the destination, which renders under the
  // current session. An unreadable target is reported by the destination (releaseTarget).
  function returnToTarget() {
    if (state.target) router.push(returnHref(state.target));
  }
  const dismiss = () => {
    dispatch({ type: 'dismiss' });
  };
  const controlRef = useRef<HTMLDivElement>(null);
  const dragControl = useDragDismiss({
    surface: controlRef,
    edges: ['bottom'],
    startFrom: 'any',
    close: dismiss,
  });
  const protectedRoute =
    pathname === '/workspaces' ||
    pathname.startsWith('/workspaces/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/');
  const visible =
    !!verifiedUser &&
    protectedRoute &&
    !identityPending &&
    !modalOpen &&
    !!state.target &&
    !state.dismissed;
  // Warm the route shell (the destination's loading boundary) once per shown target. The
  // destination page is a read-only server render, so a prefetch records nothing.
  const prefetchHref = visible && state.target ? returnHref(state.target) : null;
  const routerRef = useRef(router);
  routerRef.current = router;
  useEffect(() => {
    if (prefetchHref) routerRef.current.prefetch(prefetchHref);
  }, [prefetchHref]);
  return (
    <ReturnContext.Provider
      value={{
        recordActivity,
        clearTarget,
        setVerifiedUser,
        releaseTarget,
        releaseWorkspace,
        holdsWorkspace,
      }}
    >
      {children}
      {portalReady && (!modalOpen || identityPending || identityNotice) && protectedRoute
        ? createPortal(
            <div data-app-global-control="practice-return">
              {/* Explicit aria-live: a modal's hideOthers exempts it, not an implicit role=status. */}
              {identityNotice ? (
                <p className={styles.notice} role="status" aria-live="polite">
                  연결이 불안정합니다. 다시 확인하고 있습니다.
                </p>
              ) : null}
              <Suspense fallback={null}>
                <PracticeRouteGate>
                  {visible ? (
                    <div
                      ref={controlRef}
                      className={`${styles.control} glass-surface`}
                      onPointerDown={dragControl}
                    >
                      <IconButton
                        label="보던 문제로 돌아가기"
                        icon={<ArrowLeftIcon />}
                        className={styles.target}
                        onClick={returnToTarget}
                      />
                      <IconButton
                        label="복귀 버튼 닫기"
                        icon={<CloseIcon />}
                        className={styles.target}
                        onClick={dismiss}
                      />
                    </div>
                  ) : null}
                </PracticeRouteGate>
              </Suspense>
            </div>,
            document.body,
          )
        : null}
    </ReturnContext.Provider>
  );
}

/** Receives the identity verified by each protected server shell. */
export function PracticeReturnIdentity({ userId }: { readonly userId: string }) {
  const { setVerifiedUser } = usePracticeReturn();
  useLayoutEffect(() => setVerifiedUser(userId), [setVerifiedUser, userId]);
  return null;
}

function PracticeRouteGate({ children }: { readonly children: ReactNode }) {
  const search = useSearchParams();
  return search.has('question') || search.has('practice') ? null : children;
}

/**
 * Rendered by the not-found page of a workspace route (`notFound()` is only thrown for definitive
 * answers: unknown, foreign, deleted or revoked). Releases that workspace's return target, once.
 * The page reveals nothing: the id comes from the address the user already typed.
 */
export function ReleaseWorkspaceTarget() {
  const pathname = usePathname();
  const control = useOptionalPracticeReturn();
  const workspaceId = /^\/workspaces\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1] ?? null;
  // Decided on arrival, before the release below empties the target; the notice stays inline
  // because this page replaces the shell that hosts the toasts.
  const [announce] = useState(() => !!workspaceId && !!control?.holdsWorkspace(workspaceId));
  const release = control?.releaseWorkspace;
  useEffect(() => {
    if (workspaceId) release?.(workspaceId);
  }, [workspaceId, release]);
  return announce ? <p role="status">{RETURN_TARGET_GONE}</p> : null;
}
