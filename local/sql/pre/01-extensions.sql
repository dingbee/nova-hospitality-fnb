-- NOVA Hospitality — Restaurant & Bar OS
-- Local runtime: extensions required by the frozen product migrations.
--
-- Supabase installs community extensions into a dedicated `extensions`
-- schema. The migrations reference that schema explicitly, so it must exist
-- before they run.

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- Required by the Restaurant & Bar product surface.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;      -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;     -- product/menu search
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- Make the extension objects resolvable the way Supabase does.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET search_path = public, extensions',
    current_database()
  );
END
$$;