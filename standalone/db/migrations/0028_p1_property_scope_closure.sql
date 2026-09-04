-- P1 property-scope closure: extends the 0027 scoped-RLS foundation to the
-- domains its own root-cause description missed — stock transfers (a
-- two-location document, needs a dual-property check, not a single one),
-- Mobile Money, and TRA Fiscal. Additive only: existing restaurant_can_read/
-- restaurant_can_write and the 0027 _scoped functions are never touched, so
-- every untouched call site keeps its exact prior behaviour.
--
-- Deliberately NOT touched here (see the accompanying P1 report for why):
-- intelligence_decisions/intelligence_events/intelligence_plans/
-- intelligence_plan_steps/intelligence_actions. Those are shared,
-- module-agnostic Intelligence Core tables used by more than just the
-- restaurant module — scoping their RLS to "restaurant" property semantics
-- risks breaking another module's isolation model with no way to verify
-- that from this codebase alone. Property scope for restaurant decisions is
-- enforced at the application layer instead (decisions.server.ts,
-- actions.server.ts, the TenantScopeChecker registry) — see the report for
-- the exact residual risk this leaves.

-- ---------- 1. New columns ----------

-- restaurant_mobile_money_refunds had no property attribution at all; the
-- server now populates it from the reversed collection's own property_id
-- (reverseMobileMoneyCollection). Nullable + no fabrication for existing
-- rows — they simply stay tenant-wide-visible under the NULL-passes rule
-- the 0027 _scoped functions already establish.
ALTER TABLE public.restaurant_mobile_money_refunds
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL;

-- ---------- 2. Fix restaurant_stock_reconciliation_v: it joins
-- restaurant_inventory_items (which HAS location_id/property_id) but never
-- selected either column, so overview.server.ts's location_name lookup was
-- silently dead code and the view could not be scoped at all. Additive:
-- same rows, same existing columns, two more.
-- ----------

CREATE OR REPLACE VIEW public.restaurant_stock_reconciliation_v
WITH (security_invoker = true) AS
WITH ledger AS (
  SELECT tenant_id, inventory_item_id, sum(quantity) AS ledger_quantity, count(*) AS movement_count
  FROM public.restaurant_stock_movements
  GROUP BY tenant_id, inventory_item_id
),
orphan AS (
  SELECT tenant_id, inventory_item_id, count(*) AS orphan_transfer_movements
  FROM public.restaurant_stock_movements
  WHERE movement_type IN ('transfer_in','transfer_out') AND transfer_id IS NULL
  GROUP BY tenant_id, inventory_item_id
)
SELECT
  i.tenant_id,
  i.id                                        AS inventory_item_id,
  i.name,
  i.current_quantity                          AS item_quantity,
  coalesce(l.ledger_quantity, 0)              AS ledger_quantity,
  i.current_quantity - coalesce(l.ledger_quantity, 0) AS drift,
  coalesce(l.movement_count, 0)               AS movement_count,
  coalesce(o.orphan_transfer_movements, 0)    AS orphan_transfer_movements,
  (i.current_quantity < 0 AND NOT i.allow_negative) AS illegal_negative,
  i.location_id,
  i.property_id
FROM public.restaurant_inventory_items i
LEFT JOIN ledger l ON l.tenant_id = i.tenant_id AND l.inventory_item_id = i.id
LEFT JOIN orphan o ON o.tenant_id = i.tenant_id AND o.inventory_item_id = i.id;

GRANT SELECT ON public.restaurant_stock_reconciliation_v TO authenticated;
GRANT SELECT ON public.restaurant_stock_reconciliation_v TO service_role;

-- ---------- 3. Property-derivation helpers for tables 0027 didn't cover ----------

-- Stock transfers: a transfer has TWO locations that can legitimately sit
-- in different properties, so a single property_id can never represent it.
-- Reads are visible from EITHER side; every write requires the caller to be
-- authorized at BOTH — mirrors transfers.server.ts's assertTransferWriteAccess
-- exactly, so the DB backstop enforces the same rule the app layer does.
CREATE OR REPLACE FUNCTION public.restaurant_can_read_transfer(
  _tenant_id uuid, _source_property_id uuid, _destination_property_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_can_read_scoped(_tenant_id, _source_property_id)
      OR public.restaurant_can_read_scoped(_tenant_id, _destination_property_id);
$$;

CREATE OR REPLACE FUNCTION public.restaurant_can_write_transfer(
  _tenant_id uuid, _roles public.restaurant_role[], _source_property_id uuid, _destination_property_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_can_write_scoped(_tenant_id, _roles, _source_property_id)
     AND public.restaurant_can_write_scoped(_tenant_id, _roles, _destination_property_id);
$$;

-- restaurant_stock_transfers itself carries source_location_id/
-- destination_location_id directly, so restaurant_location_property(...) is
-- called inline in its policies below — no transfer-specific function
-- needed there. restaurant_stock_transfer_lines has neither location column
-- (only transfer_id), so it needs to resolve through its parent transfer.
CREATE OR REPLACE FUNCTION public.restaurant_stock_transfer_source_property(_transfer_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_location_property(t.source_location_id)
  FROM public.restaurant_stock_transfers t WHERE t.id = _transfer_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_stock_transfer_destination_property(_transfer_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_location_property(t.destination_location_id)
  FROM public.restaurant_stock_transfers t WHERE t.id = _transfer_id;
$$;

-- Fiscal: configurations/receipts/z_reports all carry a NOT NULL
-- location_id (property_id on configurations/receipts is nullable and, on
-- receipts, not even FK-constrained — never trusted for authorization,
-- exactly like the app layer's upsertFiscalConfiguration/requestFiscalization
-- now derive property from the location, not the client-supplied field).
-- fiscal_devices/receipt_items/submissions/acknowledgements have no
-- location/property column of their own and resolve through their parent.
CREATE OR REPLACE FUNCTION public.restaurant_fiscal_receipt_property(_receipt_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_location_property(r.location_id)
  FROM public.restaurant_fiscal_receipts r WHERE r.id = _receipt_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_fiscal_device_property(_device_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_location_property(c.location_id)
  FROM public.restaurant_fiscal_devices d
  JOIN public.restaurant_fiscal_configurations c ON c.id = d.fiscal_configuration_id
  WHERE d.id = _device_id;
$$;

REVOKE ALL ON FUNCTION public.restaurant_can_read_transfer(uuid, uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_read_transfer(uuid, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_can_write_transfer(uuid, public.restaurant_role[], uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_write_transfer(uuid, public.restaurant_role[], uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_stock_transfer_source_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_stock_transfer_source_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_stock_transfer_destination_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_stock_transfer_destination_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_fiscal_receipt_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_fiscal_receipt_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_fiscal_device_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_fiscal_device_property(uuid) TO authenticated, service_role;

-- ---------- 4. Re-point RLS: stock transfers ----------

DROP POLICY IF EXISTS "stock transfers read" ON public.restaurant_stock_transfers;
CREATE POLICY "stock transfers read scoped" ON public.restaurant_stock_transfers FOR SELECT TO authenticated
  USING (public.restaurant_can_read_transfer(
    tenant_id,
    public.restaurant_location_property(source_location_id),
    public.restaurant_location_property(destination_location_id)
  ));

DROP POLICY IF EXISTS "stock transfers write" ON public.restaurant_stock_transfers;
CREATE POLICY "stock transfers write scoped" ON public.restaurant_stock_transfers FOR ALL TO authenticated
  USING (public.restaurant_can_write_transfer(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[],
    public.restaurant_location_property(source_location_id),
    public.restaurant_location_property(destination_location_id)
  ))
  WITH CHECK (public.restaurant_can_write_transfer(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[],
    public.restaurant_location_property(source_location_id),
    public.restaurant_location_property(destination_location_id)
  ));

DROP POLICY IF EXISTS "stock transfer lines read" ON public.restaurant_stock_transfer_lines;
CREATE POLICY "stock transfer lines read scoped" ON public.restaurant_stock_transfer_lines FOR SELECT TO authenticated
  USING (public.restaurant_can_read_transfer(
    tenant_id,
    public.restaurant_stock_transfer_source_property(transfer_id),
    public.restaurant_stock_transfer_destination_property(transfer_id)
  ));

DROP POLICY IF EXISTS "stock transfer lines write" ON public.restaurant_stock_transfer_lines;
CREATE POLICY "stock transfer lines write scoped" ON public.restaurant_stock_transfer_lines FOR ALL TO authenticated
  USING (public.restaurant_can_write_transfer(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[],
    public.restaurant_stock_transfer_source_property(transfer_id),
    public.restaurant_stock_transfer_destination_property(transfer_id)
  ))
  WITH CHECK (public.restaurant_can_write_transfer(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[],
    public.restaurant_stock_transfer_source_property(transfer_id),
    public.restaurant_stock_transfer_destination_property(transfer_id)
  ));

-- ---------- 5. Re-point RLS: mobile money ----------

DROP POLICY IF EXISTS "mm_accounts_read" ON public.restaurant_mobile_money_accounts;
CREATE POLICY "mm_accounts_read scoped" ON public.restaurant_mobile_money_accounts
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS "mm_accounts_write" ON public.restaurant_mobile_money_accounts;
CREATE POLICY "mm_accounts_write scoped" ON public.restaurant_mobile_money_accounts
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], property_id));

DROP POLICY IF EXISTS "mm_collections_read" ON public.restaurant_mobile_money_collections;
CREATE POLICY "mm_collections_read scoped" ON public.restaurant_mobile_money_collections
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS "mm_collections_write" ON public.restaurant_mobile_money_collections;
CREATE POLICY "mm_collections_write scoped" ON public.restaurant_mobile_money_collections
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], property_id));

-- restaurant_mobile_money_webhook_events intentionally left on
-- restaurant_can_write(tenant_id, ...) — it carries no property/location
-- attribution (server-to-server, pre-tenant-resolution in places), has no
-- direct staff read surface, and service_role owns all writes.

DROP POLICY IF EXISTS "mm_refunds_read" ON public.restaurant_mobile_money_refunds;
CREATE POLICY "mm_refunds_read scoped" ON public.restaurant_mobile_money_refunds
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS "mm_refunds_write" ON public.restaurant_mobile_money_refunds;
CREATE POLICY "mm_refunds_write scoped" ON public.restaurant_mobile_money_refunds
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id));

-- ---------- 6. Re-point RLS: TRA fiscal ----------

DROP POLICY IF EXISTS "fiscal_configurations_read" ON public.restaurant_fiscal_configurations;
CREATE POLICY "fiscal_configurations_read scoped" ON public.restaurant_fiscal_configurations
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)));
DROP POLICY IF EXISTS "fiscal_configurations_write" ON public.restaurant_fiscal_configurations;
CREATE POLICY "fiscal_configurations_write scoped" ON public.restaurant_fiscal_configurations
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)));

DROP POLICY IF EXISTS "fiscal_devices_read" ON public.restaurant_fiscal_devices;
CREATE POLICY "fiscal_devices_read scoped" ON public.restaurant_fiscal_devices
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], public.restaurant_fiscal_device_property(id)));
DROP POLICY IF EXISTS "fiscal_devices_write" ON public.restaurant_fiscal_devices;
CREATE POLICY "fiscal_devices_write scoped" ON public.restaurant_fiscal_devices
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_fiscal_device_property(id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_fiscal_device_property(id)));

DROP POLICY IF EXISTS "fiscal_receipts_read" ON public.restaurant_fiscal_receipts;
CREATE POLICY "fiscal_receipts_read scoped" ON public.restaurant_fiscal_receipts
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_location_property(location_id)));
DROP POLICY IF EXISTS "fiscal_receipts_write" ON public.restaurant_fiscal_receipts;
CREATE POLICY "fiscal_receipts_write scoped" ON public.restaurant_fiscal_receipts
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)));

DROP POLICY IF EXISTS "fiscal_receipt_items_read" ON public.restaurant_fiscal_receipt_items;
CREATE POLICY "fiscal_receipt_items_read scoped" ON public.restaurant_fiscal_receipt_items
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));
DROP POLICY IF EXISTS "fiscal_receipt_items_write" ON public.restaurant_fiscal_receipt_items;
CREATE POLICY "fiscal_receipt_items_write scoped" ON public.restaurant_fiscal_receipt_items
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));

DROP POLICY IF EXISTS "fiscal_submissions_read" ON public.restaurant_fiscal_submissions;
CREATE POLICY "fiscal_submissions_read scoped" ON public.restaurant_fiscal_submissions
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));
DROP POLICY IF EXISTS "fiscal_submissions_write" ON public.restaurant_fiscal_submissions;
CREATE POLICY "fiscal_submissions_write scoped" ON public.restaurant_fiscal_submissions
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));

DROP POLICY IF EXISTS "fiscal_acknowledgements_read" ON public.restaurant_fiscal_acknowledgements;
CREATE POLICY "fiscal_acknowledgements_read scoped" ON public.restaurant_fiscal_acknowledgements
  FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));
DROP POLICY IF EXISTS "fiscal_acknowledgements_write" ON public.restaurant_fiscal_acknowledgements;
CREATE POLICY "fiscal_acknowledgements_write scoped" ON public.restaurant_fiscal_acknowledgements
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[], public.restaurant_fiscal_receipt_property(fiscal_receipt_id)));

DROP POLICY IF EXISTS "fiscal_z_reports_read" ON public.restaurant_fiscal_z_reports;
CREATE POLICY "fiscal_z_reports_read scoped" ON public.restaurant_fiscal_z_reports
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)));
DROP POLICY IF EXISTS "fiscal_z_reports_write" ON public.restaurant_fiscal_z_reports;
CREATE POLICY "fiscal_z_reports_write scoped" ON public.restaurant_fiscal_z_reports
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[], public.restaurant_location_property(location_id)));
