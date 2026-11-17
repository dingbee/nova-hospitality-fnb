-- 0026_mobile_money_foundation.sql
--
-- Mobile Money / Lipa Namba Integration Foundation.
--
-- Product principle: "Enter Lipa Namba -> Activate -> ON." Provider
-- complexity stays entirely behind the Payment Core (see
-- src/modules/restaurant/payments/mobilemoney/). LexiBite POS never talks
-- to a PSP/MNO directly:
--
--   LEXIBITE POS -> PAYMENT CORE -> MOBILE MONEY ADAPTER -> PSP/MNO
--
-- A collection attempt (restaurant_mobile_money_collections) is NOT a
-- payment. It only becomes a restaurant_payments row — reusing the
-- existing settlement path (recalcOrder / paid_total / auto-close) — once
-- confirmed PAID. A successful "request payment" call means money was
-- requested, never that money was received (spec section 7).
--
-- Reuses restaurant_payments (existing table, existing client_request_id
-- idempotency) as the single source of settled revenue — no duplicate
-- "confirmed payment" table. Reuses the existing "payment" reconciliation
-- domain (reconciliation/catalogue.ts) rather than inventing a new one.

DO $$ BEGIN
  CREATE TYPE public.restaurant_mm_mode AS ENUM ('lipa_namba', 'connected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_mm_network AS ENUM (
    'mpesa', 'mixx_yas', 'airtel_money', 'halopesa', 'ttcl_pesa'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_mm_activation_state AS ENUM ('inactive', 'active');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_mm_environment AS ENUM ('test', 'production');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- One authoritative state per collection attempt.
  CREATE TYPE public.restaurant_mm_collection_state AS ENUM (
    'created',
    'initiated',
    'pending_customer',
    'processing',
    'paid',
    'failed',
    'cancelled',
    'expired',
    'reversed',
    'refunded',
    'manual_confirmation_required'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_mm_error_class AS ENUM (
    'configuration',
    'authentication',
    'validation',
    'provider_rejection',
    'network',
    'timeout',
    'duplicate',
    'customer_timeout',
    'wrong_amount',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Account configuration — one per outlet. "Enter Lipa Namba -> Activate -> ON."
-- Never stores API secrets; those live in server-only env vars exactly like
-- the existing Pesapal adapter (selforder/providers/pesapal.server.ts) and
-- the TRA fiscal adapter (fiscal/providers/traEfd.server.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_mobile_money_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  mode public.restaurant_mm_mode NOT NULL DEFAULT 'lipa_namba',
  network public.restaurant_mm_network NOT NULL,
  merchant_number text NOT NULL,
  provider_code text NOT NULL DEFAULT 'test',
  environment public.restaurant_mm_environment NOT NULL DEFAULT 'test',
  activation_state public.restaurant_mm_activation_state NOT NULL DEFAULT 'inactive',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id)
);

-- ---------------------------------------------------------------------------
-- Collection attempts — the async request/confirm lifecycle. Multiple rows
-- per order are expected (split payments, retries after failure), so this
-- is NOT constrained one-per-order like the fiscal receipt table was.
-- idempotency_key is caller-supplied per "Request Payment" tap, following
-- the same client_request_id convention already used on restaurant_payments.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_mobile_money_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.restaurant_orders(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.restaurant_mobile_money_accounts(id) ON DELETE SET NULL,
  restaurant_payment_id uuid REFERENCES public.restaurant_payments(id) ON DELETE SET NULL,
  mode public.restaurant_mm_mode NOT NULL,
  network public.restaurant_mm_network NOT NULL,
  merchant_number_snapshot text,
  customer_phone text,
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'TZS',
  state public.restaurant_mm_collection_state NOT NULL DEFAULT 'created',
  environment public.restaurant_mm_environment NOT NULL DEFAULT 'test',
  provider_code text,
  provider_reference text,
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_class public.restaurant_mm_error_class,
  last_error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  expires_at timestamptz,
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- Every inbound webhook event, keyed globally by (provider, provider event
-- id) so the same callback arriving twice — or arriving for a collection
-- this tenant no longer recognises — can never be double-processed.
CREATE TABLE IF NOT EXISTS public.restaurant_mobile_money_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE SET NULL,
  collection_id uuid REFERENCES public.restaurant_mobile_money_collections(id) ON DELETE SET NULL,
  provider_code text NOT NULL,
  provider_event_id text NOT NULL,
  signature_valid boolean,
  outcome text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider_code, provider_event_id)
);

-- Refunds/reversals are compensating events. The original
-- restaurant_payments row is never deleted; its state moves to 'refunded'
-- (recalcOrder already excludes 'refunded' rows from paid_total — see
-- sales/sales.server.ts) and this row records why, how much, and by whom.
CREATE TABLE IF NOT EXISTS public.restaurant_mobile_money_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES public.restaurant_mobile_money_collections(id) ON DELETE SET NULL,
  restaurant_payment_id uuid REFERENCES public.restaurant_payments(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'completed',
  provider_reference text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_mm_collections_tenant_state_idx
  ON public.restaurant_mobile_money_collections (tenant_id, state);
CREATE INDEX IF NOT EXISTS restaurant_mm_collections_order_idx
  ON public.restaurant_mobile_money_collections (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS restaurant_mm_collections_location_idx
  ON public.restaurant_mobile_money_collections (tenant_id, location_id, requested_at);

ALTER TABLE public.restaurant_mobile_money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_mobile_money_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_mobile_money_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_mobile_money_refunds ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.restaurant_mobile_money_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_mobile_money_collections TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_mobile_money_webhook_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_mobile_money_refunds TO authenticated;

GRANT ALL ON public.restaurant_mobile_money_accounts TO service_role;
GRANT ALL ON public.restaurant_mobile_money_collections TO service_role;
GRANT ALL ON public.restaurant_mobile_money_webhook_events TO service_role;
GRANT ALL ON public.restaurant_mobile_money_refunds TO service_role;

-- Read is ordinary tenant read, unlike fiscal_configurations' narrow
-- read: every sales.manage-capable role (including bartender/chef/kitchen
-- manager) needs to know whether Mobile Money is active before taking a
-- payment at POS, and the merchant number is shown to the customer anyway
-- ("Pay to Lipa Namba 123456") — it is not a secret. Write stays narrow.
CREATE POLICY "mm_accounts_read" ON public.restaurant_mobile_money_accounts
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "mm_accounts_write" ON public.restaurant_mobile_money_accounts
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]));

-- Collections: ordinary tenant read (POS needs to poll/see status of a live
-- request); writes restricted to the same roles that can take a payment.
CREATE POLICY "mm_collections_read" ON public.restaurant_mobile_money_collections
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "mm_collections_write" ON public.restaurant_mobile_money_collections
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "mm_webhook_events_read" ON public.restaurant_mobile_money_webhook_events
  FOR SELECT TO authenticated
  USING (tenant_id IS NULL OR public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
-- Writes to webhook events happen only via service_role (the webhook
-- receiver runs unauthenticated, before any tenant/staff session exists —
-- see mobilemoney.functions.ts's receiveMobileMoneyWebhookFn).
CREATE POLICY "mm_webhook_events_service_write" ON public.restaurant_mobile_money_webhook_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "mm_refunds_read" ON public.restaurant_mobile_money_refunds
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "mm_refunds_write" ON public.restaurant_mobile_money_refunds
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
