import type { Metadata } from 'next';
import { isProtectedPath } from '@/lib/auth/routes';
import { getScreen, isQueryStateActive, type ScreenId } from '@/screens';
import styles from './stub-screen.module.css';

export const NOT_IMPLEMENTED_TEXT = '아직 구현되지 않은 화면입니다';

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

export function stubMetadata(id: ScreenId): Metadata {
  return { title: `${getScreen(id).name} (${id})` };
}

interface StubScreenProps {
  screenId: ScreenId;
  /** Query-state screen rendered on top of this route (QPLAY-01 on QOV-01, WS-FORK-01 on WS-VIEW-01). */
  queryScreenId?: ScreenId;
  searchParams?: SearchParams;
}

/** Deliberate "not implemented yet" placeholder so RED E2E tests fail on behaviour, not 404. */
export function StubScreen({ screenId, queryScreenId, searchParams = {} }: StubScreenProps) {
  const screen = getScreen(screenId);
  const queryScreen = queryScreenId ? getScreen(queryScreenId) : undefined;
  const showQueryScreen = queryScreen ? isQueryStateActive(queryScreen, searchParams) : false;

  // Protected routes render inside the AppShell, which owns the page's <main> landmark.
  const Root = isProtectedPath(screen.path) ? 'div' : 'main';

  return (
    <Root className={styles.main} data-screen-id={screen.id}>
      <h1 className={styles.title}>{screen.name}</h1>
      <p className={styles.meta}>
        화면 ID <code className={styles.id}>{screen.id}</code>
      </p>
      <p className={styles.notice}>{NOT_IMPLEMENTED_TEXT}</p>
      {queryScreen && showQueryScreen ? (
        <section
          className={styles.panel}
          aria-labelledby="stub-query-screen-title"
          data-screen-id={queryScreen.id}
        >
          <h2 id="stub-query-screen-title" className={styles.panelTitle}>
            {queryScreen.name}
          </h2>
          <p className={styles.meta}>
            화면 ID <code className={styles.id}>{queryScreen.id}</code>
          </p>
          <p className={styles.notice}>{NOT_IMPLEMENTED_TEXT}</p>
        </section>
      ) : null}
    </Root>
  );
}
