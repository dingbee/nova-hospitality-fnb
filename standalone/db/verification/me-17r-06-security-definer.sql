-- ME-17R-06 — read-only SECURITY DEFINER verification
with f as (
  select
    p.oid,
    p.oid::regprocedure::text as signature,
    p.proconfig,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
    pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef
)
select
  count(*) as total_security_definer,
  count(*) filter (
    where proconfig is not null
      and array_to_string(proconfig,' ') ilike '%search_path=public%'
  ) as search_path_public,
  count(*) filter (
    where proconfig is null
      or array_to_string(proconfig,' ') not ilike '%search_path=public%'
  ) as search_path_unpinned,
  count(*) filter (where anon_exec) as anon_executable,
  count(*) filter (where def ~* 'execute[[:space:]]+') as dynamic_sql,
  count(*) filter (
    where auth_exec
      and def !~* 'auth[.]uid[[:space:]]*[(]'
      and def ~* '\m(insert|update|delete|truncate)\M'
  ) as authenticated_writable_without_auth_guard
from f;

-- Expected:
-- total_security_definer = 76
-- search_path_public = 76
-- search_path_unpinned = 0
-- anon_executable = 0
-- dynamic_sql = 0
-- authenticated_writable_without_auth_guard = 0
