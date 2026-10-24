-- P0.9: baseline tables, columns, keys and indexes exist.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

select tables_are(
  'public',
  array['profiles', 'workspaces', 'workspace_memberships', 'activity_events', 'async_jobs',
        -- M4.1 question domain
        'questions', 'question_revisions', 'question_sources', 'question_user_states',
        'practice_sessions', 'question_attempts', 'question_lineage', 'question_generation_runs',
        'question_import_runs', 'question_drafts',
        -- M3.1a Idempotency-Key replay store
        'idempotency_keys',
        -- M3.2a document domain
        'documents', 'document_revisions', 'chapters', 'content_blocks', 'document_uploads',
        -- S1a share links
        'workspace_share_links',
        -- S3a forks
        'workspace_forks',
        -- QIMP-JOB server-side registration items
        'question_import_registration_items'],
  'public schema contains exactly the expected tables'
);

select columns_are('public', 'profiles',
  array['user_id', 'display_name', 'created_at', 'updated_at']);
select columns_are('public', 'workspaces',
  array['id', 'name', 'owner_id', 'status', 'archived_at', 'deleted_at', 'created_at', 'updated_at']);
select columns_are('public', 'workspace_memberships',
  array['workspace_id', 'user_id', 'role', 'created_at', 'updated_at']);
select columns_are('public', 'activity_events',
  array['id', 'workspace_id', 'actor_id', 'event_type', 'target_type', 'target_id', 'metadata',
        'created_at']);
select columns_are('public', 'async_jobs',
  array['id', 'workspace_id', 'created_by', 'job_type', 'schema_version', 'status', 'attempts',
        'idempotency_key', 'payload', 'result', 'last_error', 'started_at', 'finished_at',
        'created_at', 'updated_at',
        -- P0.7b worker alignment
        'max_attempts', 'cancel_requested_at', 'locked_by', 'lease_expires_at', 'published_at',
        'cleanup_pending', 'cleanup_attempts', 'cleanup_last_error', 'cleanup_next_at']);

-- Primary keys
select col_is_pk('public', 'profiles', 'user_id', 'profiles PK is user_id');
select col_is_pk('public', 'workspaces', 'id', 'workspaces PK is id');
select col_is_pk('public', 'workspace_memberships', array['workspace_id', 'user_id'],
  'workspace_memberships PK is (workspace_id, user_id)');
select col_is_pk('public', 'activity_events', 'id', 'activity_events PK is id');
select col_is_pk('public', 'async_jobs', 'id', 'async_jobs PK is id');

-- UUID defaults
select col_default_is('public', 'workspaces', 'id', 'gen_random_uuid()'::text,
  'workspaces.id defaults to gen_random_uuid()');
select col_default_is('public', 'activity_events', 'id', 'gen_random_uuid()'::text,
  'activity_events.id defaults to gen_random_uuid()');
select col_default_is('public', 'async_jobs', 'id', 'gen_random_uuid()'::text,
  'async_jobs.id defaults to gen_random_uuid()');

-- Foreign keys
select fk_ok('public', 'profiles', 'user_id', 'auth', 'users', 'id');
select fk_ok('public', 'workspaces', 'owner_id', 'auth', 'users', 'id');
select fk_ok('public', 'workspace_memberships', 'workspace_id', 'public', 'workspaces', 'id');
select fk_ok('public', 'workspace_memberships', 'user_id', 'auth', 'users', 'id');
select fk_ok('public', 'activity_events', 'workspace_id', 'public', 'workspaces', 'id');
select fk_ok('public', 'activity_events', 'actor_id', 'auth', 'users', 'id');
select fk_ok('public', 'async_jobs', 'workspace_id', 'public', 'workspaces', 'id');
select fk_ok('public', 'async_jobs', 'created_by', 'auth', 'users', 'id');

-- Defaults that encode lifecycle semantics
select col_default_is('public', 'workspaces', 'status', 'active'::text,
  'workspaces.status defaults to active');
select col_default_is('public', 'async_jobs', 'status', 'queued'::text,
  'async_jobs.status defaults to queued');
select col_default_is('public', 'async_jobs', 'attempts', 0,
  'async_jobs.attempts defaults to 0');

-- Indexes
select has_index('public', 'workspaces', 'workspaces_owner_id_idx', 'index workspaces_owner_id_idx exists');
select has_index('public', 'workspace_memberships', 'workspace_memberships_user_id_idx', 'index workspace_memberships_user_id_idx exists');
select index_is_unique('public', 'workspace_memberships', 'workspace_memberships_one_owner_idx');
select has_index('public', 'activity_events', 'activity_events_workspace_created_idx', 'index activity_events_workspace_created_idx exists');
select index_is_unique('public', 'async_jobs', 'async_jobs_idempotency_idx');

-- updated_at triggers on every mutable table
select is(
  (select array_agg(event_object_table::text order by event_object_table::text)
     from information_schema.triggers
    where trigger_schema = 'public' and action_statement like '%set_updated_at%'),
  array['async_jobs', 'content_blocks', 'document_revisions', 'document_uploads', 'documents',
        'practice_sessions', 'profiles', 'question_drafts', 'question_generation_runs',
        'question_import_runs', 'question_user_states', 'questions', 'workspace_forks',
        'workspace_memberships', 'workspace_share_links', 'workspaces'],
  'updated_at trigger exists on every mutable table'
);

select * from finish();
rollback;
