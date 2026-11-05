'use client';

import { Button, CloseIcon, IconButton, useModalLayerOpen } from '@quiz/ui';
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
import { lookupOverviewQuestionAction } from '@/lib/questions/practice-actions';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import {
  initialReturnState,
  makeReturnTarget,
  reduceReturnState,
  returnHref,
  type ReturnTarget,
} from '@/lib/questions/practice-return';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import styles from './practice-return.module.css';

interface ReturnContextValue {
  recordActivity: (target: ReturnTarget) => void;
  clearTarget: () => void;
  setVerifiedUser: (id: string) => void;
}
const ReturnContext = createContext<ReturnContextValue | null>(null);
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
  const generation = useRef(0);
  const verification = useRef(0);
  const verificationPending = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitioning = useRef(false);
  const confirmedOwner = useRef<string | null | undefined>(undefined);
  const [identityPending, setIdentityPending] = useState(false);
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
      generation.current++;
      dispatch({ type: 'clear' });
    }
  }, []);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
    generation.current++;
    dispatch({ type: 'activity', target });
  }, []);
  const clearTarget = useCallback(() => {
    generation.current++;
    dispatch({ type: 'clear' });
  }, []);

  const clearIdentity = useCallback(() => {
    clearTarget();
    identity.current = null;
    identityReady.current = false;
    acceptPendingActivity.current = false;
    pendingActivity.current = null;
    confirmedOwner.current = undefined;
    verificationPending.current = false;
    verification.current++;
    transitioning.current = false;
    publishVerifiedUser(null);
  }, [clearTarget]);
  useLayoutEffect(() => {
    protectedRef.current = isProtectedPath(pathname);
    if (isSignedOutOnlyPath(pathname)) clearIdentity();
    else if (!protectedRef.current) publishVerifiedUser(identity.current);
    else if (verificationPending.current) suspendVerifiedUser();
  }, [clearIdentity, pathname]);

  const verifyIdentity = useCallback(async function checkIdentity(): Promise<boolean> {
    const sequence = ++verification.current;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    const retryLater = () => {
      if (sequence === verification.current && protectedRef.current) {
        retryTimer.current = setTimeout(() => void checkIdentity(), 5000);
      }
      return false;
    };
    verificationPending.current = true;
    identityReady.current = false;
    acceptPendingActivity.current = true;
    if (protectedRef.current) {
      suspendVerifiedUser();
      setIdentityPending(true);
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
      confirmedOwner.current = id;
      if (id !== identity.current) {
        generation.current++;
        identity.current = id;
        acceptPendingActivity.current = false;
        pendingActivity.current = null;
        dispatch({ type: 'clear' });
        setUser(null);
        const needsShell = protectedRef.current;
        publishVerifiedUser(id, needsShell);
        if (!needsShell) setIdentityPending(false);
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
        generation.current++;
        dispatch({ type: 'activity', target: pendingActivity.current });
        pendingActivity.current = null;
      }
      publishVerifiedUser(id);
      setIdentityPending(false);
      return id !== null;
    } catch {
      return retryLater();
    }
  }, []);

  useEffect(() => {
    if (isProtectedPath(pathname) && verificationPending.current) void verifyIdentity();
  }, [pathname, verifyIdentity]);

  useEffect(() => {
    const {
      data: { subscription },
    } = getSupabaseBrowserClient().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') void verifyIdentity();
    });
    return () => subscription.unsubscribe();
  }, [verifyIdentity]);

  useEffect(() => {
    const verify = () => {
      void verifyIdentity();
    };
    window.addEventListener('focus', verify);
    window.addEventListener('pageshow', verify);
    return () => {
      window.removeEventListener('focus', verify);
      window.removeEventListener('pageshow', verify);
      verification.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [verifyIdentity]);

  async function returnToTarget() {
    const target = state.target;
    if (!target || busy) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setMessage('');
    try {
      if (!(await verifyIdentity()) || requestGeneration !== generation.current) return;
      let valid: boolean;
      let temporary = false;
      if (target.kind === 'question') {
        const result = await lookupOverviewQuestionAction(target.workspaceId, target.questionId);
        valid = result.ok && result.data !== null;
        temporary = !result.ok && result.kind === 'unavailable';
      } else {
        const api = createPracticeRunApi(target.workspaceId);
        const run = await api.getRun(target.runId);
        const item = run.ok ? await api.getItem(target.runId, target.position) : null;
        valid = !!item && item.ok && item.data.available;
        temporary =
          (!run.ok && run.kind === 'unavailable') ||
          (!!item && !item.ok && item.kind === 'unavailable');
      }
      if (requestGeneration !== generation.current) return;
      if (valid) router.push(returnHref(target));
      else if (temporary)
        setMessage('일시적인 오류로 문제를 확인하지 못했습니다. 다시 시도해 주세요.');
      else {
        dispatch({ type: 'clear' });
        setMessage('보던 문제를 더 이상 열 수 없습니다.');
      }
    } catch {
      if (requestGeneration !== generation.current) return;
      setMessage('일시적인 오류로 문제를 확인하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
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
  return (
    <ReturnContext.Provider value={{ recordActivity, clearTarget, setVerifiedUser }}>
      {children}
      {portalReady && (!modalOpen || identityPending) && protectedRoute
        ? createPortal(
            <div data-app-global-control="practice-return">
              {identityPending ? (
                <p className={styles.message} role="status">
                  계정을 확인하고 있습니다. 연결을 확인한 뒤 다시 돌아와 주세요.
                </p>
              ) : null}
              <Suspense fallback={null}>
                <PracticeRouteGate>
                  {message && !identityPending ? (
                    <p className={styles.message} role="status">
                      {message}
                    </p>
                  ) : null}
                  {visible ? (
                    <div className={styles.control}>
                      <Button type="button" onClick={returnToTarget} disabled={busy}>
                        보던 문제로 돌아가기
                      </Button>
                      <IconButton
                        label="복귀 버튼 닫기"
                        icon={<CloseIcon />}
                        className={styles.close}
                        onClick={() => {
                          generation.current++;
                          dispatch({ type: 'dismiss' });
                        }}
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
