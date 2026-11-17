-- 0103 — harden property commercial activation gate.
--
-- A property is a commercial entitlement. Additional chargeable properties
-- may be CREATED by a tenant, but they are not operationally ACTIVE until
-- their property-specific commercial invoice is fully paid.
--
-- Defence in depth:
--   1. restaurant_properties defaults to pending_activation.
--   2. Direct active INSERTs are downgraded to pending_activation.
--   3. Activation requires an immutable commercial classification.
--   4. Chargeable activation requires a fully paid property-specific invoice.
--   5. A paid property invoice automatically promotes the pending property.
--   6. Active outlets/stores are forbidden under pending properties.
--   7. (tenant_id, property_sequence) is unique to prevent concurrent
--      commercial classification from silently duplicating entitlement order.
--
-- Existing ACTIVE properties are deliberately grandfathered. They are not
-- silently deactivated by this migration. If an existing chargeable property
-- is later deactivated, reactivation must pass the new payment gate.

ALTER TABLE public.restaurant_properties
  ALTER COLUMN status SET DEFAULT 'pending_activation';

ALTER TABLE public.restaurant_properties
  ADD CONSTRAINT restaurant_properties_status_check
  CHECK (status IN ('pending_activation','active','inactive'));

CREATE INDEX IF NOT EXISTS restaurant_properties_tenant_status_idx
  ON public.restaurant_properties (tenant_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_property_classifications_tenant_sequence_uq
  ON public.commercial_property_classifications (tenant_id, property_sequence);

CREATE OR REPLACE FUNCTION public.restaurant_property_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_chargeable boolean;
  v_classification text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    NEW.status := 'pending_activation';
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status = 'active'
     AND OLD.status IS DISTINCT FROM 'active' THEN

    SELECT c.chargeable, c.classification
      INTO v_chargeable, v_classification
    FROM public.commercial_property_classifications c
    WHERE c.property_id = NEW.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PROPERTY_ACTIVATION_CLASSIFICATION_REQUIRED',
        DETAIL = 'A property must be commercially classified before activation.';
    END IF;

    IF v_chargeable AND NOT EXISTS (
      SELECT 1
      FROM public.commercial_invoice_lines l
      JOIN public.commercial_invoices i ON i.id = l.invoice_id
      JOIN public.commercial_property_classifications c
        ON c.id = l.source_id
      WHERE l.source_type = 'property_classification'
        AND c.property_id = NEW.id
        AND i.status = 'paid'
        AND i.balance <= 0
        AND i.amount_paid >= i.total
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PROPERTY_ACTIVATION_PAYMENT_REQUIRED',
        DETAIL = format(
          'Chargeable property %s (%s) cannot become active until its property charge is fully paid.',
          NEW.name, v_classification
        );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restaurant_property_activation_guard
  ON public.restaurant_properties;

CREATE TRIGGER restaurant_property_activation_guard
BEFORE INSERT OR UPDATE OF status ON public.restaurant_properties
FOR EACH ROW
EXECUTE FUNCTION public.restaurant_property_activation_guard();

CREATE OR REPLACE FUNCTION public.restaurant_location_property_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_property_status text;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT p.status INTO v_property_status
    FROM public.restaurant_properties p
    WHERE p.id = NEW.property_id
      AND p.tenant_id = NEW.tenant_id;

    IF v_property_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PROPERTY_NOT_ACTIVE',
        DETAIL = 'An outlet or storage location cannot be activated under a property that is pending commercial activation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restaurant_location_property_activation_guard
  ON public.restaurant_locations;

CREATE TRIGGER restaurant_location_property_activation_guard
BEFORE INSERT OR UPDATE OF property_id, status ON public.restaurant_locations
FOR EACH ROW
EXECUTE FUNCTION public.restaurant_location_property_activation_guard();

CREATE OR REPLACE FUNCTION public.restaurant_activate_paid_property_from_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid'
     AND NEW.balance <= 0
     AND NEW.amount_paid >= NEW.total THEN

    FOR r IN
      SELECT DISTINCT
        p.id AS property_id,
        p.tenant_id,
        p.status AS old_status,
        c.id AS classification_id
      FROM public.commercial_invoice_lines l
      JOIN public.commercial_property_classifications c
        ON c.id = l.source_id
       AND l.source_type = 'property_classification'
      JOIN public.restaurant_properties p
        ON p.id = c.property_id
      WHERE l.invoice_id = NEW.id
        AND c.chargeable = true
        AND p.status = 'pending_activation'
    LOOP
      UPDATE public.restaurant_properties
      SET status = 'active', updated_at = now()
      WHERE id = r.property_id
        AND status = 'pending_activation';

      INSERT INTO public.commercial_audit_log (
        actor_id, action, entity_type, entity_id, tenant_id,
        before, after, reason, reference
      )
      VALUES (
        '00000000-0000-0000-0000-000000000000'::uuid,
        'property.activate',
        'restaurant_properties',
        r.property_id,
        r.tenant_id,
        jsonb_build_object('status', r.old_status),
        jsonb_build_object('status', 'active', 'classification_id', r.classification_id),
        'Automatic commercial activation after full payment of the additional-property charge.',
        NEW.invoice_number
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restaurant_invoice_paid_property_activation
  ON public.commercial_invoices;

CREATE TRIGGER restaurant_invoice_paid_property_activation
AFTER UPDATE OF status, amount_paid, balance ON public.commercial_invoices
FOR EACH ROW
EXECUTE FUNCTION public.restaurant_activate_paid_property_from_invoice();

REVOKE EXECUTE ON FUNCTION public.restaurant_property_activation_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restaurant_location_property_activation_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restaurant_activate_paid_property_from_invoice() FROM PUBLIC, anon, authenticated;
