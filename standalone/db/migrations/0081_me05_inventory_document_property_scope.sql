-- ME-05 inventory integrity certification: inventory *document* tables were
-- never brought into the property-scope sweep that already covers the
-- ledger they write into and the purchase-order layer upstream of them
-- (mandate section 19, "tenant/property/outlet isolation ... mandatory").
--
-- Confirmed by reading both function bodies (0001_fnb_core.sql):
--   restaurant_can_write(tenant_id, roles)          -- ignores property entirely
--   restaurant_can_write_scoped(tenant_id, roles, property_id) -- checks it
--
-- restaurant_stock_movements (0074), restaurant_purchase_orders/_items
-- (0073) and restaurant_inventory_items (0075) were all migrated to the
-- scoped checks by the P1/P09/ME-01 sweeps. The following eleven tables
-- carry a property_id/location_id dimension (directly or via a parent
-- document) but were left on the plain tenant-wide check, unchanged since
-- their creation in 0001/0072-0074:
--
--   restaurant_goods_receipts / restaurant_goods_receipt_items
--   restaurant_stocktakes / restaurant_stocktake_lines
--   restaurant_purchase_requests / restaurant_purchase_request_items
--   restaurant_productions / restaurant_production_inputs
--   restaurant_inventory_batches
--   restaurant_procurement_variances
--   restaurant_stock_reservations
--
-- Net effect before this migration: a staff member whose restaurant_members
-- grant is scoped to one property (m.property_id set) could read and
-- write goods receipts, stocktakes, purchase requests, production runs,
-- batches, procurement variances and stock reservations for ANY other
-- property in the same tenant -- including posting a goods receipt (which
-- moves stock into the ledger) or a stocktake adjustment (which corrects
-- it) against a property they have no grant for. This is exactly the class
-- of hostile operation mandate section 19 requires be rejected ("receive
-- goods into another property", "adjust another outlet's inventory") and
-- the same shape of gap ME-04 (0078) fixed for financial tables.
--
-- Fix: the same pattern ME-04 used -- add a property-derivation helper for
-- each child table (mirroring restaurant_cash_payout_property /
-- restaurant_daily_close_property / restaurant_order_property, all
-- pre-existing), then switch every policy from the tenant-wide check to
-- the scoped one, preserving each table's existing role list exactly (no
-- new tightening beyond adding the property dimension -- that would be an
-- unproven, unrelated change this pass has no evidence for).

-- ---------------------------------------------------------------------
-- 1. Property-derivation helpers for the child/line tables.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restaurant_goods_receipt_property(_receipt_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(r.property_id, public.restaurant_location_property(r.location_id))
  FROM public.restaurant_goods_receipts r WHERE r.id = _receipt_id;
$$;
REVOKE ALL ON FUNCTION public.restaurant_goods_receipt_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_goods_receipt_property(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restaurant_stocktake_property(_stocktake_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(s.property_id, public.restaurant_location_property(s.location_id))
  FROM public.restaurant_stocktakes s WHERE s.id = _stocktake_id;
$$;
REVOKE ALL ON FUNCTION public.restaurant_stocktake_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_stocktake_property(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restaurant_purchase_request_property(_request_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(pr.property_id, public.restaurant_location_property(pr.location_id))
  FROM public.restaurant_purchase_requests pr WHERE pr.id = _request_id;
$$;
REVOKE ALL ON FUNCTION public.restaurant_purchase_request_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_purchase_request_property(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restaurant_production_property(_production_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.property_id FROM public.restaurant_productions p WHERE p.id = _production_id;
$$;
REVOKE ALL ON FUNCTION public.restaurant_production_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_production_property(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. restaurant_goods_receipts / restaurant_goods_receipt_items
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "receipt read" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt read scoped" ON public.restaurant_goods_receipts FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "receipt write (insert)" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt write scoped (insert)" ON public.restaurant_goods_receipts FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "receipt write (update)" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt write scoped (update)" ON public.restaurant_goods_receipts FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "receipt write (delete)" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt write scoped (delete)" ON public.restaurant_goods_receipts FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "receipt items read" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items read scoped" ON public.restaurant_goods_receipt_items FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_goods_receipt_property(receipt_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], restaurant_goods_receipt_property(receipt_id))
  );

DROP POLICY IF EXISTS "receipt items write (insert)" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items write scoped (insert)" ON public.restaurant_goods_receipt_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], restaurant_goods_receipt_property(receipt_id)));

DROP POLICY IF EXISTS "receipt items write (update)" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items write scoped (update)" ON public.restaurant_goods_receipt_items FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], restaurant_goods_receipt_property(receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], restaurant_goods_receipt_property(receipt_id)));

DROP POLICY IF EXISTS "receipt items write (delete)" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items write scoped (delete)" ON public.restaurant_goods_receipt_items FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], restaurant_goods_receipt_property(receipt_id)));

-- ---------------------------------------------------------------------
-- 3. restaurant_stocktakes / restaurant_stocktake_lines
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "stocktakes read" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes read scoped" ON public.restaurant_stocktakes FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "stocktakes write (insert)" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes write scoped (insert)" ON public.restaurant_stocktakes FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "stocktakes write (update)" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes write scoped (update)" ON public.restaurant_stocktakes FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "stocktakes write (delete)" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes write scoped (delete)" ON public.restaurant_stocktakes FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

-- Lines carry their own location_id (a stocktake can span locations for a
-- tenant/property scope); prefer it, fall back to the parent stocktake's
-- property when a line's own location is unset.
DROP POLICY IF EXISTS "stocktake lines read" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines read scoped" ON public.restaurant_stocktake_lines FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id)))
  );

DROP POLICY IF EXISTS "stocktake lines write (insert)" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines write scoped (insert)" ON public.restaurant_stocktake_lines FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id))));

DROP POLICY IF EXISTS "stocktake lines write (update)" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines write scoped (update)" ON public.restaurant_stocktake_lines FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id))));

DROP POLICY IF EXISTS "stocktake lines write (delete)" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines write scoped (delete)" ON public.restaurant_stocktake_lines FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(restaurant_location_property(location_id), restaurant_stocktake_property(stocktake_id))));

-- ---------------------------------------------------------------------
-- 4. restaurant_purchase_requests / restaurant_purchase_request_items
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "pr read" ON public.restaurant_purchase_requests;
CREATE POLICY "pr read scoped" ON public.restaurant_purchase_requests FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "pr write (insert)" ON public.restaurant_purchase_requests;
CREATE POLICY "pr write scoped (insert)" ON public.restaurant_purchase_requests FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "pr write (update)" ON public.restaurant_purchase_requests;
CREATE POLICY "pr write scoped (update)" ON public.restaurant_purchase_requests FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "pr write (delete)" ON public.restaurant_purchase_requests;
CREATE POLICY "pr write scoped (delete)" ON public.restaurant_purchase_requests FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "pr items read" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items read scoped" ON public.restaurant_purchase_request_items FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_purchase_request_property(purchase_request_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], restaurant_purchase_request_property(purchase_request_id))
  );

DROP POLICY IF EXISTS "pr items write (insert)" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items write scoped (insert)" ON public.restaurant_purchase_request_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], restaurant_purchase_request_property(purchase_request_id)));

DROP POLICY IF EXISTS "pr items write (update)" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items write scoped (update)" ON public.restaurant_purchase_request_items FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], restaurant_purchase_request_property(purchase_request_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], restaurant_purchase_request_property(purchase_request_id)));

DROP POLICY IF EXISTS "pr items write (delete)" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items write scoped (delete)" ON public.restaurant_purchase_request_items FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[], restaurant_purchase_request_property(purchase_request_id)));

-- ---------------------------------------------------------------------
-- 5. restaurant_productions / restaurant_production_inputs
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "productions read" ON public.restaurant_productions;
CREATE POLICY "productions read scoped" ON public.restaurant_productions FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, property_id)
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], property_id)
  );

DROP POLICY IF EXISTS "productions write (insert)" ON public.restaurant_productions;
CREATE POLICY "productions write scoped (insert)" ON public.restaurant_productions FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], property_id));

DROP POLICY IF EXISTS "productions write (update)" ON public.restaurant_productions;
CREATE POLICY "productions write scoped (update)" ON public.restaurant_productions FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], property_id));

DROP POLICY IF EXISTS "productions write (delete)" ON public.restaurant_productions;
CREATE POLICY "productions write scoped (delete)" ON public.restaurant_productions FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], property_id));

DROP POLICY IF EXISTS "production inputs read" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs read scoped" ON public.restaurant_production_inputs FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_production_property(production_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], restaurant_production_property(production_id))
  );

DROP POLICY IF EXISTS "production inputs write (insert)" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs write scoped (insert)" ON public.restaurant_production_inputs FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], restaurant_production_property(production_id)));

DROP POLICY IF EXISTS "production inputs write (update)" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs write scoped (update)" ON public.restaurant_production_inputs FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], restaurant_production_property(production_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], restaurant_production_property(production_id)));

DROP POLICY IF EXISTS "production inputs write (delete)" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs write scoped (delete)" ON public.restaurant_production_inputs FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[], restaurant_production_property(production_id)));

-- ---------------------------------------------------------------------
-- 6. restaurant_inventory_batches
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "inventory batches read" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches read scoped" ON public.restaurant_inventory_batches FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "inventory batches write (insert)" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches write scoped (insert)" ON public.restaurant_inventory_batches FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "inventory batches write (update)" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches write scoped (update)" ON public.restaurant_inventory_batches FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "inventory batches write (delete)" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches write scoped (delete)" ON public.restaurant_inventory_batches FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

-- ---------------------------------------------------------------------
-- 7. restaurant_procurement_variances
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "variance read" ON public.restaurant_procurement_variances;
CREATE POLICY "variance read scoped" ON public.restaurant_procurement_variances FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "variance write (insert)" ON public.restaurant_procurement_variances;
CREATE POLICY "variance write scoped (insert)" ON public.restaurant_procurement_variances FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "variance write (update)" ON public.restaurant_procurement_variances;
CREATE POLICY "variance write scoped (update)" ON public.restaurant_procurement_variances FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "variance write (delete)" ON public.restaurant_procurement_variances;
CREATE POLICY "variance write scoped (delete)" ON public.restaurant_procurement_variances FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

-- ---------------------------------------------------------------------
-- 8. restaurant_stock_reservations
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "stock reservations read" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations read scoped" ON public.restaurant_stock_reservations FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "stock reservations write (insert)" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations write scoped (insert)" ON public.restaurant_stock_reservations FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "stock reservations write (update)" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations write scoped (update)" ON public.restaurant_stock_reservations FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "stock reservations write (delete)" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations write scoped (delete)" ON public.restaurant_stock_reservations FOR DELETE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));
