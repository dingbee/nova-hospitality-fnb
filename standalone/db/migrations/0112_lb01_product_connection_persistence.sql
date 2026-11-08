-- LB-01.02 — durable LexiBite side of reciprocal StayNas property mappings.
-- Additive only. No seed data, role changes, or production activation.
BEGIN;

CREATE TABLE IF NOT EXISTS public.staynas_product_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_tenant_id uuid NOT NULL,
  integration_property_id uuid NOT NULL,
  local_tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE RESTRICT,
  local_property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE RESTRICT,
  remote_product text NOT NULL DEFAULT 'staynas' CHECK (remote_product = 'staynas'),
  remote_tenant_id uuid NOT NULL,
  remote_property_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','revoked')),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  local_approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  local_approved_at timestamptz,
  remote_approved_at timestamptz,
  suspended_at timestamptz,
  suspended_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  revocation_reason text,
  correlation_id text NOT NULL CHECK (length(btrim(correlation_id)) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staynas_product_connections_tenant_property_unique UNIQUE (integration_tenant_id, integration_property_id),
  CONSTRAINT staynas_product_connections_canonical_property_unique UNIQUE (integration_property_id),
  CONSTRAINT staynas_product_connections_local_property_unique UNIQUE (local_property_id),
  CONSTRAINT staynas_product_connections_remote_property_unique UNIQUE (remote_tenant_id, remote_property_id),
  CONSTRAINT staynas_product_connections_approval_consistency CHECK (
    (local_approved_at IS NULL AND local_approved_by IS NULL)
    OR (local_approved_at IS NOT NULL AND local_approved_by IS NOT NULL)
  ),
  CONSTRAINT staynas_product_connections_revocation_consistency CHECK (
    (status <> 'revoked' AND revoked_at IS NULL AND revoked_by IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  ),
  CONSTRAINT staynas_product_connections_active_requires_both CHECK (
    status <> 'active' OR (local_approved_at IS NOT NULL AND remote_approved_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS staynas_product_connections_tenant_idx
  ON public.staynas_product_connections(local_tenant_id, status);
CREATE INDEX IF NOT EXISTS staynas_product_connections_remote_idx
  ON public.staynas_product_connections(remote_tenant_id, remote_property_id);

CREATE TABLE IF NOT EXISTS public.staynas_product_connection_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('requested','locally_approved','remotely_approved','suspended','resumed','revoked')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','remote_service')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staynas_product_connection_audit_connection_idx
  ON public.staynas_product_connection_audit(connection_id, created_at);

ALTER TABLE public.staynas_product_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staynas_product_connection_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staynas_product_connections, public.staynas_product_connection_audit FROM anon, authenticated;
GRANT SELECT ON public.staynas_product_connections, public.staynas_product_connection_audit TO authenticated;
GRANT ALL ON public.staynas_product_connections, public.staynas_product_connection_audit TO service_role;

CREATE POLICY staynas_product_connections_read_member
  ON public.staynas_product_connections FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(local_tenant_id, local_property_id));
CREATE POLICY staynas_product_connection_audit_read_member
  ON public.staynas_product_connection_audit FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.staynas_product_connections c
    WHERE c.id = connection_id
      AND public.restaurant_can_read_scoped(c.local_tenant_id, c.local_property_id)
  ));

CREATE OR REPLACE FUNCTION public.lexibite_request_staynas_connection(
  _integration_tenant_id uuid, _integration_property_id uuid,
  _local_tenant_id uuid, _local_property_id uuid,
  _remote_tenant_id uuid, _remote_property_id uuid, _correlation_id text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _uid uuid := auth.uid(); _connection_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.restaurant_properties p
    WHERE p.id = _local_property_id AND p.tenant_id = _local_tenant_id
  ) OR NOT public.restaurant_can_write_scoped(
    _local_tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], _local_property_id
  ) THEN
    RAISE EXCEPTION 'Property integration administration denied' USING ERRCODE = '42501';
  END IF;
  IF _integration_tenant_id IS NULL OR _integration_property_id IS NULL
     OR _remote_tenant_id IS NULL OR _remote_property_id IS NULL
     OR _correlation_id IS NULL OR length(btrim(_correlation_id)) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'Invalid integration mapping proposal' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.staynas_product_connections(
    integration_tenant_id, integration_property_id, local_tenant_id, local_property_id,
    remote_tenant_id, remote_property_id, requested_by, correlation_id
  ) VALUES (
    _integration_tenant_id, _integration_property_id, _local_tenant_id, _local_property_id,
    _remote_tenant_id, _remote_property_id, _uid, _correlation_id
  ) RETURNING id INTO _connection_id;
  INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_user_id, actor_kind)
  VALUES (_connection_id, 'requested', _uid, 'human');
  RETURN _connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lexibite_approve_staynas_connection(_connection_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _uid uuid := auth.uid(); _row public.staynas_product_connections%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO _row FROM public.staynas_product_connections WHERE id = _connection_id FOR UPDATE;
  IF NOT FOUND OR NOT public.restaurant_can_write_scoped(
    _row.local_tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], _row.local_property_id
  ) THEN
    RAISE EXCEPTION 'Connection approval denied' USING ERRCODE = '42501';
  END IF;
  IF _row.status = 'revoked' THEN RAISE EXCEPTION 'Revoked connections are terminal'; END IF;
  IF _row.status = 'suspended' THEN RAISE EXCEPTION 'Suspended connection must be resumed separately'; END IF;
  UPDATE public.staynas_product_connections
  SET local_approved_by = _uid, local_approved_at = now(),
      status = CASE WHEN remote_approved_at IS NOT NULL THEN 'active' ELSE 'pending' END,
      updated_at = now()
  WHERE id = _connection_id RETURNING * INTO _row;
  INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_user_id, actor_kind)
  VALUES (_connection_id, 'locally_approved', _uid, 'human');
  RETURN _row.status;
END;
$$;

-- Called only by the authenticated StayNas service adapter after validating
-- the signed request and binding it to the canonical IDs in the request.
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
  UPDATE public.staynas_product_connections
  SET remote_approved_at = coalesce(remote_approved_at, now()),
      status = CASE WHEN local_approved_at IS NOT NULL AND status <> 'suspended' THEN 'active' ELSE status END,
      updated_at = now()
  WHERE id = _row.id RETURNING * INTO _row;
  INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_kind)
  VALUES (_row.id, 'remotely_approved', 'remote_service');
  RETURN _row.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.lexibite_set_staynas_connection_state(
  _connection_id uuid, _action text, _reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $lb01$
DECLARE _uid uuid := auth.uid(); _row public.staynas_product_connections%ROWTYPE; _audit_action text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO _row FROM public.staynas_product_connections WHERE id = _connection_id FOR UPDATE;
  IF NOT FOUND OR NOT public.restaurant_can_write_scoped(
    _row.local_tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], _row.local_property_id
  ) THEN
    RAISE EXCEPTION 'Connection administration denied' USING ERRCODE = '42501';
  END IF;
  IF _action = 'suspend' AND _row.status IN ('pending','active') THEN
    UPDATE public.staynas_product_connections SET status='suspended', suspended_at=now(), suspended_by=_uid, updated_at=now() WHERE id=_connection_id;
    _audit_action := 'suspended';
  ELSIF _action = 'resume' AND _row.status = 'suspended' THEN
    UPDATE public.staynas_product_connections SET status=CASE WHEN local_approved_at IS NOT NULL AND remote_approved_at IS NOT NULL THEN 'active' ELSE 'pending' END, suspended_at=NULL, suspended_by=NULL, updated_at=now() WHERE id=_connection_id;
    _audit_action := 'resumed';
  ELSIF _action = 'revoke' AND _row.status <> 'revoked' THEN
    UPDATE public.staynas_product_connections SET status='revoked', revoked_at=now(), revoked_by=_uid, revocation_reason=nullif(left(coalesce(_reason,''),500),'') , updated_at=now() WHERE id=_connection_id;
    _audit_action := 'revoked';
  ELSE
    RAISE EXCEPTION 'Invalid connection state transition' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.staynas_product_connection_audit(connection_id, action, actor_user_id, actor_kind, details)
  VALUES (_connection_id, _audit_action, _uid, 'human', jsonb_build_object('reason', _reason));
  SELECT status INTO _row.status FROM public.staynas_product_connections WHERE id=_connection_id;
  RETURN _row.status;
END;
$$;

REVOKE ALL ON FUNCTION public.lexibite_request_staynas_connection(uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lexibite_approve_staynas_connection(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lexibite_record_staynas_approval(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lexibite_set_staynas_connection_state(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lexibite_request_staynas_connection(uuid,uuid,uuid,uuid,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lexibite_approve_staynas_connection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lexibite_record_staynas_approval(uuid,uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lexibite_set_staynas_connection_state(uuid,text,text) TO authenticated;

COMMIT;
