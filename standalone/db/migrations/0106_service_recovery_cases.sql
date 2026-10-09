-- Service recovery incident ledger. This migration is additive and does not touch live data.
BEGIN;

CREATE TABLE IF NOT EXISTS public.restaurant_service_recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  property_id uuid,
  location_id uuid,
  order_id uuid NOT NULL,
  original_order_item_id uuid NOT NULL,
  replacement_order_item_id uuid,
  refund_payment_id uuid,
  client_request_id text NOT NULL,
  complaint_category text NOT NULL CHECK (complaint_category IN
    ('wrong_item','quality','temperature','delay','allergy_safety','guest_changed_mind','missing_item','other')),
  complaint text NOT NULL CHECK (length(trim(complaint)) BETWEEN 3 AND 2000),
  resolution text NOT NULL CHECK (resolution IN
    ('replace','comp','refund','void_unprepared','no_adjustment','pending')),
  resolution_reason text NOT NULL CHECK (length(trim(resolution_reason)) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  stock_disposition text NOT NULL CHECK (stock_disposition IN
    ('preserve_consumption','reverse_unprepared','wastage_review','not_applicable')),
  reported_by uuid NOT NULL,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_service_recovery_request_unique UNIQUE (tenant_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS restaurant_service_recovery_order_idx
  ON public.restaurant_service_recovery_cases (tenant_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_service_recovery_open_idx
  ON public.restaurant_service_recovery_cases (tenant_id, status, created_at DESC);

ALTER TABLE public.restaurant_service_recovery_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS restaurant_service_recovery_read ON public.restaurant_service_recovery_cases;
CREATE POLICY restaurant_service_recovery_read ON public.restaurant_service_recovery_cases
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

DROP POLICY IF EXISTS restaurant_service_recovery_insert ON public.restaurant_service_recovery_cases;
CREATE POLICY restaurant_service_recovery_insert ON public.restaurant_service_recovery_cases
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_read(tenant_id) AND reported_by = auth.uid());

DROP POLICY IF EXISTS restaurant_service_recovery_update ON public.restaurant_service_recovery_cases;
CREATE POLICY restaurant_service_recovery_update ON public.restaurant_service_recovery_cases
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_read(tenant_id))
  WITH CHECK (public.restaurant_can_read(tenant_id));

COMMIT;
