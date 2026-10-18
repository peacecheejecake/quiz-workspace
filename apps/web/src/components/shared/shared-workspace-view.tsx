'use client';

// `SharedWorkspaceView` (WS-VIEW-01): the read-only view a link holder gets at `/share/{id}`.
//
// Start-up: a `#k=<secret>` fragment is read once, removed from the address bar at once
// (history.replaceState), and exchanged in a POST body for the HttpOnly share session cookie;
// the secret then lives only in memory until the exchange succeeds (kept for a retry after a
// network error or 429). Without a fragment the existing session cookie is used. Every refusal of
// the link (wrong, expired, revoked, deleted, no session) shows one "unavailable" notice and
// nothing of the workspace. All reads go through the same-origin relay; nothing here writes,
// practises or shows personal data, and the API refuses such requests regardless.
import { Badge, Button } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSharedClient,
  readShareSecret,
  SharedApiError,
  withoutFragment,
  type SharedWorkspace,
} from '@/lib/shared/client';
import { sharedFailureMessage } from '@/lib/shared/messages';
import {
  forkPanelHref,
  sharedDocumentHref,
  sharePath,
  type SharedViewState,
} from '@/lib/shared/view-state';
import { ForkWorkspaceDialog } from './fork-workspace-dialog';
import { SharedDocumentView } from './shared-document-view';
import { SharedQuestions } from './shared-questions';
import { SharedSearch } from './shared-search';
import styles from './shared.module.css';

export interface SharedWorkspaceViewProps {
  readonly screenId: string;
  /** Screen id of the Fork entry (`?panel=fork`). */
  readonly forkScreenId: string;
  /** Null when the URL's id cannot be a share link (rendered as unavailable). */
  readonly shareId: string | null;
  readonly view: SharedViewState;
  /** Signed in with a regular account: Fork opens `?panel=fork` instead of the sign-in page. */
  readonly signedIn: boolean;
  readonly forkLoginHref: string;
}

type Phase =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly workspace: SharedWorkspace };

const LOADING: Phase = { status: 'loading' };
const UNAVAILABLE: Phase = { status: 'unavailable' };

export function SharedWorkspaceView({
  screenId,
  forkScreenId,
  shareId,
  view,
  signedIn,
  forkLoginHref,
}: SharedWorkspaceViewProps) {
  const router = useRouter();
  const client = useMemo(() => (shareId ? createSharedClient(shareId) : null), [shareId]);
  const [phase, setPhase] = useState<Phase>(shareId ? LOADING : UNAVAILABLE);
  const [attempt, setAttempt] = useState(0);
  /** undefined: the fragment was not read yet; null: no secret (left). Memory only. */
  const secretRef = useRef<string | null | undefined>(undefined);
  /** One start-up per attempt (React re-runs effects in development). */
  const bootRef = useRef<{ attempt: number; promise: Promise<Phase> } | null>(null);

  /** Focus returns here when the Fork dialog closes (fallback: the workspace heading). */
  const forkEntryRef = useRef<HTMLAnchorElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const markUnavailable = useCallback(() => setPhase(UNAVAILABLE), []);

  useEffect(() => {
    if (!client) return;
    if (secretRef.current === undefined) {
      secretRef.current = readShareSecret(window.location.hash);
      if (window.location.hash) {
        window.history.replaceState(window.history.state, '', withoutFragment(window.location));
      }
    }
    if (bootRef.current?.attempt !== attempt) {
      const boot = async (): Promise<Phase> => {
        try {
          const secret = secretRef.current;
          if (secret) {
            await client.exchange(secret);
            secretRef.current = null;
          }
          return { status: 'ready', workspace: await client.workspace() };
        } catch (error) {
          const kind = error instanceof SharedApiError ? error.kind : 'failed';
          if (kind === 'unavailable' || kind === 'sessionRequired' || kind === 'notFound') {
            secretRef.current = null;
            return UNAVAILABLE;
          }
          return { status: 'error', message: sharedFailureMessage(error) };
        }
      };
      bootRef.current = { attempt, promise: boot() };
    }
    let live = true;
    void bootRef.current.promise.then((next) => {
      if (live) setPhase(next);
    });
    return () => {
      live = false;
    };
  }, [client, attempt]);

  if (phase.status === 'unavailable' || !client || !shareId) {
    return (
      <main className={styles.main} data-screen-id={screenId}>
        <section className={styles.unavailable} aria-labelledby="share-unavailable-title">
          <h1 id="share-unavailable-title" className={styles.title}>
            링크를 사용할 수 없습니다
          </h1>
          <p className={styles.lead}>
            링크 주소가 잘못되었거나, 만료되었거나, 공유가 중지되었을 수 있습니다. 링크를 보낸
            사람에게 새 링크를 요청해 주세요.
          </p>
        </section>
      </main>
    );
  }

  if (phase.status !== 'ready') {
    return (
      <main className={styles.main} data-screen-id={screenId}>
        {phase.status === 'loading' ? (
          <p className={styles.lead} role="status">
            공유된 Workspace를 불러오는 중입니다…
          </p>
        ) : (
          <div className={styles.alert} role="alert">
            <p>{phase.message}</p>
            <Button
              size="sm"
              onClick={() => {
                setPhase(LOADING);
                setAttempt((n) => n + 1);
              }}
            >
              다시 시도
            </Button>
          </div>
        )}
      </main>
    );
  }

  const { workspace } = phase;
  const documents = workspace.documents;
  const openDocument = view.documentId
    ? (documents.find((d) => d.id === view.documentId) ?? null)
    : null;
  const forkHref = signedIn ? forkPanelHref(shareId) : forkLoginHref;

  return (
    <main className={styles.main} data-screen-id={screenId}>
      <header className={styles.header}>
        <p className={styles.readOnly} role="note">
          <Badge tone="accent">읽기 전용</Badge>
          <span>
            링크로 공유된 Workspace입니다. 발행된 문서와 문제만 볼 수 있고, 이 화면에서는 아무것도
            저장되지 않습니다.
          </span>
        </p>
        <div className={styles.titleRow}>
          <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
            {workspace.workspace.name}
          </h1>
          {workspace.workspace.archived ? <Badge>보관됨</Badge> : null}
        </div>
        {workspace.expires_at ? (
          <p className={styles.meta}>링크 만료: {formatExpiry(workspace.expires_at)}</p>
        ) : null}
        {workspace.allow_fork ? (
          <div className={styles.fork}>
            <p className={styles.forkText}>
              이 링크는 Fork를 허용합니다. Fork하면 발행된 문서와 문제가 내 계정의 독립된 새
              Workspace로 복제되며, 이후 원본과 동기화되지 않습니다.
              {signedIn ? null : ' Fork하려면 로그인이 필요합니다.'}
            </p>
            <Button asChild variant="primary">
              <Link ref={forkEntryRef} href={forkHref}>
                Fork
              </Link>
            </Button>
          </div>
        ) : null}
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <nav aria-label="공유 문서 목차" className={styles.card}>
            <h2 className={styles.cardTitle}>문서</h2>
            {documents.length === 0 ? (
              <p className={styles.note}>공유된 문서가 없습니다.</p>
            ) : (
              <ul className={styles.docList}>
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <Link
                      href={sharedDocumentHref(shareId, doc.id)}
                      className={`${styles.docLink} qz-focus-ring`}
                      aria-current={doc.id === openDocument?.id ? 'page' : undefined}
                    >
                      {doc.title}
                    </Link>
                    {doc.document_type === 'question_paper' ? (
                      <span className={styles.docType}>문제지</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <SharedSearch shareId={shareId} client={client} onUnavailable={markUnavailable} />
        </aside>

        <div className={styles.content}>
          {view.documentId ? (
            <SharedDocumentView
              key={view.documentId}
              shareId={shareId}
              client={client}
              documentId={view.documentId}
              summary={openDocument}
              page={view.page}
              blockId={view.blockId}
              onUnavailable={markUnavailable}
            />
          ) : (
            <SharedQuestions
              shareId={shareId}
              client={client}
              documents={documents}
              onUnavailable={markUnavailable}
            />
          )}
        </div>
      </div>

      {workspace.allow_fork && signedIn ? (
        // WS-FORK-01: mounted while the link allows forking so a running fork survives closing.
        <ForkWorkspaceDialog
          shareId={shareId}
          screenId={forkScreenId}
          open={view.forkPanel}
          onOpenChange={(next) => {
            if (!next) router.replace(sharePath(shareId), { scroll: false });
          }}
          sourceName={workspace.workspace.name}
          returnFocusTo={() =>
            forkEntryRef.current?.isConnected ? forkEntryRef.current : headingRef.current
          }
        />
      ) : null}
    </main>
  );
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}
