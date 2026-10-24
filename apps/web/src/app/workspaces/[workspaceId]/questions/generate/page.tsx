// QGEN-01 문제 변형 출제 (docs/screens/questions-generation.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page loads the `?source=` question,
// its recent generation runs, the selected run (`?run=`) with its drafts and pinned source
// revision server-side and hands them to the client screen,
// which runs generations, the review and registration through the same-origin relays
// (src/app/api). Without a source it lists CONFIRMED questions to pick from. `?batch=` alone is a
// batch's results page (QGEN-MULTI); with `?source=` it only adds the back link to that batch.
import type { Metadata } from 'next';
import { GenerationBatchView } from '@/components/questions/generate/generation-batch';
import { GenerationSourcePicker } from '@/components/questions/generate/generation-source-picker';
import { QuestionGeneration } from '@/components/questions/generate/question-generation';
import {
  loadGenerationBatch,
  loadGenerationScreen,
  SOURCE_PICKER_LIMIT,
  idParam,
} from '@/lib/questions/generation-data';
import { requireWorkspace, workspaceRouteId } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제 변형 출제' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const id = workspaceRouteId(workspaceId);
  const batchId = idParam(query.batch);
  const sourceId = idParam(query.source);
  if (batchId && !sourceId) {
    const [workspace, batch] = await Promise.all([
      requireWorkspace(id),
      loadGenerationBatch(id, batchId),
    ]);
    return (
      <div data-screen-id="QGEN-01">
        <GenerationBatchView
          key={batchId}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          batchId={batchId}
          initialBatch={batch.batch}
          loadFailed={batch.loadFailed}
        />
      </div>
    );
  }
  const [workspace, data] = await Promise.all([
    requireWorkspace(id),
    loadGenerationScreen(id, sourceId, idParam(query.run)),
  ]);
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QGEN-01">
      {data.kind === 'source' ? (
        <QuestionGeneration
          key={`${workspace.id}:${data.source.id}`}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          readOnly={readOnly}
          source={data.source}
          initialRuns={data.runs}
          initialRun={data.run}
          initialRunRevision={data.runRevision}
          initialDrafts={data.drafts}
          loadFailed={data.loadFailed}
          batchId={batchId}
        />
      ) : (
        <GenerationSourcePicker
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          candidates={data.candidates}
          sourceMissing={data.sourceMissing}
          loadFailed={data.loadFailed}
          limit={SOURCE_PICKER_LIMIT}
        />
      )}
    </div>
  );
}
