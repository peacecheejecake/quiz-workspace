// Shared per-question generations keep late responses from restoring pre-reset state.
const generations = new Map<string, number>();
const epochs = new Map<string, number>();
type ResetListener = (questionId: string) => void;
interface ResetBus {
  listeners: Set<ResetListener>;
  channel: BroadcastChannel | null;
}
const buses = new Map<string, ResetBus>();
let viewerId: string | null = null;
let identityGeneration = 0;

export function setPracticeViewer(id: string | null): void {
  if (viewerId === id) return;
  viewerId = id;
  identityGeneration++;
  epochs.clear();
  for (const [workspace, bus] of buses) {
    for (const id of generations.keys()) {
      if (id.startsWith(`${workspace}:`)) {
        const questionId = id.slice(workspace.length + 1);
        for (const listener of bus.listeners) listener(questionId);
      }
    }
  }
}

function key(workspaceId: string, questionId: string): string {
  return `${workspaceId.toLowerCase()}:${questionId.toLowerCase()}`;
}

export function practiceResetVersion(workspaceId: string, questionId: string): string {
  return `${identityGeneration}:${generations.get(key(workspaceId, questionId)) ?? 0}`;
}

export function observedPracticeEpoch(workspaceId: string, questionId: string): number | undefined {
  return epochs.get(key(workspaceId, questionId));
}

export function rememberPracticeEpoch(
  workspaceId: string,
  questionId: string,
  epoch: number,
): void {
  const id = key(workspaceId, questionId);
  if (!generations.has(id)) generations.set(id, 0);
  epochs.set(id, Math.max(epochs.get(id) ?? epoch, epoch));
}

function record(workspaceId: string, questionId: string, epoch: number): void {
  const workspace = workspaceId.toLowerCase();
  const id = key(workspaceId, questionId);
  generations.set(id, (generations.get(id) ?? 0) + 1);
  rememberPracticeEpoch(workspaceId, questionId, epoch);
  for (const listener of buses.get(workspace)?.listeners ?? []) listener(questionId);
}

export function publishPracticeReset(
  workspaceId: string,
  resetEpochs: Record<string, number>,
): void {
  for (const [questionId, epoch] of Object.entries(resetEpochs))
    record(workspaceId, questionId, epoch);
  const existing = buses.get(workspaceId.toLowerCase())?.channel;
  if (!viewerId) return;
  const message = { viewerId, epochs: resetEpochs };
  if (existing) existing.postMessage(message);
  else if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(`practice-reset:${workspaceId}`);
    channel.postMessage(message);
    channel.close();
  }
}

export function subscribePracticeResets(workspaceId: string, onReset: ResetListener): () => void {
  const workspace = workspaceId.toLowerCase();
  let bus = buses.get(workspace);
  if (!bus) {
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(`practice-reset:${workspaceId}`);
    if (channel)
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data))
          return;
        const message = event.data as { viewerId?: unknown; epochs?: unknown };
        if (
          !viewerId ||
          message.viewerId !== viewerId ||
          typeof message.epochs !== 'object' ||
          message.epochs === null ||
          Array.isArray(message.epochs)
        )
          return;
        for (const [questionId, epoch] of Object.entries(message.epochs)) {
          if (typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0)
            record(workspaceId, questionId, epoch);
        }
      };
    bus = { channel, listeners: new Set() };
    buses.set(workspace, bus);
  }
  const subscribed = bus;
  subscribed.listeners.add(onReset);
  return () => {
    subscribed.listeners.delete(onReset);
    if (subscribed.listeners.size === 0) {
      subscribed.channel?.close();
      buses.delete(workspace);
    }
  };
}
