-- LB-01.04 — encrypted peer-credential handoff, delivery evidence and pending-state approval.
-- Additive, product-local only. No production migration is applied by this commit.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lb01_peer_credentials (
  connection_id uuid PRIMARY KEY REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  peer_product text NOT NULL CHECK (peer_product = 'staynas'),
  credential_prefix text NOT NULL CHECK (credential_prefix ~ '^[a-f0-9]{24}$'),
  encrypted_token bytea NOT NULL,
  encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  CONSTRAINT lb01_peer_credentials_revocation_consistency CHECK (
    (status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.lb01_credential_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL REFERENCES public.product_service_credentials(id) ON DELETE RESTRICT,
  peer_product text NOT NULL CHECK (peer_product = 'staynAs' OR peer_product = 'staynas'),
  correlation_id text NOT NULL,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  encrypted_token bytea NOT NULL,
  encryption_iv bytea NOT NULL CHECK (octet_length(encryption_iv) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lb01_handoff_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '20 minutes')
);
CREATE INDEX IF NOT EXISTS lb01_credential_handoffs_expiry_idx
  ON public.lb01_credential_handoffs(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.lb01_approval_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('accepted','failed','awaiting_peer_credential')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lb01_approval_delivery_attempts_connection_idx
  ON public.lb01_approval_delivery_attempts(connection_id, created_at DESC);

ALTER TABLE public.lb01_peer_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb01_credential_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb01_approval_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lb01_peer_credentials, public.lb01_credential_handoffs, public.lb01_approval_delivery_attempts
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.lb01_peer_credentials, public.lb01_credential_handoffs, public.lb01_approval_delivery_attempts
  TO service_role;

CREATE OR REPLACE FUNCTION public.lb01_can_manage_product_connection(_connection_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _uid uuid := auth.uid(); _row public.staynas_product_connections%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN RETURN false; END IF;
  SELECT * INTO _row FROM public.staynas_product_connections WHERE id = _connection_id;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN public.restaurant_can_write_scoped(
    _row.local_tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], _row.local_property_id
  );
END;
$lb01$;
REVOKE ALL ON FUNCTION public.lb01_can_manage_product_connection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lb01_can_manage_product_connection(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.lb01_consume_credential_handoff(
  _code_hash bytea, _requester_product text, _correlation_id text
)
RETURNS TABLE (
  connection_id uuid,
  credential_id uuid,
  credential_prefix text,
  encrypted_token bytea,
  encryption_iv bytea,
  encryption_tag bytea
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _handoff public.lb01_credential_handoffs%ROWTYPE;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service authentication required' USING ERRCODE = '42501';
  END IF;
  IF _code_hash IS NULL OR octet_length(_code_hash) <> 32
     OR _requester_product <> 'staynas'
     OR _correlation_id IS NULL THEN
    RETURN;
  END IF;
  SELECT h.* INTO _handoff
  FROM public.lb01_credential_handoffs h
  JOIN public.staynas_product_connections c ON c.id = h.connection_id
  WHERE h.code_hash = _code_hash
    AND h.peer_product = _requester_product
    AND h.correlation_id = _correlation_id
    AND (h.consumed_at IS NULL OR h.consumed_at > now() - interval '2 minutes')
    AND h.expires_at > now()
    AND c.status IN ('pending','active')
    AND EXISTS (
      SELECT 1 FROM public.product_service_credentials pc
      WHERE pc.id = h.credential_id AND pc.connection_id = h.connection_id
        AND pc.status = 'active' AND pc.expires_at > now()
    )
  FOR UPDATE OF h;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.lb01_credential_handoffs SET consumed_at = coalesce(consumed_at, now()) WHERE id = _handoff.id;
  RETURN QUERY SELECT _handoff.connection_id, _handoff.credential_id,
    (SELECT c.credential_prefix FROM public.product_service_credentials c WHERE c.id = _handoff.credential_id),
    _handoff.encrypted_token, _handoff.encryption_iv, _handoff.encryption_tag;
END;
$lb01$;
REVOKE ALL ON FUNCTION public.lb01_consume_credential_handoff(bytea,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lb01_consume_credential_handoff(bytea,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.lb01_revoke_connection_credentials()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
BEGIN
  IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
    UPDATE public.product_service_credentials
      SET status = 'revoked', revoked_at = now(), revoked_by = coalesce(NEW.revoked_by, NEW.requested_by)
      WHERE connection_id = NEW.id AND status = 'active';
    UPDATE public.lb01_peer_credentials
      SET status = 'revoked', revoked_at = now()
      WHERE connection_id = NEW.id AND status = 'active';
    UPDATE public.lb01_credential_handoffs
      SET consumed_at = coalesce(consumed_at, now())
      WHERE connection_id = NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$lb01$;
DROP TRIGGER IF EXISTS lb01_revoke_connection_credentials ON public.staynas_product_connections;
CREATE TRIGGER lb01_revoke_connection_credentials
  AFTER UPDATE OF status ON public.staynas_product_connections
  FOR EACH ROW EXECUTE FUNCTION public.lb01_revoke_connection_credentials();

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
    SELECT 1 FROM public.product_service_credentials c
    JOIN public.staynas_product_connections p ON p.id = c.connection_id
    WHERE c.id = _credential_id AND c.status = 'active' AND c.expires_at > now()
      AND p.status IN ('pending','active') AND _expires_at <= c.expires_at
  ) THEN RETURN false; END IF;
  INSERT INTO public.product_service_nonces(credential_id, nonce, expires_at)
  VALUES (_credential_id, _nonce, _expires_at)
  ON CONFLICT (credential_id, nonce) DO NOTHING
  RETURNING id INTO _claimed;
  RETURN _claimed IS NOT NULL;
END;
$lb01$;

CREATE OR REPLACE FUNCTION public.lexibite_approve_staynas_connection(_connection_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _uid uuid := auth.uid(); _row public.staynas_product_connections%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO _row FROM public.staynas_product_connections WHERE id = _connection_id FOR UPDATE;
  IF NOT FOUND OR NOT public.lb01_can_manage_product_connection(_connection_id) THEN
    RAISE EXCEPTION 'Connection approval denied' USING ERRCODE = '42501';
  END IF;
  IF _row.status = 'revoked' THEN RAISE EXCEPTION 'Revoked connections are terminal'; END IF;
  IF _row.status = 'suspended' THEN RAISE EXCEPTION 'Suspended connection must be resumed separately'; END IF;
  IF _row.local_approved_at IS NULL THEN
    UPDATE public.staynas_product_connections
      SET local_approved_by = _uid, local_approved_at = now(),
          status = CASE WHEN remote_approved_at IS NOT NULL THEN 'active' ELSE 'pending' END,
          updated_at = now()
      WHERE id = _connection_id RETURNING * INTO _row;
    INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_user_id, actor_kind)
      VALUES (_connection_id, 'locally_approved', _uid, 'human');
  END IF;
  RETURN _row.status;
END;
$lb01$;

CREATE OR REPLACE FUNCTION public.lexibite_record_staynas_approval(
  _integration_tenant_id uuid, _integration_property_id uuid,
  _remote_tenant_id uuid, _remote_property_id uuid, _correlation_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _row public.staynas_product_connections%ROWTYPE;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _row FROM public.staynas_product_connections
  WHERE integration_tenant_id = _integration_tenant_id
    AND integration_property_id = _integration_property_id
    AND remote_tenant_id = _remote_tenant_id AND remote_property_id = _remote_property_id
    AND correlation_id = _correlation_id FOR UPDATE;
  IF NOT FOUND OR _row.status = 'revoked' THEN RAISE EXCEPTION 'Connection not found or revoked'; END IF;
  IF _row.status = 'suspended' THEN RAISE EXCEPTION 'Suspended connection cannot receive approvals'; END IF;
  IF _row.remote_approved_at IS NULL THEN
    UPDATE public.staynas_product_connections
      SET remote_approved_at = now(),
          status = CASE WHEN local_approved_at IS NOT NULL THEN 'active' ELSE 'pending' END,
          updated_at = now()
      WHERE id = _row.id RETURNING * INTO _row;
    INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_kind)
      VALUES (_row.id, 'remotely_approved', 'remote_service');
  END IF;
  RETURN _row.status;
END;
$lb01$;

COMMIT;
