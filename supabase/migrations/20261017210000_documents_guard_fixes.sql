-- M3.2a review fixes (20261017200000_documents.sql is already applied; this migration amends it).
--
-- 1. revision_content_guard: lock the revision row before reading its status.
--    The guard used a plain SELECT, so a chapter/block write could check "draft" while a
--    concurrent transaction published the revision; both committed and the published revision's
--    content no longer matched its content_hash / indexed snapshot. The guard now takes
--    FOR SHARE on the revision row(s). Publishing updates that row (FOR NO KEY UPDATE), which
--    conflicts with FOR SHARE in both directions:
--      * a content write in flight makes the publish wait until it commits (the publisher then
--        hashes/indexes the final content);
--      * a publish in flight makes the content write wait, after which it sees `published` and
--        fails.
--    Both quiz_api and quiz_worker hold UPDATE on document_revisions (and a permissive UPDATE
--    policy), which FOR SHARE requires. A moved row (UPDATE of document_revision_id) locks both
--    revisions in id order, so two such writers cannot deadlock on each other.
--
-- 2. content_blocks_provenance_shape was NULL (so passed) for `{}`: `provenance -> 'locations'` is
--    NULL when the key is missing. The replacement is NULL-safe (every path yields true/false)
--    and never raises for a non-array `locations` (it is rejected with check_violation instead).
--    Audit of the other CHECKs in 20261017200000: every other expression only reads NOT NULL
--    columns or guards its nullable inputs explicitly (`x is null or ...`,
--    `is not distinct from`); the remaining NULL-passing cases are intended (a NULL parent /
--    chapter / revision reference means "none").

create or replace function public.revision_content_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  revision_id uuid := case when tg_op = 'DELETE' then old.document_revision_id
                           else new.document_revision_id end;
  revision_ids uuid[] := array[revision_id];
  published boolean;
begin
  if tg_op = 'UPDATE' and new.document_revision_id is distinct from old.document_revision_id then
    revision_ids := array[old.document_revision_id, new.document_revision_id];
  end if;
  -- FOR SHARE serialises against a concurrent publish (an UPDATE of the revision row). A revision
  -- that no longer exists (cascade from its own hard delete) locks nothing and passes.
  select coalesce(bool_or(r.status = 'published'), false)
    into published
    from (
      select r.status
        from public.document_revisions r
       where r.id = any (revision_ids)
       order by r.id
         for share
    ) r;
  if published then
    raise exception 'content of published document revision % is immutable', revision_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.revision_content_guard() from public, anon, authenticated;

alter table public.content_blocks
  drop constraint content_blocks_provenance_shape,
  add constraint content_blocks_provenance_shape check (
    -- CASE, not AND: jsonb_array_length raises on a non-array and AND has no evaluation order.
    case
      when jsonb_typeof(provenance) = 'object'
           and provenance ? 'locations'
           and jsonb_typeof(provenance -> 'locations') = 'array'
        then coalesce(jsonb_array_length(provenance -> 'locations') >= 1, false)
      else false
    end
  ) not valid;

alter table public.content_blocks validate constraint content_blocks_provenance_shape;
