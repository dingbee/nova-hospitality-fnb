-- WCE-06 — native guest table reservations and scoped hosted-payment support.
-- This migration is isolated/replay-tested only; it is not a production migration instruction.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_properties_id_tenant_uq
  ON public.restaurant_properties (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_locations_id_scope_uq
  ON public.restaurant_locations (id, tenant_id, property_id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_id_scope_uq
  ON public.restaurant_tables (id, tenant_id, property_id, location_id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_guest_customers_id_tenant_uq
  ON public.restaurant_guest_customers (id, tenant_id);

CREATE TABLE IF NOT EXISTS public.restaurant_table_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  property_id uuid NOT NULL,
  location_id uuid NOT NULL,
  table_id uuid,
  guest_customer_id uuid,
  booking_reference text NOT NULL,
  guest_name text NOT NULL,
  guest_phone_e164 text NOT NULL,
  guest_email text,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 30),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('requested', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
  source text NOT NULL DEFAULT 'guest_portal'
    CHECK (source IN ('guest_portal', 'whatsapp', 'staff')),
  client_request_id text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_table_reservations_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT restaurant_table_reservations_phone_ck CHECK (guest_phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
  CONSTRAINT restaurant_table_reservations_booking_reference_uq UNIQUE (tenant_id, booking_reference),
  CONSTRAINT restaurant_table_reservations_request_uq UNIQUE (tenant_id, client_request_id),
  CONSTRAINT restaurant_table_reservations_property_fk
    FOREIGN KEY (property_id, tenant_id)
    REFERENCES public.restaurant_properties (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT restaurant_table_reservations_location_fk
    FOREIGN KEY (location_id, tenant_id, property_id)
    REFERENCES public.restaurant_locations (id, tenant_id, property_id) ON DELETE CASCADE,
  CONSTRAINT restaurant_table_reservations_table_fk
    FOREIGN KEY (table_id, tenant_id, property_id, location_id)
    REFERENCES public.restaurant_tables (id, tenant_id, property_id, location_id) ON DELETE SET NULL (table_id),
  CONSTRAINT restaurant_table_reservations_guest_fk
    FOREIGN KEY (guest_customer_id, tenant_id)
    REFERENCES public.restaurant_guest_customers (id, tenant_id) ON DELETE SET NULL (guest_customer_id)
);

CREATE INDEX IF NOT EXISTS restaurant_table_reservations_slot_idx
  ON public.restaurant_table_reservations
    (tenant_id, property_id, location_id, starts_at, ends_at)
  WHERE status IN ('requested', 'confirmed', 'seated');
CREATE INDEX IF NOT EXISTS restaurant_table_reservations_guest_idx
  ON public.restaurant_table_reservations (tenant_id, guest_customer_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_table_reservations_table_idx
  ON public.restaurant_table_reservations (tenant_id, table_id, starts_at, ends_at)
  WHERE table_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_table_reservations TO authenticated;
GRANT ALL ON public.restaurant_table_reservations TO service_role;
ALTER TABLE public.restaurant_table_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guest reservations readable by scoped managers"
  ON public.restaurant_table_reservations FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner', 'general_manager', 'restaurant_manager']::public.restaurant_role[],
    property_id
  ));
CREATE POLICY "guest reservations manageable by scoped managers"
  ON public.restaurant_table_reservations FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner', 'general_manager', 'restaurant_manager']::public.restaurant_role[],
    property_id
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner', 'general_manager', 'restaurant_manager']::public.restaurant_role[],
    property_id
  ));

CREATE OR REPLACE FUNCTION public.restaurant_create_guest_table_reservation(
  _tenant_id uuid,
  _property_id uuid,
  _location_id uuid,
  _guest_customer_id uuid,
  _guest_name text,
  _guest_phone_e164 text,
  _guest_email text,
  _party_size integer,
  _starts_at timestamptz,
  _duration_minutes integer,
  _client_request_id text
)
RETURNS TABLE (
  reservation_id uuid,
  booking_reference text,
  table_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  reservation_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.restaurant_table_reservations%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_ends_at timestamptz;
  v_reference text;
  v_now timestamptz := now();
BEGIN
  IF _party_size IS NULL OR _party_size < 1 OR _party_size > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_PARTY_SIZE';
  END IF;
  IF _duration_minutes IS NULL OR _duration_minutes < 30 OR _duration_minutes > 240 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_RESERVATION_DURATION';
  END IF;
  IF _starts_at IS NULL OR _starts_at < v_now + interval '15 minutes'
     OR _starts_at > v_now + interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_RESERVATION_TIME';
  END IF;
  IF coalesce(length(trim(_guest_name)), 0) = 0 OR length(trim(_guest_name)) > 160 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_GUEST_NAME';
  END IF;
  IF _guest_phone_e164 !~ '^\\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_GUEST_PHONE';
  END IF;
  IF coalesce(length(trim(_client_request_id)), 0) < 8 OR length(_client_request_id) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_RESERVATION_REQUEST_ID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.restaurant_properties p
    WHERE p.id = _property_id AND p.tenant_id = _tenant_id AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'PROPERTY_SCOPE_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.restaurant_locations l
    WHERE l.id = _location_id AND l.tenant_id = _tenant_id
      AND l.property_id = _property_id AND l.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'OUTLET_SCOPE_INVALID';
  END IF;
  IF _guest_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.restaurant_guest_customers g
    WHERE g.id = _guest_customer_id AND g.tenant_id = _tenant_id AND g.status <> 'blocked'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'GUEST_IDENTITY_INVALID';
  END IF;

  -- Serialize table assignment for the same property/outlet/day. This lock
  -- is held through table selection and insertion, preventing overlapping
  -- guest requests from claiming the same table concurrently.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(_tenant_id::text || ':' || _location_id::text, 0)
  );

  SELECT * INTO v_existing
  FROM public.restaurant_table_reservations r
  WHERE r.tenant_id = _tenant_id AND r.client_request_id = _client_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, v_existing.booking_reference, v_existing.table_id,
      v_existing.starts_at, v_existing.ends_at, v_existing.status;
    RETURN;
  END IF;

  v_ends_at := _starts_at + make_interval(mins => _duration_minutes);
  SELECT t.* INTO v_table
  FROM public.restaurant_tables t
  WHERE t.tenant_id = _tenant_id
    AND t.property_id = _property_id
    AND t.location_id = _location_id
    AND t.active = true
    AND t.status <> 'out_of_service'
    AND t.seats >= _party_size
    AND NOT EXISTS (
      SELECT 1
      FROM public.restaurant_table_reservations r
      WHERE r.tenant_id = _tenant_id
        AND r.table_id = t.id
        AND r.status IN ('requested', 'confirmed', 'seated')
        AND r.starts_at < v_ends_at
        AND r.ends_at > _starts_at
    )
  ORDER BY t.seats ASC, t.code ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NO_TABLE_AVAILABLE';
  END IF;

  v_reference := 'R-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  INSERT INTO public.restaurant_table_reservations (
    tenant_id, property_id, location_id, table_id, guest_customer_id,
    booking_reference, guest_name, guest_phone_e164, guest_email,
    party_size, starts_at, ends_at, status, source, client_request_id
  ) VALUES (
    _tenant_id, _property_id, _location_id, v_table.id, _guest_customer_id,
    v_reference, trim(_guest_name), _guest_phone_e164, nullif(trim(_guest_email), ''),
    _party_size, _starts_at, v_ends_at, 'confirmed', 'guest_portal', _client_request_id
  )
  RETURNING id INTO reservation_id;

  booking_reference := v_reference;
  table_id := v_table.id;
  starts_at := _starts_at;
  ends_at := v_ends_at;
  reservation_status := 'confirmed';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_create_guest_table_reservation(
  uuid, uuid, uuid, uuid, text, text, text, integer, timestamptz, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_create_guest_table_reservation(
  uuid, uuid, uuid, uuid, text, text, text, integer, timestamptz, integer, text
) TO service_role;

COMMIT;
