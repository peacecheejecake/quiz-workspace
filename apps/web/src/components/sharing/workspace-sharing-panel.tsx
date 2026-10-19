'use client';

// WS-SHARE-01 `WorkspaceSharingPanel` (docs/design-system.md: owner share link create / revoke /
// rotate, expiry, Fork switch on the shared FloatingSidePanel). Since UX3c it is the "링크 공유"
// dialog of the workspace home's `공유하기` button: mounted when it opens, it shows a skeleton
// while the link metadata loads (listShareLinksAction), so closing it also drops a shown URL. The screen manages one link: the
// newest active one, else the newest expired one, whose policy stays editable (a later expiry
// reopens a URL already handed out, also while archived). Policy controls save on change; revoke
// and rotate are confirmed.
//
// Secret handling (docs/workspace-sharing.md §2): the share URL with `#k=` comes back once from
// create/rotate and lives only in this component's state while the link stays current — never in
// storage, a URL, a log or a later server render. Reloading leaves only the link metadata.
import {
  Badge,
  Button,
  ConfirmDialog,
  FloatingSidePanel,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@quiz/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import {
  createShareLinkAction,
  listShareLinksAction,
  revokeShareLinksAction,
  rotateShareLinkAction,
  updateShareLinkAction,
  type SharePolicyInput,
  type ShareActionResult,
} from '@/lib/sharing/actions';
import {
  expiryDateValue,
  localDateString,
  parseExpiryDate,
  SHARE_FAILURE_MESSAGES,
  sharingState,
  type ShareFailureKind,
  type ShareLink,
} from '@/lib/sharing/model';
import { keyForAttempt, type PendingCreate } from '@/lib/workspaces/idempotency';
import styles from './sharing.module.css';

export interface WorkspaceSharingPanelProps {
  readonly workspaceId: string;
  readonly archived: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Element inside `<main>` the panel is portalled into. */
  readonly container: HTMLElement | null;
  /** Screen id on the dialog body (`data-screen-id`, docs/screens/index.md). */
  readonly screenId?: string;
  /** A new value raises the open dialog above the other floating dialogs. */
  readonly raiseKey?: number;
}

const noSubscribe = () => () => undefined;

/** False during SSR and hydration: dates are shown in the viewer's timezone, known only here. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

type Confirm = 'revoke' | 'rotate' | null;

export function WorkspaceSharingPanel({
  workspaceId,
  archived,
  open,
  onOpenChange,
  container,
  screenId,
  raiseKey,
}: WorkspaceSharingPanelProps) {
  const { toast } = useToast();
  const isClient = useIsClient();
  const [links, setLinks] = useState<readonly ShareLink[]>([]);
  /** The first read of the links: in flight, done, or why it failed. */
  const [loadState, setLoadState] = useState<'loading' | 'ok' | ShareFailureKind>('loading');
  const loadLinks = useCallback(async () => {
    setLoadState('loading');
    let result: ShareActionResult;
    try {
      result = await listShareLinksAction(workspaceId);
    } catch {
      result = { ok: false, failure: 'unavailable', error: SHARE_FAILURE_MESSAGES.unavailable };
    }
    if (result.ok) {
      setLinks(result.links);
      setLoadState('ok');
    } else setLoadState(result.failure);
  }, [workspaceId]);
  useEffect(() => {
    void Promise.resolve().then(loadLinks);
  }, [loadLinks]);
  const [issued, setIssued] = useState<{ linkId: string; shareUrl: string } | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [pending, startTransition] = useTransition();
  // Policy for the next link while sharing is off.
  const [draftFork, setDraftFork] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  // Create/rotate Idempotency-Key: kept only while the last attempt's outcome is unknown.
  const issueKey = useRef<PendingCreate | null>(null);
  const linkFieldRef = useRef<HTMLInputElement>(null);
  const revokeRef = useRef<HTMLButtonElement>(null);
  const rotateRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();

  const { current, active, others, lastEnded } = sharingState(links);
  const shownUrl = issued && current?.id === issued.linkId ? issued.shareUrl : null;
  const savedExpiry = current ? expiryDateValue(current.expires_at) : '';
  const expiryValue = expiryDraft ?? (isClient ? savedExpiry : '');
  const policyDisabled = pending || (archived && !current);
  const today = isClient ? localDateString(new Date()) : undefined;

  /** Takes the refreshed list and shows or clears the failure; returns the result for narrowing. */
  function apply(result: ShareActionResult, success?: string): ShareActionResult {
    if (result.ok) {
      setLinks(result.links);
      setError(null);
      if (success) toast({ tone: 'success', title: success });
    } else {
      if (result.links) setLinks(result.links);
      setError(result.error);
    }
    return result;
  }

  function issue(intent: string, call: (key: string) => Promise<ShareActionResult>) {
    const attempt = (issueKey.current = keyForAttempt(issueKey.current, intent));
    startTransition(async () => {
      const result = await call(attempt.key);
      if (result.ok || result.failure !== 'unavailable') issueKey.current = null;
      setConfirm(null);
      if (!apply(result).ok || !result.ok) return;
      setIssued(result.issued ?? null);
      setReplayed(Boolean(result.secretAlreadyIssued));
      setExpiryDraft(null);
      if (result.issued) {
        toast({ tone: 'success', title: '보기 전용 링크를 만들었습니다. 지금 복사해 두세요.' });
        requestAnimationFrame(() => linkFieldRef.current?.focus());
      }
    });
  }

  function create() {
    const expiry = parseExpiryDate(expiryValue);
    if (!expiry.ok) {
      setExpiryError(SHARE_FAILURE_MESSAGES.invalidExpiry);
      return;
    }
    const policy: SharePolicyInput = { allowFork: draftFork, expiresAt: expiry.expiresAt };
    issue(`create:${draftFork}:${expiry.expiresAt ?? ''}`, (key) =>
      createShareLinkAction(workspaceId, policy, key),
    );
  }

  function rotate() {
    if (!current || !active) return;
    issue(`rotate:${current.id}`, (key) => rotateShareLinkAction(workspaceId, current.id, key));
  }

  function revoke() {
    const ids = [current, ...others].flatMap((link) => (link ? [link.id] : []));
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await revokeShareLinksAction(workspaceId, ids);
      setConfirm(null);
      if (apply(result, '공유 링크를 철회했습니다. 이전 링크는 더 이상 열리지 않습니다.').ok) {
        setIssued(null);
        setReplayed(false);
        setDraftFork(false);
        setExpiryDraft(null);
      }
    });
  }

  function updatePolicy(policy: SharePolicyInput, after?: () => void) {
    if (!current) return;
    const linkId = current.id;
    startTransition(async () => {
      const result = await updateShareLinkAction(workspaceId, linkId, policy);
      apply(result);
      if (result.ok) after?.();
      else if (result.failure === 'invalidExpiry') setExpiryError(result.error);
    });
  }

  function onForkChange(next: boolean) {
    if (current) updatePolicy({ allowFork: next });
    else setDraftFork(next);
  }

  function commitExpiry() {
    if (expiryDraft === null) return;
    const parsed = parseExpiryDate(expiryDraft);
    if (!parsed.ok) {
      setExpiryError(SHARE_FAILURE_MESSAGES.invalidExpiry);
      return;
    }
    setExpiryError(null);
    // Without a link the date is the next link's policy; it is sent on create.
    if (!current) return;
    if (expiryDraft === savedExpiry) {
      setExpiryDraft(null);
      return;
    }
    updatePolicy({ expiresAt: parsed.expiresAt }, () => setExpiryDraft(null));
  }

  async function copy() {
    if (!shownUrl) return;
    try {
      await navigator.clipboard.writeText(shownUrl);
      toast({ tone: 'success', title: '링크를 복사했습니다.' });
    } catch {
      linkFieldRef.current?.select();
      toast({
        tone: 'error',
        title: '자동 복사에 실패했습니다. 선택된 링크를 직접 복사해 주세요.',
      });
    }
  }

  const forkChecked = current ? current.allow_fork : draftFork;
  const loaded = loadState === 'ok';

  return (
    <>
      <FloatingSidePanel
        open={open}
        onOpenChange={onOpenChange}
        modal={false}
        container={container}
        raiseKey={raiseKey}
        title="링크 공유"
        closeLabel="공유 관리 닫기"
        mobileLayout="full"
        footer={
          !loaded ? null : current ? (
            <>
              {archived || !active ? null : (
                <Button ref={rotateRef} disabled={pending} onClick={() => setConfirm('rotate')}>
                  링크 재발급
                </Button>
              )}
              <Button ref={revokeRef} disabled={pending} onClick={() => setConfirm('revoke')}>
                링크 철회
              </Button>
            </>
          ) : archived ? null : (
            <Button variant="primary" loading={pending} onClick={create}>
              링크 만들기
            </Button>
          )
        }
      >
        <div data-screen-id={screenId}>
          {loadState === 'loading' ? (
            <div className={styles.panelBody} aria-busy="true">
              <p role="status" className="qz-visually-hidden">
                공유 설정을 불러오는 중입니다.
              </p>
              <Skeleton shape="rect" height="2.5rem" />
              <Skeleton shape="rect" height="4rem" />
              <Skeleton shape="rect" height="6rem" />
            </div>
          ) : !loaded ? (
            <div role="alert" className={styles.error}>
              <p>{SHARE_FAILURE_MESSAGES[loadState]}</p>
              {loadState === 'forbidden' ? null : (
                <Button size="sm" onClick={() => void loadLinks()}>
                  다시 시도
                </Button>
              )}
            </div>
          ) : (
            <div className={styles.panelBody}>
              <section className={styles.status} aria-labelledby={statusId}>
                <h3 id={statusId} className="qz-visually-hidden">
                  공유 상태
                </h3>
                <div role="status" className={styles.statusLine}>
                  {active ? (
                    <>
                      <Badge tone="success">공유 중</Badge>
                      <span>링크를 가진 사람은 로그인 없이 볼 수 있습니다.</span>
                    </>
                  ) : (
                    <>
                      <Badge tone="neutral">공유 꺼짐</Badge>
                      {lastEnded === 'revoked' ? <Badge tone="warning">철회됨</Badge> : null}
                      {lastEnded === 'expired' ? <Badge tone="warning">만료됨</Badge> : null}
                      <span>
                        {lastEnded === 'revoked'
                          ? '최근 링크가 철회되어 더 이상 열리지 않습니다.'
                          : lastEnded === 'expired'
                            ? '최근 링크가 만료되어 더 이상 열리지 않습니다. 만료일을 오늘 이후로 바꾸면 이미 보낸 링크가 다시 열립니다.'
                            : '아직 공유 링크가 없습니다.'}
                      </span>
                    </>
                  )}
                </div>
                {archived ? (
                  <p className={styles.note}>
                    보관된 Workspace에서는 새 링크를 만들거나 재발급할 수 없습니다. 링크 철회와 Fork
                    허용·만료일 변경만 할 수 있습니다.
                  </p>
                ) : null}
                {others.length > 0 ? (
                  <p className={styles.note}>
                    철회되지 않은 다른 링크 {others.length}개가 더 있습니다. 링크를 철회하면 함께
                    철회됩니다.
                  </p>
                ) : null}
              </section>

              {error ? (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              ) : null}

              {shownUrl ? (
                <section className={styles.issued} aria-label="새 공유 링크">
                  <Input
                    ref={linkFieldRef}
                    label="공유 링크"
                    readOnly
                    value={shownUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    spellCheck={false}
                    autoComplete="off"
                    description="이 링크는 지금 한 번만 표시됩니다. 닫거나 새로 고치면 다시 볼 수 없으니 지금 복사해 두세요."
                  />
                  <div>
                    <Button onClick={copy}>링크 복사</Button>
                  </div>
                </section>
              ) : current ? (
                <p className={styles.note}>
                  보안을 위해 링크 주소는 만들 때 한 번만 보여 드립니다.
                  {replayed ? ' 이 링크의 주소는 이미 표시되었습니다.' : ''} 주소를 잃어버렸다면
                  링크를 재발급하세요.
                </p>
              ) : null}

              <section className={styles.policy} aria-label="링크 정책">
                <Switch
                  label="Fork 허용"
                  description="켜면 로그인한 수신자가 이 Workspace의 독립 복사본을 만들 수 있습니다. 기본은 꺼짐입니다."
                  checked={forkChecked}
                  onCheckedChange={onForkChange}
                  disabled={policyDisabled}
                />
                <Input
                  type="date"
                  label="만료일"
                  description="비워 두면 만료되지 않습니다. 선택한 날의 끝까지 링크가 열립니다."
                  value={expiryValue}
                  min={today}
                  disabled={policyDisabled}
                  error={expiryError ?? undefined}
                  onChange={(event) => {
                    setExpiryDraft(event.currentTarget.value);
                    setExpiryError(null);
                  }}
                  onBlur={commitExpiry}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitExpiry();
                    }
                  }}
                />
              </section>

              <section className={styles.notices} aria-label="공개 범위와 저작권">
                <p>
                  링크를 받은 사람은 로그인 없이 발행된 문서·문제·해설만 읽기 전용으로 볼 수
                  있습니다. 초안, 미발행 수정본, 개인 풀이 기록·즐겨찾기는 공개되지 않으며, 링크는
                  Workspace 멤버십이 아닙니다.
                </p>
                <p>
                  공유하거나 Fork를 허용하기 전에 PDF와 문제의 저작권·이용 권리를 확인하세요. 보기
                  전용 링크도 다운로드나 화면 캡처를 막지는 못합니다.
                </p>
              </section>
            </div>
          )}
        </div>
      </FloatingSidePanel>

      <ConfirmDialog
        open={confirm === 'revoke'}
        onOpenChange={(next) => setConfirm(next ? 'revoke' : null)}
        title="링크 철회"
        description="링크를 철회하면 이전 링크와 이미 열려 있는 공유 화면이 즉시 막힙니다. 되돌릴 수 없으며, 다시 공유하려면 새 링크를 만들어야 합니다."
        confirmLabel="철회"
        loading={pending}
        returnFocusRef={revokeRef}
        onConfirm={revoke}
      />
      <ConfirmDialog
        open={confirm === 'rotate'}
        onOpenChange={(next) => setConfirm(next ? 'rotate' : null)}
        title="링크 재발급"
        description="지금 링크를 철회하고 같은 설정으로 새 링크를 만듭니다. 이전 링크와 이미 열려 있는 공유 화면은 즉시 막힙니다."
        confirmLabel="재발급"
        loading={pending}
        returnFocusRef={rotateRef}
        onConfirm={rotate}
      />
    </>
  );
}
