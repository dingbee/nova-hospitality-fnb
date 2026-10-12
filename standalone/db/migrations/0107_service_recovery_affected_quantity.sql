-- Quantity-aware service recovery; additive and backward-compatible.
BEGIN;
ALTER TABLE public.restaurant_service_recovery_cases
  ADD COLUMN IF NOT EXISTS affected_quantity numeric;
UPDATE public.restaurant_service_recovery_cases c
SET affected_quantity = COALESCE(i.quantity, 1)
FROM public.restaurant_order_items i
WHERE i.id = c.original_order_item_id
  AND i.tenant_id = c.tenant_id
  AND c.affected_quantity IS NULL;
UPDATE public.restaurant_service_recovery_cases
SET affected_quantity = 1
WHERE affected_quantity IS NULL;
ALTER TABLE public.restaurant_service_recovery_cases
  ALTER COLUMN affected_quantity SET DEFAULT 1,
  ALTER COLUMN affected_quantity SET NOT NULL,
  ADD CONSTRAINT restaurant_service_recovery_cases_affected_quantity_positive
    CHECK (affected_quantity > 0);
COMMIT;
