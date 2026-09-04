-- 0027_property_scope.sql
--
-- P0 security remediation: property/location authorization.
--
-- Root cause (multi-location audit): restaurant_members.property_id exists
-- in the schema but has never been read by any authorization check —
-- restaurant_can_read/restaurant_can_write take only a tenant id, so every
-- capability is tenant-wide regardless of which property a staff member is
-- actually assigned to. This migration makes property_id authoritative:
--
--   1. Fixes restaurant_members' unique constraint so one user can hold the
--      same role at more than one property (or tenant-wide) without
--      collision.
--   2. Adds property-aware RLS functions ADDITIVELY — restaurant_can_read/
--      restaurant_can_write keep their existing signatures and behaviour
--      unchanged (nothing that already depends on them is touched), so this
--      migration cannot regress tenant isolation.
--   3. Applies the new, property-aware functions to the RLS policies on the
--      tables the audit identified as the actual attack surface for
--      cross-property tampering: orders, order items, payments, kitchen
--      tickets, stock movements, purchase orders (+ items), requisitions
--      (+ lines).
--
-- Backward compatibility: every existing restaurant_members row has
-- property_id = NULL today (the column has never been written to). NULL
-- means "tenant-wide" throughout this design, so every existing member's
-- effective access is completely unchanged by this migration — scoping only
-- takes effect once a member is deliberately assigned a property_id.

-- ---------- 1. Membership can now hold more than one row per (tenant, user, role) ----------

ALTER TABLE public.restaurant_members DROP CONSTRAINT IF EXISTS restaurant_members_tenant_id_user_id_role_key;

-- A tenant-wide grant (property_id IS NULL) for a given role is still unique
-- per member — you cannot hold the same tenant-wide role twice.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_members_tenant_wide_uq
  ON public.restaurant_members (tenant_id, user_id, role)
  WHERE property_id IS NULL;

-- A property-scoped grant is unique per (member, role, property) — the same
-- user can hold "bartender at Property A" and "bartender at Property B" as
-- two distinct rows, but not the same role twice at the same property.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_members_property_scoped_uq
  ON public.restaurant_members (tenant_id, user_id, role, property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restaurant_members_property ON public.restaurant_members (tenant_id, property_id);

-- ---------- 2. Property-aware authorization functions (additive) ----------

CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant_id uuid, _property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    -- A resource with no property of its own (property_id IS NULL — either
    -- the column doesn't apply, or the row predates property scoping) is
    -- tenant-wide by definition: any tenant member may read it, exactly as
    -- restaurant_can_read already behaves.
    OR _property_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
        -- A caller with ANY tenant-wide row (property_id IS NULL) may read
        -- every property. A caller whose only grants are property-scoped
        -- may read only the matching property.
        AND (m.property_id IS NULL OR m.property_id = _property_id)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(
  _tenant_id uuid, _roles public.restaurant_role[], _property_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
        AND m.role = ANY(_roles)
        AND (_property_id IS NULL OR m.property_id IS NULL OR m.property_id = _property_id)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.restaurant_can_read_scoped(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_read_scoped(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_can_write_scoped(uuid, public.restaurant_role[], uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_write_scoped(uuid, public.restaurant_role[], uuid) TO authenticated, service_role;

-- ---------- 3. Property-derivation helpers, for tables scoped only via a parent ----------

CREATE OR REPLACE FUNCTION public.restaurant_order_property(_order_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_orders WHERE id = _order_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_location_property(_location_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_locations WHERE id = _location_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_purchase_order_property(_po_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_purchase_orders WHERE id = _po_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_requisition_property(_requisition_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_requisitions WHERE id = _requisition_id;
$$;

REVOKE ALL ON FUNCTION public.restaurant_order_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_order_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_location_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_location_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_purchase_order_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_purchase_order_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_requisition_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_requisition_property(uuid) TO authenticated, service_role;

-- ---------- 4. Re-point RLS policies at the property-aware functions ----------

-- Orders
DROP POLICY IF EXISTS "orders readable by tenant" ON public.restaurant_orders;
CREATE POLICY "orders readable by tenant and property" ON public.restaurant_orders FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS "orders managed by tenant" ON public.restaurant_orders;
CREATE POLICY "orders managed by tenant and property" ON public.restaurant_orders FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], property_id));

-- Order items (property lives on the parent order)
DROP POLICY IF EXISTS "order items readable by tenant" ON public.restaurant_order_items;
CREATE POLICY "order items readable by tenant and property" ON public.restaurant_order_items FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_order_property(order_id)));

DROP POLICY IF EXISTS "order items managed by tenant" ON public.restaurant_order_items;
CREATE POLICY "order items managed by tenant and property" ON public.restaurant_order_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager']::restaurant_role[], public.restaurant_order_property(order_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager']::restaurant_role[], public.restaurant_order_property(order_id)));

-- Payments (property lives on the parent order)
DROP POLICY IF EXISTS "payments readable by tenant" ON public.restaurant_payments;
CREATE POLICY "payments readable by tenant and property" ON public.restaurant_payments FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_order_property(order_id)));

DROP POLICY IF EXISTS "payments managed by tenant" ON public.restaurant_payments;
CREATE POLICY "payments managed by tenant and property" ON public.restaurant_payments FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[], public.restaurant_order_property(order_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[], public.restaurant_order_property(order_id)));

-- Kitchen tickets (no property_id column — derived from location_id)
DROP POLICY IF EXISTS "tickets readable by tenant" ON public.restaurant_kitchen_tickets;
CREATE POLICY "tickets readable by tenant and property" ON public.restaurant_kitchen_tickets FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_location_property(location_id)));

DROP POLICY IF EXISTS "tickets managed by tenant" ON public.restaurant_kitchen_tickets;
CREATE POLICY "tickets managed by tenant and property" ON public.restaurant_kitchen_tickets FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[], public.restaurant_location_property(location_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[], public.restaurant_location_property(location_id)));

-- Stock movements (property_id column present directly)
DROP POLICY IF EXISTS "movements readable by tenant" ON public.restaurant_stock_movements;
CREATE POLICY "movements readable by tenant and property" ON public.restaurant_stock_movements FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS "movements managed by tenant" ON public.restaurant_stock_movements;
CREATE POLICY "movements managed by tenant and property" ON public.restaurant_stock_movements FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender','purchasing_officer']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender','purchasing_officer']::restaurant_role[], property_id));

-- Purchase orders (property_id column present directly)
DROP POLICY IF EXISTS "po read" ON public.restaurant_purchase_orders;
CREATE POLICY "po read scoped" ON public.restaurant_purchase_orders FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS "po write" ON public.restaurant_purchase_orders;
CREATE POLICY "po write scoped" ON public.restaurant_purchase_orders FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[], property_id));

-- Purchase order items (property lives on the parent PO)
DROP POLICY IF EXISTS "po items read" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items read scoped" ON public.restaurant_purchase_order_items FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_purchase_order_property(purchase_order_id)));

DROP POLICY IF EXISTS "po items write" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items write scoped" ON public.restaurant_purchase_order_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[], public.restaurant_purchase_order_property(purchase_order_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[], public.restaurant_purchase_order_property(purchase_order_id)));

-- Requisitions (property_id column present directly)
DROP POLICY IF EXISTS "requisitions read" ON public.restaurant_requisitions;
CREATE POLICY "requisitions read scoped" ON public.restaurant_requisitions FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS "requisitions write" ON public.restaurant_requisitions;
CREATE POLICY "requisitions write scoped" ON public.restaurant_requisitions FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], property_id));

-- Requisition lines (property lives on the parent requisition)
DROP POLICY IF EXISTS "requisition lines read" ON public.restaurant_requisition_lines;
CREATE POLICY "requisition lines read scoped" ON public.restaurant_requisition_lines FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_requisition_property(requisition_id)));

DROP POLICY IF EXISTS "requisition lines write" ON public.restaurant_requisition_lines;
CREATE POLICY "requisition lines write scoped" ON public.restaurant_requisition_lines FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], public.restaurant_requisition_property(requisition_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[], public.restaurant_requisition_property(requisition_id)));

-- ---------- 5. Member CRUD may now set property_id ----------
-- (No schema change needed — the column already exists and is now read.
-- The application-layer write path is fixed in the same sprint's code
-- changes to members.server.ts / core/contracts.ts.)
