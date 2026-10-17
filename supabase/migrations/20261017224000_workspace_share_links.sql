-- S1a: workspace share links (docs/workspace-sharing.md §1-§5, docs/auth.md "Workspace 공유 링크·Fork
-- 인가", docs/screens/workspace-sharing.md WS-SHARE-01).
--
-- A share link is a separate, read-only capability for one workspace; it never becomes a
-- membership. The owner issues, lists, edits (allow_fork / expiry), revokes and rotates links
-- through the API (FastAPI is the only authorization boundary); viewers present the link id (the
-- public `shareId` in `/share/{shareId}#k={secret}`) plus the secret from the URL fragment.
--
-- Secrets: the API generates 32 CSPRNG bytes per link and returns them (base64url) exactly once.
-- Only `token_digest` = SHA-256 of those 32 bytes is stored. The secret has 256 bits of entropy,
-- so a leaked digest cannot be inverted or brute-forced offline; no pepper is needed (and none
-- has to be rotated). The plaintext never reaches the DB, logs, activity metadata or the
-- idempotency store.
--
-- Lifecycle: active --revoke--> revoked (terminal; `revoked_at` set)
--            active --expires_at passes--> expired (derived from the clock, not stored)
--            active --rotate--> revoked + a NEW link (new id, new secret, same policy) whose
--                               `rotated_from_id` names the old one; a link is replaced at most
--                               once (unique index), so concurrent rotations cannot fork the chain.
-- Usability (S1b re-checks it on every shared request): not revoked, not expired, and the
-- workspace is not soft-deleted. An archived workspace's links stay usable until revoked.
--
-- Rows are never deleted by the API (revocation keeps the audit trail); they disappear only with
-- their workspace (hard delete by an operator) or with the user who created them.

create table public.workspace_share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  token_digest bytea not null,
  allow_fork boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  -- The link this one replaced through rotate (same workspace; composite FK below).
  rotated_from_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_share_links_workspace_id_id_key unique (workspace_id, id),
  -- SHA-256 output; never the 32-byte secret itself (that is what the API hashes).
  constraint workspace_share_links_token_digest_length check (octet_length(token_digest) = 32),
  constraint workspace_share_links_token_digest_key unique (token_digest),
  constraint workspace_share_links_not_self_rotated
    check (rotated_from_id is null or rotated_from_id <> id),
  constraint workspace_share_links_revoked_after_creation
    check (revoked_at is null or revoked_at >= created_at),
  constraint workspace_share_links_rotated_from_fkey
    foreign key (workspace_id, rotated_from_id)
    references public.workspace_share_links (workspace_id, id)
    on delete set null (rotated_from_id)
);

comment on table public.workspace_share_links is
  'S1a: owner-issued read-only share links. Stores only the SHA-256 digest of each 32-byte secret.';
comment on column public.workspace_share_links.token_digest is
  'SHA-256 of the 32 random secret bytes; the plaintext is returned once at issue and never stored.';
comment on column public.workspace_share_links.rotated_from_id is
  'The revoked link this link replaced (rotate); each link is replaced at most once.';

-- Owner listing: newest first.
create index workspace_share_links_workspace_created_idx
  on public.workspace_share_links (workspace_id, created_at desc, id desc);
create index workspace_share_links_created_by_idx on public.workspace_share_links (created_by);
-- A link is replaced at most once; also serves the rotated_from FK.
create unique index workspace_share_links_rotated_from_idx
  on public.workspace_share_links (workspace_id, rotated_from_id)
  where rotated_from_id is not null;

create trigger workspace_share_links_set_updated_at
  before update on public.workspace_share_links
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges: API only. No DELETE (links are revoked, not deleted). The fork worker's grants come
-- with S3a.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.workspace_share_links from anon, authenticated;

grant select, insert, update on public.workspace_share_links to quiz_api;

alter table public.workspace_share_links enable row level security;

create policy quiz_api_all on public.workspace_share_links
  for all to quiz_api using (true) with check (true);
