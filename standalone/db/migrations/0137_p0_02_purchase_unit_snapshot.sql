-- P0-02: preserve supplier purchase-unit conversion and approval constraints
-- across the governed purchase-request -> purchase-order -> goods-receipt path.
-- Additive only. No production database is changed by this migration file.

ALTER TABLE public.restaurant_purchase_request_items
  ADD COLUMN IF NOT EXISTS supplier_product_id uuid
    REFERENCES public.restaurant_supplier_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_unit_id uuid
    REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_units_per_purchase_unit numeric(18,6),
  ADD COLUMN IF NOT EXISTS minimum_order_quantity numeric(14,4),
  ADD COLUMN IF NOT EXISTS order_multiple numeric(14,6),
  ADD COLUMN IF NOT EXISTS source_action_id uuid REFERENCES public.intelligence_actions(id) ON DELETE SET NULL;

ALTER TABLE public.restaurant_purchase_order_items
  ADD COLUMN IF NOT EXISTS stock_unit_id uuid
    REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_units_per_purchase_unit numeric(18,6),
  ADD COLUMN IF NOT EXISTS minimum_order_quantity numeric(14,4),
  ADD COLUMN IF NOT EXISTS order_multiple numeric(14,6),
  ADD COLUMN IF NOT EXISTS source_action_id uuid REFERENCES public.intelligence_actions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_request_item_id uuid REFERENCES public.restaurant_purchase_request_items(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_request_items_stock_factor_positive'
      AND conrelid = 'public.restaurant_purchase_request_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_request_items
      ADD CONSTRAINT restaurant_purchase_request_items_stock_factor_positive
      CHECK (stock_units_per_purchase_unit IS NULL OR stock_units_per_purchase_unit > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_request_items_minimum_nonnegative'
      AND conrelid = 'public.restaurant_purchase_request_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_request_items
      ADD CONSTRAINT restaurant_purchase_request_items_minimum_nonnegative
      CHECK (minimum_order_quantity IS NULL OR minimum_order_quantity >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_request_items_order_multiple_positive'
      AND conrelid = 'public.restaurant_purchase_request_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_request_items
      ADD CONSTRAINT restaurant_purchase_request_items_order_multiple_positive
      CHECK (order_multiple IS NULL OR order_multiple > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_order_items_stock_factor_positive'
      AND conrelid = 'public.restaurant_purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_order_items
      ADD CONSTRAINT restaurant_purchase_order_items_stock_factor_positive
      CHECK (stock_units_per_purchase_unit IS NULL OR stock_units_per_purchase_unit > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_order_items_minimum_nonnegative'
      AND conrelid = 'public.restaurant_purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_order_items
      ADD CONSTRAINT restaurant_purchase_order_items_minimum_nonnegative
      CHECK (minimum_order_quantity IS NULL OR minimum_order_quantity >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'restaurant_purchase_order_items_order_multiple_positive'
      AND conrelid = 'public.restaurant_purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.restaurant_purchase_order_items
      ADD CONSTRAINT restaurant_purchase_order_items_order_multiple_positive
      CHECK (order_multiple IS NULL OR order_multiple > 0);
  END IF;
END $$;

ALTER TABLE public.restaurant_goods_receipt_items
  ADD COLUMN IF NOT EXISTS po_fulfilment_applied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_supplier_product
  ON public.restaurant_purchase_request_items (supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_stock_unit
  ON public.restaurant_purchase_order_items (stock_unit_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_source_action
  ON public.restaurant_purchase_request_items (source_action_id)
  WHERE source_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_source_action
  ON public.restaurant_purchase_order_items (source_action_id)
  WHERE source_action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_source_request_item
  ON public.restaurant_purchase_order_items (source_request_item_id)
  WHERE source_request_item_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT purchase_request_id
    FROM public.restaurant_purchase_orders
    WHERE purchase_request_id IS NOT NULL
    GROUP BY purchase_request_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'P0-02 blocked: duplicate purchase orders already reference the same purchase request';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_purchase_request
  ON public.restaurant_purchase_orders (purchase_request_id)
  WHERE purchase_request_id IS NOT NULL;


-- Idempotent PO fulfilment application. The receipt-item marker and PO-line
-- counters are updated in one transaction, so a retry after a partial
-- application cannot double-increment received quantities.
CREATE OR REPLACE FUNCTION public.restaurant_apply_po_receipt_fulfilment(
  _tenant uuid,
  _receipt_item_id uuid,
  _po_item_id uuid,
  _received_delta numeric,
  _accepted_delta numeric,
  _rejected_delta numeric
)
RETURNS TABLE (
  out_id uuid,
  out_received_quantity numeric,
  out_accepted_quantity numeric,
  out_rejected_quantity numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _po_id uuid;
  _receipt_po_item_id uuid;
  _applied_id uuid;
BEGIN
  IF _received_delta < 0 OR _accepted_delta < 0 OR _rejected_delta < 0 OR
     _accepted_delta + _rejected_delta > _received_delta + 0.0001 THEN
    RAISE EXCEPTION 'Invalid purchase-order receipt fulfilment deltas.';
  END IF;

  SELECT t.purchase_order_id INTO _po_id
  FROM public.restaurant_purchase_order_items t
  WHERE t.tenant_id = _tenant AND t.id = _po_item_id;

  IF _po_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order item not found for this tenant.';
  END IF;

  SELECT r.purchase_order_item_id INTO _receipt_po_item_id
  FROM public.restaurant_goods_receipt_items r
  WHERE r.tenant_id = _tenant AND r.id = _receipt_item_id;

  IF _receipt_po_item_id IS DISTINCT FROM _po_item_id THEN
    RAISE EXCEPTION 'Goods receipt item does not belong to the supplied purchase order item.';
  END IF;

  IF NOT public.restaurant_can_write_scoped(
    _tenant,
    ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[],
    public.restaurant_purchase_order_property(_po_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden — insufficient role to post receiving against this purchase order.';
  END IF;

  UPDATE public.restaurant_goods_receipt_items
  SET po_fulfilment_applied_at = now()
  WHERE tenant_id = _tenant
    AND id = _receipt_item_id
    AND po_fulfilment_applied_at IS NULL
  RETURNING id INTO _applied_id;

  IF _applied_id IS NULL THEN
    RETURN QUERY
    SELECT t.id, t.received_quantity, t.accepted_quantity, t.rejected_quantity
    FROM public.restaurant_purchase_order_items t
    WHERE t.tenant_id = _tenant AND t.id = _po_item_id;
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.restaurant_purchase_order_items t
  SET received_quantity = coalesce(t.received_quantity, 0) + _received_delta,
      accepted_quantity = coalesce(t.accepted_quantity, 0) + _accepted_delta,
      rejected_quantity = coalesce(t.rejected_quantity, 0) + _rejected_delta
  WHERE t.tenant_id = _tenant AND t.id = _po_item_id
  RETURNING t.id, t.received_quantity, t.accepted_quantity, t.rejected_quantity;
END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_apply_po_receipt_fulfilment(uuid, uuid, uuid, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restaurant_apply_po_receipt_fulfilment(uuid, uuid, uuid, numeric, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_apply_po_receipt_fulfilment(uuid, uuid, uuid, numeric, numeric, numeric) TO service_role;
