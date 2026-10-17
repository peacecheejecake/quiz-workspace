import type { Schemas } from '@quiz/api-client';

export type WorkspaceRole = Schemas['Workspace']['role'];

export const ROLE_LABELS: Readonly<Record<WorkspaceRole, string>> = {
  owner: '소유자',
  editor: '편집자',
  viewer: '뷰어',
};

/** First page of a workspace. */
export function workspaceHref(id: string): string {
  return `/workspaces/${id}/documents`;
}

export function sharingHref(id: string): string {
  return `/workspaces/${id}/settings/sharing`;
}
