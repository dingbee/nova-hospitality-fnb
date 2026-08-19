-- NOVA Hospitality — Restaurant & Bar OS
-- Local runtime: database roles.
--
-- The application (and the frozen migrations) assume the PostgREST role model:
--   anon           -> unauthenticated requests
--   authenticated  -> requests carrying a verified JWT
--   service_role   -> trusted server-side runtime (RLS still enabled, but
--                     policies grant it broad access where migrations say so)
--   nova_authenticator -> the role PostgREST connects as; it can only
--                     SET ROLE into the three roles above.
--
-- No passwords are hard-coded here. The authenticator password is injected by
-- scripts/init-db.sh from NOVA_DB_AUTHENTICATOR_PASSWORD.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- Schema usage baseline (per-object grants live in the product migrations).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;