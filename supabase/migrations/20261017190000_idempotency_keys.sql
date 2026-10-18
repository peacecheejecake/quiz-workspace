-- M3.1a: stored responses for the `Idempotency-Key` request header on POST endpoints
-- (docs/architecture.md §6 "POST 작업에는 멱등 키를 지원한다").
--
-- A key is scoped to (user_id, scope, key): `scope` names the operation (e.g.
-- 'POST /workspaces'), so the same client key never collides across users or endpoints. The API
-- serialises same-key requests with a transaction-scoped advisory lock, runs the operation, and
-- stores the response in the same transaction as the operation's own writes; a retry with the
-- same key and the same request body (`request_hash`, SHA-256 of the canonical body) gets the
-- stored response back, a retry with a different body is rejected (409).
--
-- Retention: a row is honoured until `expires_at` (24 hours by default, set by the API). Expired
-- rows are ignored and overwritten on reuse of the key; a periodic sweep
-- (`delete from public.idempotency_keys where expires_at < now()`) removes the rest and can use
-- the expires_at index. Rows disappear with their user.
--
-- `response_body` holds exactly what the endpoint returned to the same user (never tokens,
-- signed URLs or other secrets: endpoints that return such values must not store them here).

create table public.idempotency_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  key text not null,
  request_hash text not null,
  response_status smallint not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (user_id, scope, key),
  constraint idempotency_keys_scope_format
    check (char_length(scope) between 1 and 200),
  -- Visible ASCII only (RFC 9110 token-ish), bounded.
  constraint idempotency_keys_key_format
    check (key ~ '^[!-~]{1,200}$'),
  constraint idempotency_keys_request_hash_format
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_keys_response_status_valid
    check (response_status between 200 and 599),
  constraint idempotency_keys_response_body_size
    check (pg_column_size(response_body) <= 65536),
  constraint idempotency_keys_expiry_after_creation
    check (expires_at > created_at)
);

comment on table public.idempotency_keys is
  'Idempotency-Key replay store (M3.1a): one stored response per (user, operation scope, key).';

-- Retention sweep.
create index idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges: API only. DELETE for the retention sweep.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.idempotency_keys from anon, authenticated;

grant select, insert, update, delete on public.idempotency_keys to quiz_api;

alter table public.idempotency_keys enable row level security;

create policy quiz_api_all on public.idempotency_keys
  for all to quiz_api using (true) with check (true);
