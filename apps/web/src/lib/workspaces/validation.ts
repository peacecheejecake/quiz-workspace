// Workspace name rules, mirroring the API (`WorkspaceName` in apps/api workspaces.py): surrounding
// whitespace is trimmed, the result is 1–200 characters (code points, like Python's `len`) and
// has no control characters (U+0000–U+001F, U+007F).

export const WORKSPACE_NAME_MAX = 200;

export const WORKSPACE_NAME_MESSAGES = {
  required: 'Workspace 이름을 입력해 주세요.',
  tooLong: `Workspace 이름은 ${WORKSPACE_NAME_MAX}자 이하로 입력해 주세요.`,
  controlChars: 'Workspace 이름에 줄바꿈이나 제어 문자를 넣을 수 없습니다.',
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type WorkspaceNameResult =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string };

/** Validates a raw name and returns the trimmed value the API will store. */
export function validateWorkspaceName(raw: unknown): WorkspaceNameResult {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0) return { ok: false, error: WORKSPACE_NAME_MESSAGES.required };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: WORKSPACE_NAME_MESSAGES.controlChars };
  if ([...name].length > WORKSPACE_NAME_MAX) {
    return { ok: false, error: WORKSPACE_NAME_MESSAGES.tooLong };
  }
  return { ok: true, name };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workspace ids are UUIDs; anything else can never name a workspace (→ not found). */
export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
