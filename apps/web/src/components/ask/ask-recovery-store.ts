import type { AskScope, Conversation, MessageAccepted } from '@/lib/ask/client';

export interface FailedDraft {
  readonly workspaceId: string;
  readonly conversationId: string | null;
  readonly createdConversationId?: string;
  readonly text: string;
}
export interface AcceptedReceipt {
  readonly workspaceId: string;
  readonly conversationId: string | null;
  readonly conversation: Conversation;
  readonly result: MessageAccepted;
  readonly text: string;
  readonly originView: string;
}
export interface PendingOperation {
  readonly workspaceId: string;
  readonly originConversationId: string | null;
  readonly composeSession: number;
  readonly conversationId: string;
  readonly question: string;
  readonly scope: AskScope;
  readonly body: { question: string; scope?: AskScope };
  readonly key: string;
}
const EMPTY_RECEIPTS: readonly AcceptedReceipt[] = [];
const EMPTY: readonly FailedDraft[] = [];

/** Owned by the authenticated page, so requests may finish after a panel is remounted. */
export function createAskRecoveryStore() {
  let active = true;
  let visible = true;
  let generation = 0;
  let items: readonly FailedDraft[] = [];
  let receipts: readonly AcceptedReceipt[] = [];
  let operations: readonly PendingOperation[] = [];
  let composeSessions = new Map<string, number>();
  let verifier: () => Promise<boolean> = async () => active;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => (visible ? items : EMPTY),
    getReceipts: () => (visible ? receipts : EMPTY_RECEIPTS),
    token: () => generation,
    valid: (token: number) => active && token === generation,
    setVerifier(next: () => Promise<boolean>) {
      verifier = next;
    },
    hide() {
      visible = false;
      emit();
    },
    async verify() {
      const verified = await verifier();
      if (verified && active) {
        visible = true;
        emit();
      }
      return verified === true;
    },
    activate() {
      active = true;
      visible = true;
      emit();
    },
    deactivate() {
      active = false;
      visible = false;
      generation += 1;
      items = [];
      receipts = [];
      operations = [];
      composeSessions = new Map();
      emit();
    },
    composeSession(workspaceId: string) {
      return composeSessions.get(workspaceId) ?? 0;
    },
    startCompose(token: number, workspaceId: string) {
      if (active && token === generation)
        composeSessions.set(workspaceId, (composeSessions.get(workspaceId) ?? 0) + 1);
    },
    getOperation(
      token: number,
      workspaceId: string,
      conversationId: string | null,
      session: number,
    ) {
      if (!active || !visible || token !== generation) return null;
      return (
        operations.find(
          (item) =>
            item.workspaceId === workspaceId &&
            (conversationId === null
              ? item.originConversationId === null && item.composeSession === session
              : item.conversationId === conversationId ||
                item.originConversationId === conversationId),
        ) ?? null
      );
    },
    putOperation(token: number, next: PendingOperation) {
      if (active && token === generation)
        operations = [...operations.filter((item) => item !== next && item.key !== next.key), next];
    },
    removeOperation(token: number, target: PendingOperation) {
      if (active && token === generation)
        operations = operations.filter((item) => item.key !== target.key);
    },
    addReceipt(token: number, receipt: AcceptedReceipt) {
      if (!active || token !== generation) return;
      receipts = [...receipts, receipt];
      emit();
    },
    removeReceipt(token: number, receipt: AcceptedReceipt) {
      if (!active || token !== generation) return;
      receipts = receipts.filter((item) => item !== receipt);
      emit();
    },
    add(token: number, item: FailedDraft) {
      if (!active || token !== generation) return;
      if (
        !items.some(
          (existing) =>
            existing.workspaceId === item.workspaceId &&
            existing.conversationId === item.conversationId &&
            existing.text === item.text,
        )
      )
        items = [...items, item];
      emit();
    },
    remove(token: number, item: FailedDraft) {
      if (!active || token !== generation) return;
      items = items.filter(
        (existing) =>
          !(
            existing.workspaceId === item.workspaceId &&
            (existing.conversationId === item.conversationId ||
              existing.createdConversationId === item.conversationId) &&
            existing.text.trim() === item.text.trim()
          ),
      );
      emit();
    },
  };
}
export type AskRecoveryStore = ReturnType<typeof createAskRecoveryStore>;
