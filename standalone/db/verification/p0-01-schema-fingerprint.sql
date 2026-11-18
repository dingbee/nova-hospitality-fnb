-- P0-01 schema fingerprint. Read-only and safe to run against production or an isolated replay.
-- Fingerprints public relations (columns, constraints, indexes, triggers, policies, RLS,
-- views and grants), routines (definitions/security/search_path/ACL), custom types,
-- the public schema ACL, and installed extensions as a separately classified category.

WITH relation_objects AS (
  SELECT
    'relation'::text AS object_type,
    n.nspname || '.' || c.relname AS object_name,
    pg_get_userbyid(c.relowner) AS object_owner,
    md5(concat_ws(E'\x1f',
      c.relkind::text,
      c.relpersistence::text,
      c.relrowsecurity::text,
      c.relforcerowsecurity::text,
      coalesce(c.relacl::text, '<default>'),
      coalesce((
        SELECT string_agg(
          concat_ws(':', a.attnum, a.attname, format_type(a.atttypid, a.atttypmod),
            a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
            a.attidentity, a.attgenerated),
          E'\n' ORDER BY a.attnum
        )
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ), ''),
      coalesce((
        SELECT string_agg(
          concat_ws(':', con.conname, con.contype, pg_get_constraintdef(con.oid),
            con.convalidated, con.condeferrable, con.condeferred),
          E'\n' ORDER BY con.conname
        )
        FROM pg_constraint con WHERE con.conrelid = c.oid
      ), ''),
      coalesce((
        SELECT string_agg(
          concat_ws(':', ic.relname, pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready),
          E'\n' ORDER BY ic.relname
        )
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        WHERE i.indrelid = c.oid
      ), ''),
      coalesce((
        SELECT string_agg(
          concat_ws(':', tg.tgname, pg_get_triggerdef(tg.oid), tg.tgenabled),
          E'\n' ORDER BY tg.tgname
        )
        FROM pg_trigger tg
        WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
      ), ''),
      coalesce((
        SELECT string_agg(
          concat_ws(':', pol.policyname, pol.permissive, pol.roles::text, pol.cmd,
            coalesce(pol.qual, ''), coalesce(pol.with_check, '')),
          E'\n' ORDER BY pol.policyname
        )
        FROM pg_policies pol
        WHERE pol.schemaname = n.nspname AND pol.tablename = c.relname
      ), ''),
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) ELSE '' END,
      CASE WHEN c.relkind = 'S' THEN (
        SELECT concat_ws(':', seqtypid, seqstart, seqincrement, seqmax, seqmin, seqcache, seqcycle)
        FROM pg_sequence WHERE seqrelid = c.oid
      ) ELSE '' END
    )) AS definition_hash
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
),
routine_objects AS (
  SELECT
    'routine'::text AS object_type,
    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
    pg_get_userbyid(p.proowner) AS object_owner,
    md5(concat_ws(E'\x1f', pg_get_functiondef(p.oid), p.prokind,
      p.prosecdef, p.provolatile, coalesce(p.proconfig::text, '<default>'),
      coalesce(p.proacl::text, '<default>'))) AS definition_hash
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p', 'w')
),
type_objects AS (
  SELECT
    'type'::text AS object_type,
    n.nspname || '.' || t.typname AS object_name,
    pg_get_userbyid(t.typowner) AS object_owner,
    md5(concat_ws(E'\x1f', t.typtype, format_type(t.oid, NULL), t.typnotnull,
      coalesce(t.typdefault, ''), coalesce(t.typacl::text, '<default>'),
      coalesce((
        SELECT string_agg(e.enumlabel, E'\n' ORDER BY e.enumsortorder)
        FROM pg_enum e WHERE e.enumtypid = t.oid
      ), ''),
      coalesce((
        SELECT string_agg(pg_get_constraintdef(con.oid), E'\n' ORDER BY con.conname)
        FROM pg_constraint con WHERE con.contypid = t.oid
      ), ''))) AS definition_hash
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND (t.typtype IN ('e', 'd', 'r', 'b') OR (t.typtype = 'c' AND t.typrelid = 0))
),
schema_objects AS (
  SELECT
    'schema'::text AS object_type,
    n.nspname AS object_name,
    pg_get_userbyid(n.nspowner) AS object_owner,
    md5(coalesce(n.nspacl::text, '<default>')) AS definition_hash
  FROM pg_namespace n
  WHERE n.nspname = 'public'
),
extension_objects AS (
  SELECT
    'extension'::text AS object_type,
    e.extname AS object_name,
    pg_get_userbyid(e.extowner) AS object_owner,
    md5(concat_ws('|', e.extversion, n.nspname)) AS definition_hash
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
),
all_objects AS (
  SELECT * FROM relation_objects
  UNION ALL SELECT * FROM routine_objects
  UNION ALL SELECT * FROM type_objects
  UNION ALL SELECT * FROM schema_objects
  UNION ALL SELECT * FROM extension_objects
)
SELECT
  object_type,
  count(*) AS object_count,
  md5(string_agg(object_name || ':' || definition_hash, E'\n' ORDER BY object_name)) AS definition_digest,
  string_agg(DISTINCT object_owner, ', ' ORDER BY object_owner) AS observed_owners
FROM all_objects
GROUP BY object_type
ORDER BY object_type;
