-- LB-02.02/04/05 — LexiBite outlet mappings, privacy-safe stay projections and durable inbox.
-- Additive and product-local. Guest/customer profiles are never created or merged here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lb02_outlet_property_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  local_tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE RESTRICT,
  local_property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE RESTRICT,
  local_outlet_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT,
  integration_property_id uuid NOT NULL,
  remote_property_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  outlet_type text NOT NULL CHECK (length(btrim(outlet_type)) BETWEEN 1 AND 48),
  public_description text CHECK (public_description IS NULL OR length(public_description) <= 1000),
  guest_visible_status text NOT NULL DEFAULT 'unpublished'
    CHECK (guest_visible_status IN ('unpublished','open','closed','temporarily_unavailable')),
  published_service_hours jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(published_service_hours) = 'object'),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected','revoked')),
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  source_version bigint NOT NULL DEFAULT 1 CHECK (source_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lb02_outlet_mapping_per_connection_uq UNIQUE(connection_id, local_outlet_id),
  CONSTRAINT lb02_outlet_mapping_approval_ck CHECK (
    (approval_status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (approval_status <> 'approved' AND approved_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS lb02_outlet_mapping_property_idx
  ON public.lb02_outlet_property_mappings(connection_id, local_property_id, approval_status);

CREATE OR REPLACE FUNCTION public.lb02_validate_outlet_mapping_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $lb02$
DECLARE
  v_location_tenant uuid;
  v_location_property uuid;
  v_connection public.staynas_product_connections%ROWTYPE;
BEGIN
  SELECT l.tenant_id, l.property_id
    INTO v_location_tenant, v_location_property
  FROM public.restaurant_locations l
  WHERE l.id = NEW.local_outlet_id;
  IF NOT FOUND OR v_location_tenant <> NEW.local_tenant_id OR v_location_property <> NEW.local_property_id THEN
    RAISE EXCEPTION 'LB-02 outlet must belong to the selected tenant and property' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO v_connection FROM public.staynas_product_connections WHERE id = NEW.connection_id;
  IF NOT FOUND OR v_connection.local_tenant_id <> NEW.local_tenant_id
     OR v_connection.local_property_id <> NEW.local_property_id
     OR v_connection.integration_property_id <> NEW.integration_property_id
     OR v_connection.remote_property_id <> NEW.remote_property_id
     OR v_connection.remote_product <> 'staynas'
     OR v_connection.status <> 'active'
     OR v_connection.local_approved_at IS NULL OR v_connection.remote_approved_at IS NULL THEN
    RAISE EXCEPTION 'LB-02 outlet mapping requires the matching active, mutually approved property connection' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$lb02$;
REVOKE ALL ON FUNCTION public.lb02_validate_outlet_mapping_scope() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS lb02_outlet_mapping_scope_guard ON public.lb02_outlet_property_mappings;
CREATE TRIGGER lb02_outlet_mapping_scope_guard
BEFORE INSERT OR UPDATE OF connection_id, local_tenant_id, local_property_id, local_outlet_id,
  integration_property_id, remote_property_id
ON public.lb02_outlet_property_mappings
FOR EACH ROW EXECUTE FUNCTION public.lb02_validate_outlet_mapping_scope();

CREATE TABLE IF NOT EXISTS public.lb02_inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  source_event_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version = 1),
  integration_property_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  processing_state text NOT NULL DEFAULT 'accepted'
    CHECK (processing_state IN ('accepted','applied','ignored_stale','dead_lettered')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 80),
  CONSTRAINT lb02_inbox_source_event_uq UNIQUE(connection_id, source_event_id),
  CONSTRAINT lb02_inbox_idempotency_uq UNIQUE(connection_id, idempotency_key),
  CONSTRAINT lb02_inbox_payload_no_pii_ck CHECK (
    NOT (payload ?| ARRAY['name','email','phone','address','dateOfBirth','guestName','guestEmail','guestPhone','guestId','bookingId'])
  )
);
CREATE INDEX IF NOT EXISTS lb02_inbox_processing_idx
  ON public.lb02_inbox_events(processing_state, received_at)
  WHERE processing_state IN ('accepted','dead_lettered');

CREATE TABLE IF NOT EXISTS public.lb02_guest_stay_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  integration_property_id uuid NOT NULL,
  guest_reference uuid NOT NULL,
  stay_reference uuid NOT NULL,
  stay_status text NOT NULL CHECK (stay_status IN ('expected','checked_in','checked_out','cancelled','no_show')),
  status_version bigint NOT NULL CHECK (status_version > 0),
  occurred_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT lb02_guest_stay_projection_uq UNIQUE(connection_id, stay_reference)
);
CREATE INDEX IF NOT EXISTS lb02_guest_stay_projection_guest_idx
  ON public.lb02_guest_stay_projections(connection_id, integration_property_id, guest_reference, stay_status);

CREATE TABLE IF NOT EXISTS public.lb02_dead_letter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  source_event_id uuid NOT NULL,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  failure_code text NOT NULL CHECK (length(failure_code) <= 80),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  replayed_at timestamptz,
  replayed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lb02_dlq_payload_no_pii_ck CHECK (
    NOT (payload ?| ARRAY['name','email','phone','address','dateOfBirth','guestName','guestEmail','guestPhone','guestId','bookingId'])
  )
);
CREATE INDEX IF NOT EXISTS lb02_dlq_connection_idx
  ON public.lb02_dead_letter_events(connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lb02_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.staynas_product_connections(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('accepted','retryable_failure','terminal_failure')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lb02_delivery_attempt_uq UNIQUE(connection_id, event_id, direction, attempt_number)
);

ALTER TABLE public.lb02_outlet_property_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb02_inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb02_guest_stay_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb02_dead_letter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lb02_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lb02_outlet_property_mappings, public.lb02_inbox_events,
  public.lb02_guest_stay_projections, public.lb02_dead_letter_events,
  public.lb02_delivery_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.lb02_outlet_property_mappings, public.lb02_inbox_events,
  public.lb02_guest_stay_projections, public.lb02_dead_letter_events,
  public.lb02_delivery_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.lb02_apply_stay_status_event(
  _connection_id uuid,
  _source_event_id uuid,
  _event_type text,
  _event_version integer,
  _integration_property_id uuid,
  _aggregate_id uuid,
  _aggregate_version bigint,
  _correlation_id text,
  _idempotency_key text,
  _payload jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $lb02$
DECLARE
  v_connection public.staynas_product_connections%ROWTYPE;
  v_guest_reference uuid;
  v_stay_reference uuid;
  v_status text;
  v_occurred_at timestamptz;
  v_effective_at timestamptz;
  v_inserted uuid;
  v_current_version bigint;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service authentication required' USING ERRCODE = '42501';
  END IF;
  IF _event_type <> 'guest.stay_status_changed.v1' OR _event_version <> 1
     OR _source_event_id IS NULL OR _aggregate_id IS NULL OR _aggregate_version < 1
     OR _idempotency_key IS NULL OR length(_idempotency_key) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(_payload) <> 'object'
     OR _payload ?| ARRAY['name','email','phone','address','dateOfBirth','guestName','guestEmail','guestPhone','guestId','bookingId'] THEN
    RAISE EXCEPTION 'Invalid LB-02 event contract' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_connection FROM public.staynas_product_connections
  WHERE id = _connection_id FOR SHARE;
  IF NOT FOUND OR v_connection.remote_product <> 'staynas'
     OR v_connection.status <> 'active'
     OR v_connection.local_approved_at IS NULL OR v_connection.remote_approved_at IS NULL
     OR v_connection.integration_property_id <> _integration_property_id
     OR v_connection.correlation_id <> _correlation_id THEN
    RAISE EXCEPTION 'LB-02 event connection/property scope rejected' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_guest_reference := (_payload->>'guestReference')::uuid;
    v_stay_reference := (_payload->>'stayReference')::uuid;
    v_status := _payload->>'status';
    v_occurred_at := (_payload->>'occurredAt')::timestamptz;
    v_effective_at := (_payload->>'effectiveAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid LB-02 stay projection payload' USING ERRCODE = '22023';
  END;
  IF v_guest_reference IS NULL OR v_stay_reference IS DISTINCT FROM _aggregate_id
     OR v_status NOT IN ('expected','checked_in','checked_out','cancelled','no_show')
     OR v_occurred_at IS NULL OR v_effective_at IS NULL
     OR (_payload->>'statusVersion')::bigint IS DISTINCT FROM _aggregate_version THEN
    RAISE EXCEPTION 'LB-02 stay projection identity/version rejected' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.lb02_inbox_events(
    connection_id, source_event_id, event_type, event_version, integration_property_id,
    aggregate_id, aggregate_version, correlation_id, idempotency_key, payload
  ) VALUES (
    _connection_id, _source_event_id, _event_type, _event_version, _integration_property_id,
    _aggregate_id, _aggregate_version, _correlation_id, _idempotency_key, _payload
  ) ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted;
  IF v_inserted IS NULL THEN
    RETURN 'duplicate';
  END IF;

  SELECT status_version INTO v_current_version
  FROM public.lb02_guest_stay_projections
  WHERE connection_id = _connection_id AND stay_reference = v_stay_reference
  FOR UPDATE;
  IF v_current_version IS NOT NULL AND _aggregate_version <= v_current_version THEN
    UPDATE public.lb02_inbox_events SET processing_state = 'ignored_stale', processed_at = now()
    WHERE id = v_inserted;
    RETURN 'ignored_stale';
  END IF;

  INSERT INTO public.lb02_guest_stay_projections(
    connection_id, integration_property_id, guest_reference, stay_reference,
    stay_status, status_version, occurred_at, effective_at, received_at, revoked_at
  ) VALUES (
    _connection_id, _integration_property_id, v_guest_reference, v_stay_reference,
    v_status, _aggregate_version, v_occurred_at, v_effective_at, now(),
    CASE WHEN v_status IN ('checked_out','cancelled','no_show') THEN now() ELSE NULL END
  )
  ON CONFLICT (connection_id, stay_reference) DO UPDATE SET
    integration_property_id = EXCLUDED.integration_property_id,
    guest_reference = EXCLUDED.guest_reference,
    stay_status = EXCLUDED.stay_status,
    status_version = EXCLUDED.status_version,
    occurred_at = EXCLUDED.occurred_at,
    effective_at = EXCLUDED.effective_at,
    received_at = now(),
    revoked_at = EXCLUDED.revoked_at;

  UPDATE public.lb02_inbox_events SET processing_state = 'applied', processed_at = now()
  WHERE id = v_inserted;
  RETURN 'applied';
END;
$lb02$;
REVOKE ALL ON FUNCTION public.lb02_apply_stay_status_event(uuid,uuid,text,integer,uuid,uuid,bigint,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lb02_apply_stay_status_event(uuid,uuid,text,integer,uuid,uuid,bigint,text,text,jsonb)
  TO service_role;

COMMIT;
