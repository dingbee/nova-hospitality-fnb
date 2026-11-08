-- LB-01.03B — durable, single-use service-request nonces and credential registry.
-- Credentials contain only a lookup prefix and SHA-256 digest; raw secrets are never stored.
CREATE TABLE IF NOT EXISTS public.product_service_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  credential_prefix text NOT NULL UNIQUE CHECK (credential_prefix ~ '^[a-f0-9]{24}$'),
  credential_hash bytea NOT NULL CHECK (octet_length(credential_hash) = 32),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT product_service_credentials_revocation_consistency CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS product_service_credentials_one_active_per_connection_uidx
  ON public.product_service_credentials(connection_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS product_service_credentials_connection_idx
  ON public.product_service_credentials(connection_id, status, expires_at);

CREATE TABLE IF NOT EXISTS public.product_service_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.product_service_credentials(id) ON DELETE RESTRICT,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_service_nonces_credential_nonce_unique UNIQUE (credential_id, nonce),
  CONSTRAINT product_service_nonces_expiry_window CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS product_service_nonces_expiry_idx
  ON public.product_service_nonces(expires_at);

ALTER TABLE public.product_service_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_service_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_service_credentials, public.product_service_nonces FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_service_credentials, public.product_service_nonces TO service_role;

CREATE OR REPLACE FUNCTION public.lb01_claim_service_nonce(
  _credential_id uuid, _nonce text, _expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _claimed uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service authentication required' USING ERRCODE = '42501';
  END IF;
  IF _nonce IS NULL OR _nonce !~ '^[A-Za-z0-9_-]{16,128}$'
     OR _expires_at <= now() OR _expires_at > now() + interval '10 minutes' THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.product_service_credentials c
    JOIN public.staynas_product_connections p ON p.id = c.connection_id
    WHERE c.id = _credential_id
      AND c.status = 'active'
      AND c.expires_at > now()
      AND p.status = 'active'
      AND _expires_at <= c.expires_at
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.product_service_nonces(credential_id, nonce, expires_at)
  VALUES (_credential_id, _nonce, _expires_at)
  ON CONFLICT (credential_id, nonce) DO NOTHING
  RETURNING id INTO _claimed;
  RETURN _claimed IS NOT NULL;
END;
$lb01$;
REVOKE ALL ON FUNCTION public.lb01_claim_service_nonce(uuid,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lb01_claim_service_nonce(uuid,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.lb01_purge_expired_service_nonces(_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _deleted integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service authentication required' USING ERRCODE = '42501';
  END IF;
  IF _limit < 1 OR _limit > 20000 THEN RAISE EXCEPTION 'Invalid purge limit' USING ERRCODE = '22023'; END IF;
  WITH expired AS (
    SELECT id FROM public.product_service_nonces
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.product_service_nonces n USING expired e WHERE n.id = e.id;
  GET DIAGNOSTICS _deleted = ROW_COUNT;
  RETURN _deleted;
END;
$lb01$;
REVOKE ALL ON FUNCTION public.lb01_purge_expired_service_nonces(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lb01_purge_expired_service_nonces(integer) TO service_role;

-- Human-authorized issuance/rotation. Only the hash and prefix reach the database;
-- the raw secret is generated and disclosed once by the server-side application.
CREATE TABLE IF NOT EXISTS public.product_service_credential_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.product_service_credentials(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('issued','rotated','revoked')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_service_credential_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_service_credential_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_service_credential_audit TO service_role;

CREATE OR REPLACE FUNCTION public.lb01_issue_product_service_credential(
  _connection_id uuid, _prefix text, _hash bytea, _expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE
  _uid uuid := auth.uid();
  _connection public.staynas_product_connections%ROWTYPE;
  _old_id uuid;
  _new_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF _prefix IS NULL OR _prefix !~ '^[a-f0-9]{24}$'
     OR _hash IS NULL OR octet_length(_hash) <> 32
     OR _expires_at <= now() + interval '5 minutes'
     OR _expires_at > now() + interval '180 days' THEN
    RAISE EXCEPTION 'Invalid service credential parameters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO _connection FROM public.staynas_product_connections
  WHERE id = _connection_id FOR UPDATE;
  IF NOT FOUND OR _connection.status NOT IN ('pending','active')
     OR NOT public.restaurant_can_write_scoped(
    _connection.local_tenant_id,
    ARRAY['owner','general_manager']::public.restaurant_role[],
    _connection.local_property_id
  ) THEN
    RAISE EXCEPTION 'Connection credential administration denied' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO _old_id FROM public.product_service_credentials
  WHERE connection_id = _connection_id AND status = 'active' FOR UPDATE;
  IF _old_id IS NOT NULL THEN
    UPDATE public.product_service_credentials
    SET status = 'revoked', revoked_at = now(), revoked_by = _uid
    WHERE id = _old_id;
    INSERT INTO public.product_service_credential_audit(credential_id, action, actor_user_id, details)
    VALUES (_old_id, 'rotated', _uid, jsonb_build_object('replacement_pending', true));
  END IF;

  INSERT INTO public.product_service_credentials(
    connection_id, credential_prefix, credential_hash, expires_at, created_by
  ) VALUES (_connection_id, _prefix, _hash, _expires_at, _uid)
  RETURNING id INTO _new_id;
  INSERT INTO public.product_service_credential_audit(credential_id, action, actor_user_id, details)
  VALUES (_new_id, CASE WHEN _old_id IS NULL THEN 'issued' ELSE 'rotated' END, _uid,
          jsonb_build_object('expires_at', _expires_at));
  RETURN _new_id;
END;
$lb01$;

CREATE OR REPLACE FUNCTION public.lb01_revoke_product_service_credential(
  _credential_id uuid, _reason text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE
  _uid uuid := auth.uid();
  _credential public.product_service_credentials%ROWTYPE;
  _connection public.staynas_product_connections%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO _credential FROM public.product_service_credentials
  WHERE id = _credential_id FOR UPDATE;
  IF NOT FOUND OR _credential.status <> 'active' THEN RETURN false; END IF;
  SELECT * INTO _connection FROM public.staynas_product_connections
  WHERE id = _credential.connection_id;
  IF NOT FOUND OR NOT public.restaurant_can_write_scoped(
    _connection.local_tenant_id,
    ARRAY['owner','general_manager']::public.restaurant_role[],
    _connection.local_property_id
  ) THEN
    RAISE EXCEPTION 'Connection credential administration denied' USING ERRCODE = '42501';
  END IF;
  UPDATE public.product_service_credentials
  SET status = 'revoked', revoked_at = now(), revoked_by = _uid
  WHERE id = _credential_id;
  INSERT INTO public.product_service_credential_audit(credential_id, action, actor_user_id, details)
  VALUES (_credential_id, 'revoked', _uid, jsonb_build_object('reason', left(coalesce(_reason,''),500)));
  RETURN true;
END;
$lb01$;

REVOKE ALL ON FUNCTION public.lb01_issue_product_service_credential(uuid,text,bytea,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lb01_revoke_product_service_credential(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lb01_issue_product_service_credential(uuid,text,bytea,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lb01_revoke_product_service_credential(uuid,text) TO authenticated;
