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
  ADD COLUMN IF NOT EXISTS order_multiple numeric(14,6);

ALTER TABLE public.restaurant_purchase_order_items
  ADD COLUMN IF NOT EXISTS stock_unit_id uuid
    REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_units_per_purchase_unit numeric(18,6),
  ADD COLUMN IF NOT EXISTS minimum_order_quantity numeric(14,4),
  ADD COLUMN IF NOT EXISTS order_multiple numeric(14,6);

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
