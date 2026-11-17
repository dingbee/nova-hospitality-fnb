-- 0025_fiscal_foundation.sql
--
-- TRA Fiscal / VFD Integration Foundation.
--
-- Establishes a provider-agnostic fiscal domain: LexiBite POS never talks to
-- a fiscal provider directly. It writes a fiscal receipt request; the fiscal
-- core (application layer, see src/modules/restaurant/fiscal) drives it
-- through a FiscalProviderAdapter and records the outcome here.
--
-- No real TRA credentials, endpoint contracts or certification claims are
-- encoded anywhere in this schema. Fiscal numbering reuses the existing
-- concurrency-safe restaurant_next_document_number() sequence (doc_type
-- 'fiscal_receipt' / 'fiscal_z_report') rather than a new sequence table.
-- Audit trail reuses the existing intelligence_events pipeline via
-- emitRestaurantEvent — no parallel audit-log table.

DO $$ BEGIN
  CREATE TYPE public.restaurant_fiscal_environment AS ENUM ('test', 'production');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_fiscal_activation_state AS ENUM ('inactive', 'test', 'active');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- One authoritative state per fiscal receipt — never multiple competing flags.
  CREATE TYPE public.restaurant_fiscal_state AS ENUM (
    'not_required',
    'pending',
    'submitting',
    'accepted',
    'fiscalized',
    'rejected',
    'failed',
    'retry_required',
    'authentication_error',
    'configuration_error',
    'network_error'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_fiscal_error_class AS ENUM (
    'configuration',
    'authentication',
    'validation',
    'provider_rejection',
    'network',
    'timeout',
    'duplicate',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_fiscal_submission_outcome AS ENUM (
    'success',
    'rejected',
    'timeout',
    'network_error',
    'authentication_error',
    'malformed_response',
    'duplicate'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_fiscal_z_state AS ENUM ('draft', 'submitted', 'acknowledged', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Fiscal configuration — one per outlet (restaurant_locations). Never stores
-- private keys or certificates; only taxpayer/device identity and status.
-- Real credentials live in server-only environment variables, exactly like
-- the existing Pesapal payment adapter (selforder/providers/pesapal.server.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  tin text,
  vrn text,
  provider_code text NOT NULL DEFAULT 'test',
  environment public.restaurant_fiscal_environment NOT NULL DEFAULT 'test',
  activation_state public.restaurant_fiscal_activation_state NOT NULL DEFAULT 'inactive',
  certificate_status text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id)
);

CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_configuration_id uuid NOT NULL REFERENCES public.restaurant_fiscal_configurations(id) ON DELETE CASCADE,
  device_serial text NOT NULL,
  uin text,
  registration_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'registered',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_serial)
);

-- ---------------------------------------------------------------------------
-- Fiscal receipts — one per order, ever. The UNIQUE(tenant_id, order_id)
-- constraint IS the idempotency guarantee: a concurrent or retried
-- fiscalization request cannot create a second row; it hits 23505 and the
-- caller re-reads the existing row instead. The fiscal receipt number is
-- assigned only once, at ACCEPTED/FISCALIZED — a rejected or retried attempt
-- never burns a number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.restaurant_orders(id) ON DELETE CASCADE,
  restaurant_receipt_id uuid REFERENCES public.restaurant_receipts(id) ON DELETE SET NULL,
  fiscal_configuration_id uuid REFERENCES public.restaurant_fiscal_configurations(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  state public.restaurant_fiscal_state NOT NULL DEFAULT 'pending',
  environment public.restaurant_fiscal_environment NOT NULL DEFAULT 'test',
  provider_code text,
  currency text NOT NULL DEFAULT 'TZS',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  tin_snapshot text,
  vrn_snapshot text,
  device_serial_snapshot text,
  fiscal_receipt_number text,
  verification_code text,
  z_number text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_class public.restaurant_fiscal_error_class,
  last_error_message text,
  fiscalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, fiscal_receipt_number)
);

CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_receipt_id uuid NOT NULL REFERENCES public.restaurant_fiscal_receipts(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.restaurant_order_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(14,4) NOT NULL,
  unit_price numeric(14,4) NOT NULL,
  tax_classification_code text,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every submission attempt, retried or not — the audit spine for a fiscal
-- receipt. Never stores secrets; only outcome classification.
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_receipt_id uuid NOT NULL REFERENCES public.restaurant_fiscal_receipts(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  environment public.restaurant_fiscal_environment NOT NULL,
  provider_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome public.restaurant_fiscal_submission_outcome,
  error_class public.restaurant_fiscal_error_class,
  error_detail text,
  requested_by uuid,
  UNIQUE (tenant_id, fiscal_receipt_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  fiscal_receipt_id uuid NOT NULL REFERENCES public.restaurant_fiscal_receipts(id) ON DELETE CASCADE,
  fiscal_submission_id uuid REFERENCES public.restaurant_fiscal_submissions(id) ON DELETE SET NULL,
  fiscal_receipt_number text NOT NULL,
  verification_code text,
  z_number text,
  provider_code text,
  environment public.restaurant_fiscal_environment NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fiscal_receipt_id)
);

-- Z-report foundation: daily fiscal aggregation per outlet. Draft only —
-- no fabricated submission payload until a real TRA contract is available.
CREATE TABLE IF NOT EXISTS public.restaurant_fiscal_z_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  state public.restaurant_fiscal_z_state NOT NULL DEFAULT 'draft',
  receipt_count integer NOT NULL DEFAULT 0,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  z_number text,
  prepared_by uuid,
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, business_date)
);

CREATE INDEX IF NOT EXISTS restaurant_fiscal_receipts_tenant_state_idx
  ON public.restaurant_fiscal_receipts (tenant_id, state);
CREATE INDEX IF NOT EXISTS restaurant_fiscal_receipts_location_idx
  ON public.restaurant_fiscal_receipts (tenant_id, location_id, created_at);
CREATE INDEX IF NOT EXISTS restaurant_fiscal_submissions_receipt_idx
  ON public.restaurant_fiscal_submissions (tenant_id, fiscal_receipt_id);

ALTER TABLE public.restaurant_fiscal_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_fiscal_z_reports ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_configurations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_devices TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_receipts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_receipt_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_submissions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_acknowledgements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_fiscal_z_reports TO authenticated;

GRANT ALL ON public.restaurant_fiscal_configurations TO service_role;
GRANT ALL ON public.restaurant_fiscal_devices TO service_role;
GRANT ALL ON public.restaurant_fiscal_receipts TO service_role;
GRANT ALL ON public.restaurant_fiscal_receipt_items TO service_role;
GRANT ALL ON public.restaurant_fiscal_submissions TO service_role;
GRANT ALL ON public.restaurant_fiscal_acknowledgements TO service_role;
GRANT ALL ON public.restaurant_fiscal_z_reports TO service_role;

-- Configuration/devices carry taxpayer identity — narrower than ordinary
-- tenant read, mirroring the same senior-role restriction as tax.manage.
CREATE POLICY "fiscal_configurations_read" ON public.restaurant_fiscal_configurations
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
CREATE POLICY "fiscal_configurations_write" ON public.restaurant_fiscal_configurations
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]));

CREATE POLICY "fiscal_devices_read" ON public.restaurant_fiscal_devices
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
CREATE POLICY "fiscal_devices_write" ON public.restaurant_fiscal_devices
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]));

-- Fiscal receipts/items/submissions/acknowledgements: read is ordinary
-- tenant read (a cashier must see the status of their own sale); writes are
-- restricted to the same roles that can close a sale, since fiscalization is
-- always driven by the sales flow, never entered by hand.
CREATE POLICY "fiscal_receipts_read" ON public.restaurant_fiscal_receipts
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "fiscal_receipts_write" ON public.restaurant_fiscal_receipts
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "fiscal_receipt_items_read" ON public.restaurant_fiscal_receipt_items
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "fiscal_receipt_items_write" ON public.restaurant_fiscal_receipt_items
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "fiscal_submissions_read" ON public.restaurant_fiscal_submissions
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "fiscal_submissions_write" ON public.restaurant_fiscal_submissions
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "fiscal_acknowledgements_read" ON public.restaurant_fiscal_acknowledgements
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));
CREATE POLICY "fiscal_acknowledgements_write" ON public.restaurant_fiscal_acknowledgements
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "fiscal_z_reports_read" ON public.restaurant_fiscal_z_reports
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
CREATE POLICY "fiscal_z_reports_write" ON public.restaurant_fiscal_z_reports
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','accountant']::restaurant_role[]));
