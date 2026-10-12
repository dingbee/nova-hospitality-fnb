\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE public.restaurant_order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  quantity numeric NOT NULL
);
CREATE TABLE public.restaurant_service_recovery_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  original_order_item_id uuid
);
INSERT INTO public.restaurant_order_items (id, tenant_id, quantity) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 3),
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 2);
INSERT INTO public.restaurant_service_recovery_cases (id, tenant_id, original_order_item_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', NULL);
COMMIT;

\i standalone/db/migrations/0107_service_recovery_affected_quantity.sql

DO $$
BEGIN
  IF (SELECT affected_quantity FROM public.restaurant_service_recovery_cases WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 3 THEN
    RAISE EXCEPTION 'Existing cases must backfill affected_quantity from their original order line';
  END IF;
  IF (SELECT affected_quantity FROM public.restaurant_service_recovery_cases WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 1 THEN
    RAISE EXCEPTION 'Cases without an original line must receive the documented fallback';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'restaurant_service_recovery_cases'
      AND column_name = 'affected_quantity' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'affected_quantity must be NOT NULL after migration';
  END IF;
  BEGIN
    INSERT INTO public.restaurant_service_recovery_cases (id, tenant_id, affected_quantity)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', 0);
    RAISE EXCEPTION 'Expected positive-quantity check constraint to reject zero';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
