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
