// Per-test workspaces through the public Workspace API (docs/architecture.md §6, M3.1a).
//
// Endpoint/shape contract assumed by M3.0 for M3.1a (docs give the routes, not the bodies):
//   POST   /workspaces                {name}  → 201 Workspace
//   GET    /workspaces?status=active|archived → 200 {items: Workspace[]}  (caller's workspaces)
//   PATCH  /workspaces/{id}           {name}  → 200 Workspace
//   POST   /workspaces/{id}/archive | /restore → 200 Workspace
//   DELETE /workspaces/{id}                   → 200/202/204 (soft delete)
// with Workspace = {id, name, role, status, archived_at, ...} like `GET /me/workspaces` items.
import { ApiClient } from './api.ts';
import { signIn, type AuthSession, type TestUser, type UserFactory } from './auth.ts';
import { purgeWorkspacesOwnedBy } from './db.ts';

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly status?: string;
}

interface WorkspaceList {
  readonly items: readonly Workspace[];
}

/** A per-test user with an API session. */
export interface Member {
  readonly user: TestUser;
  readonly session: AuthSession;
  readonly api: ApiClient;
}

export function uniqueWorkspaceName(label: string): string {
  return `E2E ${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class WorkspaceFactory {
  readonly #users: UserFactory;

  constructor(users: UserFactory) {
    this.#users = users;
  }

  /** New confirmed user (deleted after the test) with an API session. */
  async member(label: string): Promise<Member> {
    const user = await this.#users.create({ label });
    const session = await signIn(user);
    return { user, session, api: new ApiClient(session) };
  }

  async create(owner: Member, name = uniqueWorkspaceName('ws')): Promise<Workspace> {
    return owner.api.ok<Workspace>('POST', '/workspaces', { name }, [201]);
  }

  async list(member: Member, status: 'active' | 'archived' = 'active'): Promise<Workspace[]> {
    const body = await member.api.ok<WorkspaceList>(
      'GET',
      `/workspaces?status=${status}`,
      undefined,
      [200],
    );
    return [...body.items];
  }

  async archive(owner: Member, id: string): Promise<void> {
    await owner.api.ok('POST', `/workspaces/${id}/archive`, undefined, [200]);
  }

  async softDelete(owner: Member, id: string): Promise<void> {
    await owner.api.ok('DELETE', `/workspaces/${id}`, undefined, [200, 202, 204]);
  }

  /**
   * Removes every workspace owned by this test's users, including ones the test created through
   * the UI (soft-deleted rows would otherwise block deleting the users).
   */
  cleanup(): void {
    purgeWorkspacesOwnedBy(this.#users.created.map((u) => u.id));
  }
}
