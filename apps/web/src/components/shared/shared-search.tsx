'use client';

// WS-VIEW-01 본문 (source) search: the member SEARCH-01 result list and excerpt panel over the shared
// workspace's published documents (the API scopes the search to this link's workspace). The
// excerpt's "PDF에서 보기" opens the hit inside the share view at its page and block.
import { Button, Input } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { DocumentExcerptPanel } from '@/components/search/document-excerpt-panel';
import { hitKey, SearchResultList } from '@/components/search/search-result-list';
import type { SearchClient, SearchItem } from '@/lib/search/client';
import { degradedMessages, MAX_QUERY_CHARS } from '@/lib/search/state';
import type { SharedClient } from '@/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { sharedDocumentHref } from '@/lib/shared/view-state';
import styles from './shared.module.css';

export interface SharedSearchProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly onUnavailable: () => void;
}

type SearchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'done';
      readonly items: readonly SearchItem[];
      readonly truncated: boolean;
      /** SEARCH-01-AC06 notices (keyword results only). */
      readonly degraded: readonly string[];
    };

/** The shared API has no single-block read: the jump uses the hit's own location. */
const NO_BLOCK_READS: Pick<SearchClient, 'block'> = {
  block: () => Promise.reject(new Error('not available in the shared view')),
};

export function SharedSearch({ shareId, client, onUnavailable }: SharedSearchProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const items = useMemo(() => (state.status === 'done' ? state.items : []), [state]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: 'loading' });
    setPanelOpen(false);
    try {
      const result = await client.search(q, controller.signal);
      if (controller.signal.aborted) return;
      setState({
        status: 'done',
        items: result.items,
        truncated: result.truncated,
        degraded: degradedMessages(result.degraded),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (endsShareView(error)) onUnavailable();
      else setState({ status: 'error', message: sharedFailureMessage(error) });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="shared-search-title">
      <h2 id="shared-search-title" className={styles.cardTitle}>
        본문 검색
      </h2>
      <form role="search" className={styles.searchForm} onSubmit={(e) => void onSubmit(e)}>
        <Input
          label="검색어"
          hideLabel
          type="search"
          fieldClassName={styles.searchField}
          value={query}
          maxLength={MAX_QUERY_CHARS}
          placeholder="발행된 문서에서 검색"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={state.status === 'loading'}>
          검색
        </Button>
      </form>
      <p className={styles.note} role="status">
        {state.status === 'loading'
          ? '검색 중입니다…'
          : state.status === 'done'
            ? state.items.length === 0
              ? '검색 결과가 없습니다.'
              : `검색 결과 ${state.items.length}건${state.truncated ? ' (검색어가 길어 앞부분만 사용했습니다)' : ''}`
            : ''}
      </p>
      {/* SEARCH-01-AC06: whatever the number of results, including none. */}
      {state.status === 'done' && state.degraded.length > 0 ? (
        <p className={styles.note} role="status">
          {state.degraded.join(' ')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p className={styles.alert} role="alert">
          {state.message}
        </p>
      ) : null}
      {items.length > 0 ? (
        <SearchResultList
          items={items}
          selectedKey={selected ? hitKey(selected) : null}
          busy={false}
          onOpen={(item) => {
            setSelected(item);
            setPanelOpen(true);
          }}
        />
      ) : null}
      <DocumentExcerptPanel
        client={NO_BLOCK_READS}
        item={selected}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onJump={(item, target) => {
          setPanelOpen(false);
          router.push(
            sharedDocumentHref(shareId, item.document_id, {
              page: target.page,
              blockId: target.blockId,
            }),
          );
        }}
      />
    </section>
  );
}
