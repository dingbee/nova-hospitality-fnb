-- P0-04 SECURITY DEFINER inventory. This query is intentionally read-only and
-- is executed only against the disposable PostgreSQL replay database. The
-- output is reviewed for pinned search_path, function ownership and
-- unintended anon/PUBLIC EXECUTE grants; RLS being enabled is not treated as
-- evidence that a SECURITY DEFINER function is safe.

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_userbyid(p.proowner) AS owner_name,
  COALESCE(array_to_string(p.proconfig, '; '), '<UNPINNED>') AS function_settings,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) AS public_can_execute,
  left(pg_get_functiondef(p.oid), 1200) AS definition_excerpt
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid);
