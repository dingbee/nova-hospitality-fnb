-- P02 — LexiBite Commercialization Operating System.
--
-- Builds the commercial TRANSACTION/LIFECYCLE layer on top of P01's already-
-- complete POLICY layer (migration 0034 — plans, entitlements, quotas,
-- pricing, property policy, overrides, commercial admin, commercial audit).
-- P02 does not touch P01's policy tables except two small, additive column
-- additions (tax_rate_pct, proration_policy) needed to make billing
-- computable — nothing P01 already relies on changes shape or meaning.
--
-- REUSE, NOT DUPLICATION:
--   - `restaurant_tenants` remains the one commercial customer identity — no
--     parallel "customer" table. `commercial_billing_accounts` is a 1:1
--     billing-profile EXTENSION of a tenant (contact/currency/tax details),
--     the same pattern `commercial_property_classifications` already uses
--     to extend `restaurant_properties`.
--   - `restaurant_subscriptions` (extended by 0034 with plan_id/
--     programme_id/billing_interval) remains the ONE current-subscription
--     row per tenant; P02 adds lifecycle columns to it rather than
--     inventing a second subscription concept. Multi-row HISTORY (plan
--     changes, renewals) lives in `commercial_agreements`, one row per
--     signed/renewed contract, plus the existing `commercial_audit_log`.
--   - `commercial_property_classifications` (0034) remains the ONE place a
--     property's chargeability is decided — P02 only adds a foreign key
--     from invoice lines back to it, never a second classification.
--   - Invoice numbering reuses `restaurant_next_document_number()` (the
--     same sequence every procurement/sales document already uses), widened
--     with one additive OR clause so a commercial admin — who is not
--     necessarily a member of the customer's tenant — can generate a
--     number for that tenant's commercial documents. Every existing tenant-
--     member caller is unaffected.
--   - Commercial notification delivery reuses `src/lib/notifications/
--     adapters.server.ts` (the same `sendEmail` used by receipts and PO
--     delivery) — `commercial_notifications` only records the attempt,
--     mirroring `restaurant_po_deliveries`' shape; it is not a second
--     send-path.
--   - `commercial_audit_log` (0034) remains the one commercial audit trail
--     — every P02 write appends to it via the existing `writeCommercialAudit`
--     helper, no new audit table.
--
-- PAYMENTS: no payment-gateway credentials exist anywhere in this
-- environment (confirmed by inspection — the existing Mobile Money module
-- is a DIFFERENT domain: guests paying a restaurant for their meal, not a
-- restaurant tenant paying LexiBite for its subscription). Rather than
-- fabricate a live gateway integration, `commercial_payments` supports a
-- real, working "manual recording" path (a commercial admin records a bank
-- transfer / mobile money reference they received) plus a
-- `commercial_payment_webhook_events` table so a real gateway can be wired
-- in later without a schema change — this is the "provider abstraction"
-- the spec asks for when no provider is yet integrated (§16).
--
-- NO SCHEDULER: this codebase has no cron/job-queue infrastructure
-- (confirmed by inspection). "Overdue" is therefore a computed read-time
-- state (issued, due_date passed, balance > 0), not a stored transition;
-- past-due handling (grace period → suspension) is an explicit
-- commercial-admin action surfaced by the dashboard's "overdue invoices"
-- list, not an automatic timer — stated here rather than fabricating a
-- background job that does not exist.

-- =========================================================================
-- 1. BILLING ACCOUNT — 1:1 commercial-identity extension of a tenant
-- =========================================================================

CREATE TABLE public.commercial_billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'TZS',
  billing_contact_name text,
  billing_contact_email text,
  billing_contact_phone text,
  billing_address text,
  tax_id text,
  payment_method_reference text,
  commercial_status text NOT NULL DEFAULT 'prospect' CHECK (commercial_status IN (
    'prospect', 'active', 'past_due', 'suspended', 'cancelled'
  )),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.commercial_billing_accounts TO authenticated;
GRANT ALL ON public.commercial_billing_accounts TO service_role;
ALTER TABLE public.commercial_billing_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "billing accounts readable by own tenant or commercial admins" ON public.commercial_billing_accounts
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "billing accounts managed by commercial admins" ON public.commercial_billing_accounts
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_billing_accounts_updated_at BEFORE UPDATE ON public.commercial_billing_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 2. COMMERCIAL AGREEMENTS — the signed-terms snapshot
-- =========================================================================
--
-- One row per signed or renewed contract. A future admin editing the live
-- `commercial_pricing` catalogue never rewrites an already-signed
-- agreement: every price the agreement charges is copied onto the
-- agreement row itself at creation time, not re-derived from the catalogue
-- on read.

CREATE TABLE public.commercial_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  contract_reference text NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.commercial_plans(id),
  programme_id uuid REFERENCES public.commercial_programmes(id),
  subscription_id uuid REFERENCES public.restaurant_subscriptions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'approved', 'active', 'superseded', 'cancelled'
  )),
  billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'annual', 'custom')),
  currency text NOT NULL DEFAULT 'TZS',
  -- Price snapshot — copied from commercial_pricing at creation, never
  -- re-read from it afterward.
  monthly_price numeric(14,2),
  annual_price numeric(14,2),
  additional_property_price numeric(14,2),
  implementation_fee numeric(14,2),
  discount_pct numeric(5,2),
  discount_amount numeric(14,2),
  discount_reason text,
  tax_treatment text NOT NULL DEFAULT 'exclusive' CHECK (tax_treatment IN ('inclusive', 'exclusive', 'exempt')),
  tax_rate_pct numeric(5,2),
  requires_payment_before_activation boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  renewal_date date,
  agreed_terms text,
  renewed_from_agreement_id uuid REFERENCES public.commercial_agreements(id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commercial_agreements_reference_uq ON public.commercial_agreements (contract_reference);
CREATE INDEX commercial_agreements_tenant_idx ON public.commercial_agreements (tenant_id, created_at DESC);

GRANT SELECT ON public.commercial_agreements TO authenticated;
GRANT ALL ON public.commercial_agreements TO service_role;
ALTER TABLE public.commercial_agreements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agreements readable by own tenant or commercial admins" ON public.commercial_agreements
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "agreements managed by commercial admins" ON public.commercial_agreements
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_agreements_updated_at BEFORE UPDATE ON public.commercial_agreements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 3. SUBSCRIPTION LIFECYCLE — extend restaurant_subscriptions (reuse)
-- =========================================================================

ALTER TABLE public.restaurant_subscriptions
  ADD COLUMN agreement_id uuid REFERENCES public.commercial_agreements(id) ON DELETE SET NULL,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN renewal_date date,
  ADD COLUMN renewal_status text NOT NULL DEFAULT 'not_due' CHECK (renewal_status IN ('not_due', 'due', 'renewed', 'declined')),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by uuid,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN past_due_since timestamptz;

-- restaurant_subscriptions.status was previously an unconstrained free-text
-- column with zero live rows (confirmed by inspection — no write path
-- existed before 0034's admin `upsertSubscription`, and that is the only
-- writer to date). Constraining it now to the P02 lifecycle states is safe
-- and closes the gap the spec calls out ("draft/pending_activation/active/
-- trial/past_due/suspended/cancelled/expired/renewing").
ALTER TABLE public.restaurant_subscriptions
  ADD CONSTRAINT restaurant_subscriptions_status_enum CHECK (status IN (
    'draft', 'pending_activation', 'active', 'trial', 'past_due',
    'suspended', 'cancelled', 'expired', 'renewing'
  ));

CREATE INDEX restaurant_subscriptions_agreement_idx ON public.restaurant_subscriptions (agreement_id);

-- =========================================================================
-- 4. INVOICES + LINES
-- =========================================================================

CREATE TABLE public.commercial_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  agreement_id uuid REFERENCES public.commercial_agreements(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES public.restaurant_subscriptions(id) ON DELETE SET NULL,
  billing_period_start date,
  billing_period_end date,
  issue_date date,
  due_date date,
  currency text NOT NULL DEFAULT 'TZS',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'issued', 'partially_paid', 'paid', 'void', 'cancelled'
  )),
  notes text,
  void_reason text,
  voided_at timestamptz,
  created_by uuid NOT NULL,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commercial_invoices_number_uq ON public.commercial_invoices (invoice_number);
CREATE INDEX commercial_invoices_tenant_idx ON public.commercial_invoices (tenant_id, created_at DESC);
CREATE INDEX commercial_invoices_status_idx ON public.commercial_invoices (status, due_date);

GRANT SELECT ON public.commercial_invoices TO authenticated;
GRANT ALL ON public.commercial_invoices TO service_role;
ALTER TABLE public.commercial_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices readable by own tenant or commercial admins" ON public.commercial_invoices
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "invoices managed by commercial admins" ON public.commercial_invoices
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_invoices_updated_at BEFORE UPDATE ON public.commercial_invoices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.commercial_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'base_subscription', 'additional_property', 'implementation', 'add_on', 'discount', 'tax', 'other'
  )),
  description text NOT NULL,
  quantity numeric(14,4) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  amount numeric(14,2) NOT NULL,
  -- Traceability: what commercial record produced this line. Never an
  -- arbitrary UI string with no source.
  source_type text CHECK (source_type IN (
    'agreement', 'subscription', 'property_classification', 'override', 'manual'
  )),
  source_id uuid,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX commercial_invoice_lines_invoice_idx ON public.commercial_invoice_lines (invoice_id, sort_order);

GRANT SELECT ON public.commercial_invoice_lines TO authenticated;
GRANT ALL ON public.commercial_invoice_lines TO service_role;
ALTER TABLE public.commercial_invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice lines readable via parent invoice" ON public.commercial_invoice_lines
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.commercial_invoices i WHERE i.id = invoice_id
      AND (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(i.tenant_id))
  ));
CREATE POLICY "invoice lines managed by commercial admins" ON public.commercial_invoice_lines
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- One invoice line per property-classification charge — a chargeable
-- property is invoiced exactly once, never duplicated by a retried request.
CREATE UNIQUE INDEX commercial_invoice_lines_property_charge_uq
  ON public.commercial_invoice_lines (source_id) WHERE source_type = 'property_classification';

-- =========================================================================
-- 5. PAYMENTS + WEBHOOK SCAFFOLD
-- =========================================================================

CREATE TABLE public.commercial_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.commercial_invoices(id) ON DELETE CASCADE,
  billing_account_id uuid REFERENCES public.commercial_billing_accounts(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN (
    'manual_bank_transfer', 'manual_mobile_money', 'manual_cash', 'manual_cheque', 'card', 'gateway', 'other'
  )),
  provider text NOT NULL DEFAULT 'manual',
  provider_reference text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'TZS',
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'voided')),
  idempotency_key text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  recorded_by uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commercial_payments_idempotency_uq ON public.commercial_payments (tenant_id, idempotency_key);
CREATE INDEX commercial_payments_invoice_idx ON public.commercial_payments (invoice_id);
CREATE INDEX commercial_payments_tenant_idx ON public.commercial_payments (tenant_id, received_at DESC);

GRANT SELECT ON public.commercial_payments TO authenticated;
GRANT ALL ON public.commercial_payments TO service_role;
ALTER TABLE public.commercial_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payments readable by own tenant or commercial admins" ON public.commercial_payments
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "payments managed by commercial admins" ON public.commercial_payments
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- Webhook-ready scaffold for a future real gateway. Nothing in this
-- environment configures a gateway today (no credentials exist), so this
-- table has no live writer yet — it exists so `verifyAndRecordWebhook`-
-- style idempotent processing can be added later without a schema change.
-- Service-role only: a webhook endpoint runs with the service key, never a
-- user session, and no authenticated user should be able to forge a
-- payment-confirmation event by inserting here directly.
CREATE TABLE public.commercial_payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commercial_payment_webhook_events_uq ON public.commercial_payment_webhook_events (provider, event_id);

GRANT ALL ON public.commercial_payment_webhook_events TO service_role;
ALTER TABLE public.commercial_payment_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook events readable by commercial admins" ON public.commercial_payment_webhook_events
  FOR SELECT TO authenticated USING (public.restaurant_is_commercial_admin(auth.uid()));

-- =========================================================================
-- 6. COMMERCIAL NOTIFICATIONS — delivery record (reuses adapters.server.ts)
-- =========================================================================

CREATE TABLE public.commercial_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'not_configured')),
  provider_reference text,
  failure_reason text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commercial_notifications_idempotency_uq ON public.commercial_notifications (tenant_id, idempotency_key);
CREATE INDEX commercial_notifications_tenant_idx ON public.commercial_notifications (tenant_id, created_at DESC);

GRANT SELECT ON public.commercial_notifications TO authenticated;
GRANT ALL ON public.commercial_notifications TO service_role;
ALTER TABLE public.commercial_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications readable by own tenant or commercial admins" ON public.commercial_notifications
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "notifications managed by commercial admins" ON public.commercial_notifications
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- =========================================================================
-- 7. P01 EXTENSIONS — proration policy + tax rate (additive, optional)
-- =========================================================================

ALTER TABLE public.commercial_property_policies
  ADD COLUMN proration_policy text NOT NULL DEFAULT 'next_period'
    CHECK (proration_policy IN ('full_period', 'prorated', 'next_period'));

-- Nullable, admin-set — never a hardcoded tax law/rate in application code.
ALTER TABLE public.commercial_pricing
  ADD COLUMN tax_rate_pct numeric(5,2);

-- =========================================================================
-- 8. DOCUMENT NUMBERING — widen for commercial admins (additive OR only)
-- =========================================================================
--
-- Unchanged behaviour for every existing tenant-member caller (the
-- `restaurant_can_read` branch is untouched); a commercial admin — who
-- issues documents FOR a tenant without being a member OF it — is simply
-- ALSO allowed through. No existing caller loses access.

CREATE OR REPLACE FUNCTION public.restaurant_next_document_number(_tenant uuid, _doc_type text, _prefix text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare _n bigint; _p text;
begin
  if not (public.restaurant_can_read(_tenant) or public.restaurant_is_commercial_admin(auth.uid())) then
    raise exception 'Forbidden — not a member of this restaurant tenant.';
  end if;
  insert into public.restaurant_document_sequences (tenant_id, doc_type, prefix, next_number)
  values (_tenant, _doc_type, coalesce(nullif(_prefix,''), upper(left(_doc_type, 3))), 1)
  on conflict (tenant_id, doc_type)
  do update set next_number = public.restaurant_document_sequences.next_number + 1, updated_at = now()
  returning next_number, prefix into _n, _p;
  return _p || '-' || to_char(now(), 'YYYY') || '-' || lpad(_n::text, 5, '0');
end;
$$;
