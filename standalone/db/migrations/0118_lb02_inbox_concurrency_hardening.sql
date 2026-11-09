-- LB-02 inbox concurrency hardening: serialize event application per connection/stay aggregate.
BEGIN;
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
     OR _payload - ARRAY['guestReference','stayReference','propertyReference','status','statusVersion','occurredAt','effectiveAt']::text[] <> '{}'::jsonb THEN
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
  PERFORM pg_advisory_xact_lock(hashtextextended(_connection_id::text || ':' || _aggregate_id::text, 0));
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
  IF v_inserted IS NULL THEN RETURN 'duplicate'; END IF;

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
COMMIT;