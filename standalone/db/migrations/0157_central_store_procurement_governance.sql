-- 0157 — Central store & procurement governance.
--
-- Root causes closed here (all verified against the replayed schema):
--
--  1. restaurant_purchase_orders accepted rows with BOTH property_id and
--     location_id NULL. Nothing resolved the tenant's configured central
--     store, so an omitted destination silently produced an unassigned order.
--  2. Supplier status was never consulted: an inactive supplier could be put
--     on a new order and carried through submission and approval.
--  3. Zero / missing prices and unreconciled totals could pass submission and
--     approval; order lines could still be edited after the order left draft.
--  4. PO / PO-line / goods-receipt / variance RLS used restaurant_can_write_scoped,
--     which treats a NULL property as "tenant-wide resource" and therefore lets
--     ANY property-scoped purchasing role read and write central-store and
--     unassigned orders. 0110 already established for restaurant_locations that
--     a tenant central store is reachable only through an explicit tenant-wide
--     membership; this migration applies the same rule to procurement rows.
--
-- Safety:
--  * Additive only. No row is updated or deleted. Existing orders (including
--    any historical order created before a supplier was deactivated) are left
--    exactly as they are: the guards evaluate only NEW inserts, changes to the
--    governed columns, and transitions INTO submitted/approved. Cancelling a
--    legacy order remains possible.
--  * New CHECK constraints are NOT VALID: they govern new and changed rows
--    without re-validating history.
--  * Rollback: DROP the two triggers + functions created below and re-run the
--    policy definitions from 0027/0134 (non-strict helpers). The new columns
--    are nullable and can be left in place.

-- ---------------------------------------------------------------------------
-- 1. Strict write helper: NULL property means "tenant-wide grant required".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped_strict(
  _tenant_id uuid,
  _roles public.restaurant_role[],
  _property_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT auth.uid() IS NOT NULL
    AND (
      public.restaurant_is_platform_admin(auth.uid())
      OR (
        EXISTS (
          SELECT 1
          FROM public.restaurant_members m
          WHERE m.tenant_id = _tenant_id
            AND m.user_id = auth.uid()
            AND m.role = ANY(_roles)
            AND (
              (_property_id IS NOT NULL AND (m.property_id IS NULL OR m.property_id = _property_id))
              OR (_property_id IS NULL AND m.property_id IS NULL)
            )
        )
        AND (
          _property_id IS NULL
          OR EXISTS (
            SELECT 1 FROM public.restaurant_properties p
            WHERE p.id = _property_id AND p.tenant_id = _tenant_id
          )
        )
        AND public.restaurant_member_active(auth.uid(), _tenant_id)
      )
    );
$f$;

REVOKE ALL ON FUNCTION public.restaurant_can_write_scoped_strict(uuid, public.restaurant_role[], uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_can_write_scoped_strict(uuid, public.restaurant_role[], uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Single authoritative central-store resolution.
--
-- The central store is the tenant's restaurant_locations row with
-- scope = 'tenant' (0110). It is resolved here, once, for every consumer:
-- server services call it through RPC, and the PO guard below uses the same
-- rules. SECURITY DEFINER so a property-only member can learn the store's
-- identity (needed to route requisitions/transfers to it) without RLS
-- granting them the row itself; callers outside the tenant are refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_central_store_resolution(_tenant_id uuid)
RETURNS TABLE (
  resolution text,
  location_id uuid,
  location_name text,
  location_code text,
  location_status text,
  detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $f$
DECLARE
  v_count integer;
  v_row record;
BEGIN
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'CENTRAL_STORE_TENANT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- service_role (no auth.uid()) is trusted server code; everyone else must
  -- be an active member of this tenant or a platform admin.
  IF auth.uid() IS NOT NULL
     AND NOT public.restaurant_is_platform_admin(auth.uid())
     AND NOT (
       EXISTS (
         SELECT 1 FROM public.restaurant_members m
         WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
       )
       AND public.restaurant_member_active(auth.uid(), _tenant_id)
     ) THEN
    RAISE EXCEPTION 'Forbidden — you do not belong to this restaurant tenant.'
      USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL AND current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'Forbidden — authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restaurant_locations l
  WHERE l.tenant_id = _tenant_id AND l.scope = 'tenant';

  IF v_count = 0 THEN
    RETURN QUERY SELECT 'not_configured'::text, NULL::uuid, NULL::text, NULL::text, NULL::text,
      'No tenant-level central store is configured; property-level purchasing applies.'::text;
    RETURN;
  END IF;

  IF v_count > 1 THEN
    RETURN QUERY SELECT 'ambiguous'::text, NULL::uuid, NULL::text, NULL::text, NULL::text,
      format('%s tenant-level central stores are configured; exactly one is required.', v_count);
    RETURN;
  END IF;

  SELECT l.id, l.name, l.code, l.status, l.is_storage, l.property_id, l.parent_id
    INTO v_row
  FROM public.restaurant_locations l
  WHERE l.tenant_id = _tenant_id AND l.scope = 'tenant';

  IF v_row.is_storage IS NOT TRUE OR v_row.property_id IS NOT NULL OR v_row.parent_id IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, v_row.id, v_row.name, v_row.code, v_row.status,
      'The central store must be storage-enabled, tenant-scoped and have no property or parent.'::text;
    RETURN;
  END IF;

  IF v_row.status IS DISTINCT FROM 'active' THEN
    RETURN QUERY SELECT 'inactive'::text, v_row.id, v_row.name, v_row.code, v_row.status,
      'The central store is configured but not active.'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'active'::text, v_row.id, v_row.name, v_row.code, v_row.status, NULL::text;
END;
$f$;

REVOKE ALL ON FUNCTION public.restaurant_central_store_resolution(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_central_store_resolution(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Purchase-order line columns for an explicit, authorised price exception.
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_purchase_order_items
  ADD COLUMN IF NOT EXISTS price_exception_reason text,
  ADD COLUMN IF NOT EXISTS price_exception_authorised_by uuid,
  ADD COLUMN IF NOT EXISTS price_exception_authorised_at timestamptz;

COMMENT ON COLUMN public.restaurant_purchase_order_items.price_exception_reason IS
  'Mandatory justification when a line is ordered at a zero unit price (sample, complimentary, supplier-funded). Authorised by a purchasing.approve holder.';

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_po_items_non_negative_amounts'
      AND conrelid = 'public.restaurant_purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_order_items
      ADD CONSTRAINT restaurant_po_items_non_negative_amounts
      CHECK (unit_price >= 0 AND quantity >= 0 AND line_total >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_po_items_price_exception_complete'
      AND conrelid = 'public.restaurant_purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_order_items
      ADD CONSTRAINT restaurant_po_items_price_exception_complete
      CHECK (
        price_exception_reason IS NULL
        OR (char_length(btrim(price_exception_reason)) >= 10 AND price_exception_authorised_by IS NOT NULL)
      ) NOT VALID;
  END IF;
END;
$c$;

-- ---------------------------------------------------------------------------
-- 4. Purchase-order governance guard (header).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_enforce_purchase_order_governance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $f$
DECLARE
  v_loc record;
  v_supplier_status text;
  v_line_count integer;
  v_bad record;
  v_line_sum numeric;
  v_entering_commitment boolean;
BEGIN
  -- Destination: evaluated when the row is created or its destination changes.
  IF TG_OP = 'INSERT'
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    IF NEW.location_id IS NULL AND NEW.property_id IS NULL THEN
      RAISE EXCEPTION 'PO_DESTINATION_UNRESOLVED'
        USING ERRCODE = '23514',
              DETAIL = 'A purchase order must name a destination location or property; an unassigned order is never created.';
    END IF;
    IF NEW.location_id IS NOT NULL THEN
      SELECT l.scope, l.property_id, l.is_storage
        INTO v_loc
      FROM public.restaurant_locations l
      WHERE l.id = NEW.location_id AND l.tenant_id = NEW.tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PO_DESTINATION_NOT_IN_TENANT' USING ERRCODE = '23503';
      END IF;
      IF v_loc.scope = 'tenant' AND NEW.property_id IS NOT NULL THEN
        RAISE EXCEPTION 'PO_DESTINATION_SCOPE_MISMATCH'
          USING ERRCODE = '23514',
                DETAIL = 'A central-store order is tenant-scoped; the originating property belongs in metadata, not property_id.';
      END IF;
      IF v_loc.scope = 'property' AND NEW.property_id IS DISTINCT FROM v_loc.property_id THEN
        RAISE EXCEPTION 'PO_DESTINATION_SCOPE_MISMATCH'
          USING ERRCODE = '23514',
                DETAIL = 'The order property must be the destination location''s property.';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (NEW.currency IS NULL OR NEW.currency !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'PO_CURRENCY_INVALID' USING ERRCODE = '23514';
  END IF;

  -- Supplier eligibility when a supplier is put on (or changed on) an order.
  IF NEW.supplier_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id) THEN
    SELECT s.status INTO v_supplier_status
    FROM public.restaurant_suppliers s
    WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_SUPPLIER_NOT_IN_TENANT'
        USING ERRCODE = '23503',
              DETAIL = 'The supplier does not belong to this tenant.';
    END IF;
    IF v_supplier_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'PO_SUPPLIER_INACTIVE'
        USING ERRCODE = '23514',
              DETAIL = 'Only an active supplier may be placed on a purchase order.';
    END IF;
  END IF;

  v_entering_commitment :=
    NEW.status::text IN ('submitted', 'approved')
    AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status);

  IF v_entering_commitment THEN
    IF NEW.location_id IS NULL AND NEW.property_id IS NULL THEN
      RAISE EXCEPTION 'PO_DESTINATION_UNRESOLVED'
        USING ERRCODE = '23514',
              DETAIL = 'An order without a destination cannot be submitted or approved.';
    END IF;

    IF NEW.supplier_id IS NULL THEN
      RAISE EXCEPTION 'PO_SUPPLIER_REQUIRED' USING ERRCODE = '23514';
    END IF;
    SELECT s.status INTO v_supplier_status
    FROM public.restaurant_suppliers s
    WHERE s.id = NEW.supplier_id AND s.tenant_id = NEW.tenant_id;
    IF v_supplier_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'PO_SUPPLIER_INACTIVE'
        USING ERRCODE = '23514',
              DETAIL = 'The supplier is not active; this order cannot be submitted or approved.';
    END IF;

    SELECT count(*), coalesce(sum(i.line_total), 0)
      INTO v_line_count, v_line_sum
    FROM public.restaurant_purchase_order_items i
    WHERE i.purchase_order_id = NEW.id AND i.tenant_id = NEW.tenant_id;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION 'PO_NO_LINES' USING ERRCODE = '23514';
    END IF;

    SELECT i.description, i.quantity, i.unit_price, i.line_total, i.price_exception_reason
      INTO v_bad
    FROM public.restaurant_purchase_order_items i
    WHERE i.purchase_order_id = NEW.id AND i.tenant_id = NEW.tenant_id
      AND (
        i.quantity IS NULL OR i.quantity <= 0
        OR i.unit_price IS NULL OR i.unit_price < 0
        OR (i.unit_price = 0 AND (
              i.price_exception_reason IS NULL
              OR char_length(btrim(i.price_exception_reason)) < 10
              OR i.price_exception_authorised_by IS NULL))
        OR abs(i.line_total - round(i.quantity * i.unit_price, 2)) > 0.01
      )
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PO_LINE_INVALID'
        USING ERRCODE = '23514',
              DETAIL = format(
                'Line "%s" (quantity %s, unit price %s, line total %s) needs a positive quantity, a positive unit price (or an authorised zero-price exception) and a server-calculated line total.',
                v_bad.description, v_bad.quantity, v_bad.unit_price, v_bad.line_total);
    END IF;

    IF abs(NEW.subtotal - v_line_sum) > 0.01
       OR abs(NEW.total - (NEW.subtotal + NEW.tax_total - NEW.discount_total)) > 0.01 THEN
      RAISE EXCEPTION 'PO_TOTALS_UNRECONCILED'
        USING ERRCODE = '23514',
              DETAIL = format('Lines sum to %s; order subtotal %s, total %s.', v_line_sum, NEW.subtotal, NEW.total);
    END IF;

    IF NEW.status::text = 'approved' AND NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'PO_APPROVER_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$f$;

REVOKE EXECUTE ON FUNCTION public.restaurant_enforce_purchase_order_governance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS restaurant_po_governance ON public.restaurant_purchase_orders;
CREATE TRIGGER restaurant_po_governance
  BEFORE INSERT OR UPDATE ON public.restaurant_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_enforce_purchase_order_governance();

-- ---------------------------------------------------------------------------
-- 5. Commercial lines are frozen once the order leaves draft.
-- Fulfilment counters (received/accepted/rejected) and supplier confirmation
-- columns remain writable: they are facts recorded against the order, not
-- edits to what was ordered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_guard_purchase_order_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $f$
DECLARE
  v_status text;
  v_po_id uuid;
  v_tenant uuid;
BEGIN
  v_po_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_order_id ELSE NEW.purchase_order_id END;
  v_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  SELECT po.status::text INTO v_status
  FROM public.restaurant_purchase_orders po
  WHERE po.id = v_po_id AND po.tenant_id = v_tenant;

  IF TG_OP = 'UPDATE'
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.line_total IS NOT DISTINCT FROM OLD.line_total
     AND NEW.inventory_item_id IS NOT DISTINCT FROM OLD.inventory_item_id
     AND NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id
     AND NEW.price_exception_reason IS NOT DISTINCT FROM OLD.price_exception_reason
     AND NEW.price_exception_authorised_by IS NOT DISTINCT FROM OLD.price_exception_authorised_by
     AND NEW.purchase_order_id IS NOT DISTINCT FROM OLD.purchase_order_id THEN
    RETURN NEW;
  END IF;

  -- Parent already gone (cascade delete of a draft) — nothing to protect.
  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'PO_LINES_LOCKED'
      USING ERRCODE = '23514',
            DETAIL = format('Order lines cannot be added, edited or removed once the order is %s.', v_status);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$f$;

REVOKE EXECUTE ON FUNCTION public.restaurant_guard_purchase_order_lines() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS restaurant_po_lines_locked ON public.restaurant_purchase_order_items;
CREATE TRIGGER restaurant_po_lines_locked
  BEFORE INSERT OR UPDATE OR DELETE ON public.restaurant_purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_purchase_order_lines();

-- ---------------------------------------------------------------------------
-- 6. Strict NULL-scope RLS for procurement rows.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "po read scoped" ON public.restaurant_purchase_orders;
CREATE POLICY "po read scoped" ON public.restaurant_purchase_orders
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(tenant_id, property_id));

DROP POLICY IF EXISTS "po write scoped (insert)" ON public.restaurant_purchase_orders;
CREATE POLICY "po write scoped (insert)" ON public.restaurant_purchase_orders
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    property_id));

DROP POLICY IF EXISTS "po write scoped (update)" ON public.restaurant_purchase_orders;
CREATE POLICY "po write scoped (update)" ON public.restaurant_purchase_orders
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    property_id))
  WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    property_id));

DROP POLICY IF EXISTS "po write scoped (delete)" ON public.restaurant_purchase_orders;
CREATE POLICY "po write scoped (delete)" ON public.restaurant_purchase_orders
  FOR DELETE TO authenticated
  USING (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    property_id));

DROP POLICY IF EXISTS "po items read scoped" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items read scoped" ON public.restaurant_purchase_order_items
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(tenant_id,
    public.restaurant_purchase_order_property(purchase_order_id)));

DROP POLICY IF EXISTS "po items write scoped (insert)" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items write scoped (insert)" ON public.restaurant_purchase_order_items
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    public.restaurant_purchase_order_property(purchase_order_id)));

DROP POLICY IF EXISTS "po items write scoped (update)" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items write scoped (update)" ON public.restaurant_purchase_order_items
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    public.restaurant_purchase_order_property(purchase_order_id)))
  WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    public.restaurant_purchase_order_property(purchase_order_id)));

DROP POLICY IF EXISTS "po items write scoped (delete)" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items write scoped (delete)" ON public.restaurant_purchase_order_items
  FOR DELETE TO authenticated
  USING (public.restaurant_can_write_scoped_strict(tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[],
    public.restaurant_purchase_order_property(purchase_order_id)));

-- Goods receipts, receipt lines and variances keep their existing role sets;
-- only the NULL-scope interpretation becomes strict.
DO $p$
DECLARE
  v_roles text := $r$ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::public.restaurant_role[]$r$;
  v_scope_receipt text := 'COALESCE(property_id, public.restaurant_location_property(location_id))';
  v_scope_item text := 'public.restaurant_goods_receipt_property(receipt_id)';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "receipt read scoped" ON public.restaurant_goods_receipts';
  EXECUTE format('CREATE POLICY "receipt read scoped" ON public.restaurant_goods_receipts FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped_strict(tenant_id, %s))', v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "receipt write scoped (insert)" ON public.restaurant_goods_receipts';
  EXECUTE format('CREATE POLICY "receipt write scoped (insert)" ON public.restaurant_goods_receipts FOR INSERT TO authenticated WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "receipt write scoped (update)" ON public.restaurant_goods_receipts';
  EXECUTE format('CREATE POLICY "receipt write scoped (update)" ON public.restaurant_goods_receipts FOR UPDATE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s)) WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s))', v_roles, v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "receipt write scoped (delete)" ON public.restaurant_goods_receipts';
  EXECUTE format('CREATE POLICY "receipt write scoped (delete)" ON public.restaurant_goods_receipts FOR DELETE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_receipt);

  EXECUTE 'DROP POLICY IF EXISTS "receipt items read scoped" ON public.restaurant_goods_receipt_items';
  EXECUTE format('CREATE POLICY "receipt items read scoped" ON public.restaurant_goods_receipt_items FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped_strict(tenant_id, %s))', v_scope_item);
  EXECUTE 'DROP POLICY IF EXISTS "receipt items write scoped (insert)" ON public.restaurant_goods_receipt_items';
  EXECUTE format('CREATE POLICY "receipt items write scoped (insert)" ON public.restaurant_goods_receipt_items FOR INSERT TO authenticated WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_item);
  EXECUTE 'DROP POLICY IF EXISTS "receipt items write scoped (update)" ON public.restaurant_goods_receipt_items';
  EXECUTE format('CREATE POLICY "receipt items write scoped (update)" ON public.restaurant_goods_receipt_items FOR UPDATE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s)) WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s))', v_roles, v_scope_item);
  EXECUTE 'DROP POLICY IF EXISTS "receipt items write scoped (delete)" ON public.restaurant_goods_receipt_items';
  EXECUTE format('CREATE POLICY "receipt items write scoped (delete)" ON public.restaurant_goods_receipt_items FOR DELETE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_item);

  EXECUTE 'DROP POLICY IF EXISTS "variance read scoped" ON public.restaurant_procurement_variances';
  EXECUTE format('CREATE POLICY "variance read scoped" ON public.restaurant_procurement_variances FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped_strict(tenant_id, %s))', v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "variance write scoped (insert)" ON public.restaurant_procurement_variances';
  EXECUTE format('CREATE POLICY "variance write scoped (insert)" ON public.restaurant_procurement_variances FOR INSERT TO authenticated WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "variance write scoped (update)" ON public.restaurant_procurement_variances';
  EXECUTE format('CREATE POLICY "variance write scoped (update)" ON public.restaurant_procurement_variances FOR UPDATE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s)) WITH CHECK (public.restaurant_can_write_scoped_strict(tenant_id, %1$s, %2$s))', v_roles, v_scope_receipt);
  EXECUTE 'DROP POLICY IF EXISTS "variance write scoped (delete)" ON public.restaurant_procurement_variances';
  EXECUTE format('CREATE POLICY "variance write scoped (delete)" ON public.restaurant_procurement_variances FOR DELETE TO authenticated USING (public.restaurant_can_write_scoped_strict(tenant_id, %s, %s))', v_roles, v_scope_receipt);
END;
$p$;

-- ---------------------------------------------------------------------------
-- 7. Fulfilment increment uses the same strict scope as the order itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_increment_po_item_fulfilment(
  _tenant uuid, _po_item_id uuid,
  _received_delta numeric, _accepted_delta numeric, _rejected_delta numeric
)
RETURNS TABLE(out_id uuid, out_received_quantity numeric, out_accepted_quantity numeric, out_rejected_quantity numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  _po_id uuid;
begin
  select t.purchase_order_id into _po_id
  from public.restaurant_purchase_order_items t
  where t.tenant_id = _tenant and t.id = _po_item_id;

  if _po_id is null then
    raise exception 'Purchase order item not found for this tenant.';
  end if;

  if not public.restaurant_can_write_scoped_strict(
    _tenant,
    array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[],
    public.restaurant_purchase_order_property(_po_id)
  ) then
    raise exception 'Forbidden — insufficient role to post receiving against this purchase order.';
  end if;

  return query
  update public.restaurant_purchase_order_items t
  set received_quantity = coalesce(t.received_quantity, 0) + _received_delta,
      accepted_quantity = coalesce(t.accepted_quantity, 0) + _accepted_delta,
      rejected_quantity = coalesce(t.rejected_quantity, 0) + _rejected_delta
  where t.tenant_id = _tenant and t.id = _po_item_id
  returning t.id, t.received_quantity, t.accepted_quantity, t.rejected_quantity;
end;
$function$;
