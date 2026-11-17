-- P04 — Commercial Intelligence & Automation.
--
-- Adds exactly two new tables, additive on top of P01 (policy)/P02
-- (transactions)/P03 (operations) — nothing here duplicates a truth that
-- already lives elsewhere:
--   - commercial_signals: deduplicated, auto-resolving detected conditions
--     (renewal risk, overdue balance, health deterioration, expansion
--     opportunity, quota pressure, revenue contraction/expansion), computed
--     at read/rescan time from existing commercial_* records — there is no
--     scheduler in this codebase (P03's own ageing/renewal-risk discipline),
--     so a signal is a row that gets refreshed on demand, not a background job.
--   - commercial_recommendations: an explainable, actionable, auditable
--     follow-up item derived from a signal. Completing one IS the "controlled
--     commercial action" the P04 spec asks for — every recommended action
--     type (REVIEW_CUSTOMER, CONTACT_CUSTOMER, REVIEW_RENEWAL,
--     REVIEW_COLLECTION, REVIEW_EXPANSION, REVIEW_UPGRADE, REVIEW_USAGE) is a
--     review/contact task, never an autonomous financial mutation — a real
--     mutation (renew, suspend, record a payment) stays exactly where P02/P03
--     already put it. This is deliberately two tables, not three: a third
--     "actions" table would just re-describe recommendation.status.
--
-- This is platform-level commercial data, not tenant-operational data: RLS
-- on both tables is commercial-admin-only, mirroring commercial_administrators
-- itself (migration 0034) — an ordinary tenant admin must never see why their
-- own account was flagged internally, and must never see another tenant's
-- signals at all. Writes happen under the calling commercial admin's own
-- authenticated session (rescanning/completing), exactly like every other
-- commercial_* write in this codebase — there is no service-role background
-- writer anywhere in this system.

CREATE TABLE public.commercial_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('renewal', 'collection', 'health', 'expansion', 'usage', 'revenue')),
  signal_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  -- Stable per (tenant, signal_type, natural key) — a rescan that finds the
  -- same condition again touches last_seen_at instead of inserting a
  -- duplicate row. This IS the dedup/idempotency mechanism (P04 §7).
  dedupe_key text NOT NULL UNIQUE,
  title text NOT NULL,
  detail text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_signals_tenant_idx ON public.commercial_signals (tenant_id, status);
CREATE INDEX commercial_signals_status_idx ON public.commercial_signals (status, severity);

GRANT SELECT ON public.commercial_signals TO authenticated;
GRANT ALL ON public.commercial_signals TO service_role;
ALTER TABLE public.commercial_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commercial signals readable by commercial admins" ON public.commercial_signals
  FOR SELECT TO authenticated USING (public.restaurant_is_commercial_admin(auth.uid()));
CREATE POLICY "commercial signals managed by commercial admins" ON public.commercial_signals
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_signals_updated_at BEFORE UPDATE ON public.commercial_signals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.commercial_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  signal_id uuid REFERENCES public.commercial_signals(id) ON DELETE SET NULL,
  action_type text NOT NULL CHECK (action_type IN (
    'REVIEW_CUSTOMER', 'CONTACT_CUSTOMER', 'REVIEW_RENEWAL', 'REVIEW_COLLECTION',
    'REVIEW_EXPANSION', 'REVIEW_UPGRADE', 'REVIEW_USAGE'
  )),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'dismissed')),
  -- One open recommendation per (tenant, action_type, source signal) at a
  -- time — a rescan never piles up duplicate "Review renewal for X" cards.
  dedupe_key text NOT NULL UNIQUE,
  completed_by uuid,
  completed_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_recommendations_tenant_idx ON public.commercial_recommendations (tenant_id, status);

GRANT SELECT ON public.commercial_recommendations TO authenticated;
GRANT ALL ON public.commercial_recommendations TO service_role;
ALTER TABLE public.commercial_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commercial recommendations readable by commercial admins" ON public.commercial_recommendations
  FOR SELECT TO authenticated USING (public.restaurant_is_commercial_admin(auth.uid()));
CREATE POLICY "commercial recommendations managed by commercial admins" ON public.commercial_recommendations
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_recommendations_updated_at BEFORE UPDATE ON public.commercial_recommendations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
