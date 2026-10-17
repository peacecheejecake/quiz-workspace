// QGEN-01 문제 변형 출제 (docs/screens/questions-generation.md). The workspace layout already
// resolved access (404 for unknown/foreign workspaces); this page loads the `?source=` question,
// its newest generation run and the run's drafts server-side and hands them to the client screen,
// which runs generations, the review and registration through the same-origin relays
// (src/app/api). Without a source it lists CONFIRMED questions to pick from.
import type { Metadata } from 'next';
import { GenerationSourcePicker } from '@/components/questions/generate/generation-source-picker';
import { QuestionGeneration } from '@/components/questions/generate/question-generation';
import {
  loadGenerationScreen,
  SOURCE_PICKER_LIMIT,
  sourceParam,
} from '@/lib/questions/generation-data';
import { requireWorkspace } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: '문제 변형 출제' };

export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  const workspace = await requireWorkspace(workspaceId);
  const data = await loadGenerationScreen(workspace.id, sourceParam(query.source));
  const readOnly =
    workspace.status === 'archived' ? 'archived' : workspace.role === 'viewer' ? 'viewer' : null;

  return (
    <div data-screen-id="QGEN-01">
      {data.kind === 'source' ? (
        <QuestionGeneration
          key={`${workspace.id}:${data.source.id}`}
          workspaceId={workspace.id}
          readOnly={readOnly}
          source={data.source}
          initialRun={data.run}
          initialDrafts={data.drafts}
          loadFailed={data.loadFailed}
        />
      ) : (
        <GenerationSourcePicker
          workspaceId={workspace.id}
          candidates={data.candidates}
          sourceMissing={data.sourceMissing}
          loadFailed={data.loadFailed}
          limit={SOURCE_PICKER_LIMIT}
        />
      )}
    </div>
  );
}
