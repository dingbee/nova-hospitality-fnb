-- P0-04: enforce active-location invariants at the PostgreSQL write boundary.
-- Application services also reject inactive locations, but direct database
-- writes must not be able to create new stock, transfer, reservation,
-- stocktake, receiving, batch or procurement records against an inactive
-- location. This trigger is a data-integrity guard only: existing RLS policies
-- remain the authorization boundary and are not weakened or replaced.
--
-- SECURITY DEFINER is used solely so the integrity lookup can see the
-- referenced location even when RLS would hide it from the writing user.
-- The function accepts only row values, uses no dynamic SQL, qualifies the
-- referenced table, and pins search_path. RLS still decides whether the
-- caller may write the target row.

CREATE OR REPLACE FUNCTION public.restaurant_guard_active_inventory_locations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $p0_04$
DECLARE
  v_tenant_id uuid;
  v_location_id uuid;
  v_location_ids uuid[];
  v_status text;
BEGIN
  v_tenant_id := NULLIF(to_jsonb(NEW)->>'tenant_id', '')::uuid;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Inventory transaction requires a tenant id.'
      USING ERRCODE = '23514';
  END IF;

  -- Reversals remain possible against an inactive location so an existing
  -- ledger fact can still be corrected without reopening that location.
  IF TG_TABLE_NAME = 'restaurant_stock_movements'
     AND to_jsonb(NEW)->>'movement_type' = 'reversal' THEN
    RETURN NEW;
  END IF;

  v_location_ids := ARRAY[
    NULLIF(to_jsonb(NEW)->>'location_id', '')::uuid,
    NULLIF(to_jsonb(NEW)->>'destination_location_id', '')::uuid,
    NULLIF(to_jsonb(NEW)->>'source_location_id', '')::uuid,
    NULLIF(to_jsonb(NEW)->>'storage_location_id', '')::uuid
  ];

  FOREACH v_location_id IN ARRAY v_location_ids LOOP
    IF v_location_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT l.status
      INTO v_status
      FROM public.restaurant_locations l
     WHERE l.tenant_id = v_tenant_id
       AND l.id = v_location_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location % does not belong to tenant %.', v_location_id, v_tenant_id
        USING ERRCODE = '23503';
    END IF;

    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Location % is inactive and cannot accept new inventory transactions.', v_location_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$p0_04$;

REVOKE ALL ON FUNCTION public.restaurant_guard_active_inventory_locations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS p0_04_active_locations_inventory_items ON public.restaurant_inventory_items;
CREATE TRIGGER p0_04_active_locations_inventory_items
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_inventory_batches ON public.restaurant_inventory_batches;
CREATE TRIGGER p0_04_active_locations_inventory_batches
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_inventory_batches
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_stock_movements ON public.restaurant_stock_movements;
CREATE TRIGGER p0_04_active_locations_stock_movements
  BEFORE INSERT OR UPDATE OF location_id, destination_location_id ON public.restaurant_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_stock_transfers ON public.restaurant_stock_transfers;
CREATE TRIGGER p0_04_active_locations_stock_transfers
  BEFORE INSERT OR UPDATE OF source_location_id, destination_location_id ON public.restaurant_stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_reservations ON public.restaurant_stock_reservations;
CREATE TRIGGER p0_04_active_locations_reservations
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_stocktakes ON public.restaurant_stocktakes;
CREATE TRIGGER p0_04_active_locations_stocktakes
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_stocktakes
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_goods_receipts ON public.restaurant_goods_receipts;
CREATE TRIGGER p0_04_active_locations_goods_receipts
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_goods_receipt_items ON public.restaurant_goods_receipt_items;
CREATE TRIGGER p0_04_active_locations_goods_receipt_items
  BEFORE INSERT OR UPDATE OF storage_location_id ON public.restaurant_goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_purchase_requests ON public.restaurant_purchase_requests;
CREATE TRIGGER p0_04_active_locations_purchase_requests
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_purchase_orders ON public.restaurant_purchase_orders;
CREATE TRIGGER p0_04_active_locations_purchase_orders
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();

DROP TRIGGER IF EXISTS p0_04_active_locations_supplier_invoices ON public.restaurant_supplier_invoices;
CREATE TRIGGER p0_04_active_locations_supplier_invoices
  BEFORE INSERT OR UPDATE OF location_id ON public.restaurant_supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_active_inventory_locations();
