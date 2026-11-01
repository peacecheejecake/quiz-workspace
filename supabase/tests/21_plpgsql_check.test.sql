-- UX7-DBLINT: the public plpgsql functions pass plpgsql_check, as `make db-lint`
-- (`supabase db lint --fail-on warning`) runs it. The extension exists only for this
-- transaction, like the lint itself; production databases never install it.
-- worker_fork_commit stages its copy in temp tables it creates itself, which plpgsql_check cannot
-- see statically; its `perform 'pragma:table: ...'` lines (20261102120000) declare them.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists plpgsql_check with schema extensions;
set local search_path = public, extensions;

select plan(2);

select is_empty(
  $$ select t.level, t.message
       from extensions.plpgsql_check_function_tb('public.worker_fork_commit(uuid)'::regprocedure) t $$,
  'worker_fork_commit passes plpgsql_check');

-- Trigger functions need a relation to be checked; the lint skips them as well.
select is_empty(
  $$ select p.oid::regprocedure, t.level, t.message
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_language l on l.oid = p.prolang
      cross join lateral extensions.plpgsql_check_function_tb(p.oid) t
      where n.nspname = 'public' and l.lanname = 'plpgsql'
        and p.prorettype <> 'trigger'::regtype $$,
  'every public plpgsql function passes plpgsql_check');

select * from finish();
rollback;
