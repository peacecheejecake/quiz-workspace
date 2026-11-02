// MOCK-01 relay: one mock exam (any member), 이름 바꾸기 (PATCH {title}) and 삭제 (soft delete,
// cancels a running generation), both for editors of an active workspace. Unknown, deleted and
// other workspaces' mock exams are one 404 from FastAPI.
import { isUuid, notFound, relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/mock-exams/[mockExamId]'>) {
  const { mockExamId } = await ctx.params;
  if (!isUuid(mockExamId)) return notFound();
  return relayToApi(`/mock-exams/${mockExamId}`, { method: 'GET' });
}

export async function PATCH(request: Request, ctx: RouteContext<'/api/mock-exams/[mockExamId]'>) {
  const { mockExamId } = await ctx.params;
  if (!isUuid(mockExamId)) return notFound();
  return relayToApi(`/mock-exams/${mockExamId}`, { method: 'PATCH', body: request });
}

export async function DELETE(_request: Request, ctx: RouteContext<'/api/mock-exams/[mockExamId]'>) {
  const { mockExamId } = await ctx.params;
  if (!isUuid(mockExamId)) return notFound();
  return relayToApi(`/mock-exams/${mockExamId}`, { method: 'DELETE' });
}
