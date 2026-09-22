-- ME-17R-07 verification
-- Expected: 0 unindexed FKs, 0 auth RLS init-plan advisor findings,
-- 0 multiple permissive policy findings. Unused indexes are intentionally deferred.

-- Foreign keys without a covering index.
SELECT con.conname, c.relname AS table_name, pg_get_constraintdef(con.oid) AS constraint_def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
WHERE con.contype='f'
  AND c.relnamespace='public'::regnamespace
  AND NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid=c.oid
      AND i.indisvalid
      AND (i.indkey::int[])[0:cardinality(con.conkey)-1] = con.conkey::int[]
  )
ORDER BY c.relname, con.conname;

-- The five formerly duplicated SELECT policy pairs must now have one
-- authenticated SELECT-capable policy each (the ALL policy).
SELECT tablename, count(*) AS authenticated_select_policies
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN (
    'api_integrations','api_webhook_endpoints',
    'commercial_ai_models','commercial_ai_providers','commercial_providers'
  )
  AND 'authenticated' = ANY(roles)
  AND cmd IN ('SELECT','ALL')
GROUP BY tablename
ORDER BY tablename;

-- The ten affected policies must use statement-cached auth helper calls.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN (
    'lexibite_demo_registrations','lexibite_demo_sessions','activity_logs',
    'commercial_providers','commercial_ai_models','commercial_ai_providers'
  )
ORDER BY tablename, policyname;

-- Run Supabase performance advisors after migration and record the counts.
