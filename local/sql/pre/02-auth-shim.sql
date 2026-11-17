-- NOVA Hospitality — Restaurant & Bar OS
-- Local runtime: auth compatibility shim.
--
-- The frozen product migrations contain ~445 auth.uid() references, 24
-- auth.role() references and 67 FKs to auth.users. Rewriting those policies
-- would be a rewrite of the transactional core, which is forbidden.
--
-- Instead, the local runtime reproduces the *contract* Supabase provides:
--   PostgREST verifies the JWT and sets `request.jwt.claims` (a GUC) on the
--   transaction, then SET ROLE's to the `role` claim. auth.uid() simply reads
--   that GUC. There is no hard-coded identity anywhere: a request without a
--   valid JWT has no claims, so auth.uid() is NULL and every
--   `auth.uid() = ...` policy evaluates false.

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Identity table. Local authentication owns the credentials (nova_local
-- schema); this table exists so the product's foreign keys resolve and so a
-- user row means exactly what it means on hosted Supabase.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  last_sign_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- A signed-in user may read their own row. Nothing else is exposed; the local
-- auth service talks to this table through the trusted service role only.
DROP POLICY IF EXISTS users_read_self ON auth.users;
CREATE POLICY users_read_self ON auth.users
  FOR SELECT TO authenticated
  USING (id = (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid);

GRANT SELECT ON auth.users TO authenticated;
GRANT ALL ON auth.users TO service_role;

-- ---------------------------------------------------------------
-- Claim accessors — byte-compatible with the Supabase implementations.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := NULLIF(auth.jwt() ->> 'sub', '');
  IF raw IS NULL THEN
    RETURN NULL;                 -- anonymous request
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;                   -- malformed sub is never an identity
END;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(auth.jwt() ->> 'role', ''), 'anon');
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'email', '');
$$;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;