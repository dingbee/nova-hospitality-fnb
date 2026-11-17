-- NOVA Hospitality — Restaurant & Bar OS
-- Local runtime: local identity store, sessions, runtime metadata and the
-- tenant / first-administrator bootstrap.
--
-- Nothing here duplicates business logic. It only provides what Supabase Auth
-- provided on hosted: a credential store, a session store, and a controlled
-- way to create the very first administrator without SQL access.

CREATE SCHEMA IF NOT EXISTS nova_local;
REVOKE ALL ON SCHEMA nova_local FROM PUBLIC;
GRANT USAGE ON SCHEMA nova_local TO service_role;

-- ---------- credentials ----------
CREATE TABLE IF NOT EXISTS nova_local.credentials (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,          -- scrypt, never plaintext
  password_algo text NOT NULL DEFAULT 'scrypt',
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- sessions (refresh tokens are stored hashed) ----------
CREATE TABLE IF NOT EXISTS nova_local.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  terminal_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nova_sessions_user ON nova_local.sessions(user_id);

-- ---------- runtime metadata (versions, install identity) ----------
CREATE TABLE IF NOT EXISTS nova_local.runtime_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- applied migrations ledger ----------
CREATE TABLE IF NOT EXISTS nova_local.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- bootstrap audit ----------
CREATE TABLE IF NOT EXISTS nova_local.bootstrap_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_fingerprint text NOT NULL UNIQUE,   -- replay protection
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nova_local TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA nova_local GRANT ALL ON TABLES TO service_role;

-- ---------------------------------------------------------------
-- First-run bootstrap: property + first administrator + first outlet.
--
-- Callable only by the trusted local runtime (service_role). It is idempotent
-- through `p_fingerprint`, and it refuses outright once the tenant slug exists
-- with any administrator — there is no second bootstrap and no backdoor.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION nova_local.bootstrap_property(
  p_fingerprint    text,
  p_tenant_slug    text,
  p_tenant_name    text,
  p_property_name  text,
  p_country        text,
  p_currency       text,
  p_timezone       text,
  p_outlet_name    text,
  p_outlet_type    text,
  p_admin_name     text,
  p_admin_email    text,
  p_password_hash  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, nova_local, auth
AS $$
DECLARE
  v_existing   nova_local.bootstrap_events%ROWTYPE;
  v_tenant_id  uuid;
  v_property_id uuid;
  v_location_id uuid;
  v_user_id    uuid;
  v_email      text := lower(trim(p_admin_email));
BEGIN
  IF p_fingerprint IS NULL OR length(p_fingerprint) < 16 THEN
    RAISE EXCEPTION 'bootstrap: missing request fingerprint';
  END IF;
  IF v_email IS NULL OR v_email = '' OR p_password_hash IS NULL OR p_password_hash = '' THEN
    RAISE EXCEPTION 'bootstrap: administrator email and password hash are required';
  END IF;

  -- Replay: the exact same request returns the original result.
  SELECT * INTO v_existing FROM nova_local.bootstrap_events
   WHERE request_fingerprint = p_fingerprint;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_bootstrapped',
      'tenant_id', v_existing.tenant_id,
      'admin_user_id', v_existing.admin_user_id
    );
  END IF;

  -- A tenant that already has an owner can never be re-bootstrapped.
  SELECT id INTO v_tenant_id FROM public.restaurant_tenants WHERE slug = p_tenant_slug;
  IF v_tenant_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.restaurant_members m
     WHERE m.tenant_id = v_tenant_id AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'bootstrap: tenant % already has an administrator', p_tenant_slug
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM nova_local.credentials WHERE email = v_email) THEN
    RAISE EXCEPTION 'bootstrap: administrator % already exists', v_email
      USING ERRCODE = '42501';
  END IF;

  IF v_tenant_id IS NULL THEN
    INSERT INTO public.restaurant_tenants(slug, name, settings)
    VALUES (p_tenant_slug, p_tenant_name,
            jsonb_build_object('country', p_country, 'currency', p_currency,
                               'timezone', p_timezone, 'provisioned_by', 'nova-local'))
    RETURNING id INTO v_tenant_id;
  END IF;

  INSERT INTO public.restaurant_properties(tenant_id, slug, name, timezone, currency, settings)
  VALUES (v_tenant_id, p_tenant_slug, p_property_name, p_timezone, p_currency,
          jsonb_build_object('country', p_country))
  ON CONFLICT (tenant_id, slug) DO UPDATE
     SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, currency = EXCLUDED.currency
  RETURNING id INTO v_property_id;

  INSERT INTO public.restaurant_locations(tenant_id, property_id, slug, name, location_type)
  VALUES (v_tenant_id, v_property_id,
          regexp_replace(lower(p_outlet_name), '[^a-z0-9]+', '-', 'g'),
          p_outlet_name, COALESCE(NULLIF(p_outlet_type, ''), 'restaurant'))
  ON CONFLICT (property_id, slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_location_id;

  INSERT INTO auth.users(email, raw_user_meta_data)
  VALUES (v_email, jsonb_build_object('full_name', p_admin_name, 'provisioned_by', 'nova-local'))
  RETURNING id INTO v_user_id;

  INSERT INTO nova_local.credentials(user_id, email, password_hash)
  VALUES (v_user_id, v_email, p_password_hash);

  INSERT INTO public.restaurant_members(tenant_id, property_id, user_id, role)
  VALUES (v_tenant_id, v_property_id, v_user_id, 'owner')
  ON CONFLICT (tenant_id, user_id, role) DO NOTHING;

  -- The canonical authorization model is RBAC. Membership above scopes the
  -- transactional engines; this grant is what actually gives the first
  -- administrator OWNER permissions. Idempotent: a replay adds nothing.
  PERFORM public.nova_grant_owner(v_user_id, p_tenant_slug, p_tenant_name);

  INSERT INTO nova_local.bootstrap_events(tenant_id, admin_user_id, request_fingerprint, payload)
  VALUES (v_tenant_id, v_user_id, p_fingerprint,
          jsonb_build_object('property_id', v_property_id, 'location_id', v_location_id,
                             'country', p_country, 'currency', p_currency,
                             'timezone', p_timezone, 'admin_email', v_email));

  RETURN jsonb_build_object(
    'status', 'bootstrapped',
    'tenant_id', v_tenant_id,
    'property_id', v_property_id,
    'location_id', v_location_id,
    'admin_user_id', v_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION nova_local.bootstrap_property(
  text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nova_local.bootstrap_property(
  text, text, text, text, text, text, text, text, text, text, text, text) TO service_role;

-- ---------------------------------------------------------------
-- Health surface: cheap, secret-free checks the runtime can call.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION nova_local.health()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, nova_local, auth
AS $$
  SELECT jsonb_build_object(
    'database_version', current_setting('server_version'),
    'migrations_applied', (SELECT count(*) FROM nova_local.schema_migrations),
    'schema_version', (SELECT value FROM nova_local.runtime_meta WHERE key = 'schema_version'),
    'app_version', (SELECT value FROM nova_local.runtime_meta WHERE key = 'app_version'),
    'install_id', (SELECT value FROM nova_local.runtime_meta WHERE key = 'install_id'),
    'auth_uid_present', (auth.uid() IS NOT NULL),
    'tenants', (SELECT count(*) FROM public.restaurant_tenants),
    'administrators', (SELECT count(*) FROM public.restaurant_members WHERE role = 'owner'),
    'extensions', (SELECT jsonb_agg(extname ORDER BY extname) FROM pg_extension),
    'rls_tables_without_policies', (
      SELECT count(*) FROM pg_tables t
       WHERE t.schemaname = 'public'
         AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = t.tablename AND c.relrowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policies p
                          WHERE p.schemaname = 'public' AND p.tablename = t.tablename)
    )
  );
$$;

GRANT EXECUTE ON FUNCTION nova_local.health() TO service_role;