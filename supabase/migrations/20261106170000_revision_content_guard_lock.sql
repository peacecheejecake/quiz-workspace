-- UX12 CHAPTER-4 fix: put back the row lock of revision_content_guard.
--
-- 20261106150000_chapter_edit redefined the guard from its first body and lost what
-- 20261017210000_documents_guard_fixes had added: FOR SHARE on the revision row, which serialises
-- a content write against a concurrent publish (an UPDATE of that row). Without it a write could
-- commit into a revision whose content a publish had just hashed. Same rules as 20261106150000,
-- on the locked status. Additive only: the function body changes, no data does.

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
  now_row jsonb := case when tg_op = 'DELETE' then null else pg_catalog.to_jsonb(new) end;
  was_row jsonb := case when tg_op = 'INSERT' then null else pg_catalog.to_jsonb(old) end;
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
    if public.chapter_edit_active() and (
         (tg_table_name = 'chapters' and (
            tg_op = 'DELETE'
            or (tg_op = 'INSERT'
                and (now_row ->> 'section_key') ~ '^user-[0-9a-f-]{36}$'
                and (now_row ->> 'page') is null
                and (now_row ->> 'heading_block_id') is null)
            or (tg_op = 'UPDATE'
                and now_row - array['title', 'parent_id', 'level', 'sort_order']
                    = was_row - array['title', 'parent_id', 'level', 'sort_order'])))
         or (tg_table_name = 'content_blocks' and tg_op = 'UPDATE'
             and now_row - array['chapter_id', 'updated_at']
                 = was_row - array['chapter_id', 'updated_at'])
       ) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    raise exception 'content of published document revision % is immutable', revision_id
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
