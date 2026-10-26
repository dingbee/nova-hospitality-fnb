-- 0111 — tenant-wide central stores are independent of property activation.
--
-- A tenant-scoped central store has no property_id and is governed by tenant-wide
-- membership. The commercial activation gate applies only to property-scoped
-- outlets/stores. The previous trigger queried restaurant_properties using
-- NEW.property_id even for tenant-scoped locations, rejecting the central store.

CREATE OR REPLACE FUNCTION public.restaurant_location_property_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_property_status text;
BEGIN
  IF NEW.status = 'active'
     AND COALESCE(NEW.scope, 'property') <> 'tenant' THEN
    SELECT p.status INTO v_property_status
    FROM public.restaurant_properties p
    WHERE p.id = NEW.property_id
      AND p.tenant_id = NEW.tenant_id;

    IF v_property_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PROPERTY_NOT_ACTIVE',
        DETAIL = 'A property-scoped outlet or storage location cannot be activated under a property that is pending commercial activation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.restaurant_location_property_activation_guard()
  FROM PUBLIC, anon, authenticated;
