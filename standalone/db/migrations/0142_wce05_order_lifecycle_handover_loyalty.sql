-- WCE-05 — order lifecycle notifications, human handover and guest loyalty ledger.
ALTER TABLE public.wa_conversations
  ADD COLUMN IF NOT EXISTS handoff_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_reason text,
  ADD COLUMN IF NOT EXISTS assigned_staff_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.wa_conversation_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  location_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES public.wa_webhook_events(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'resolved', 'cancelled')),
  assigned_staff_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT wa_conversation_handoffs_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, conversation_id)
    REFERENCES public.wa_conversations(tenant_id, property_id, location_id, id) ON DELETE CASCADE,
  CONSTRAINT wa_conversation_handoffs_event_uq UNIQUE (tenant_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS wa_conversation_handoffs_open_idx
  ON public.wa_conversation_handoffs (tenant_id, property_id, location_id, status, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_orders_scope_id_uq
  ON public.restaurant_orders (tenant_id, property_id, location_id, id);

CREATE TABLE IF NOT EXISTS public.wa_order_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  location_id uuid NOT NULL,
  order_id uuid NOT NULL,
  guest_customer_id uuid,
  conversation_id uuid,
  order_status text NOT NULL,
  notification_state text NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending', 'queued', 'sent', 'deferred_template', 'suppressed', 'failed')),
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_order_notification_events_order_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, order_id)
    REFERENCES public.restaurant_orders(tenant_id, property_id, location_id, id) ON DELETE CASCADE,
  CONSTRAINT wa_order_notification_events_customer_scope_fkey
    FOREIGN KEY (tenant_id, guest_customer_id)
    REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE SET NULL (guest_customer_id),
  CONSTRAINT wa_order_notification_events_conversation_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, conversation_id)
    REFERENCES public.wa_conversations(tenant_id, property_id, location_id, id) ON DELETE SET NULL (conversation_id),
  CONSTRAINT wa_order_notification_events_status_uq UNIQUE (tenant_id, order_id, order_status)
);
CREATE INDEX IF NOT EXISTS wa_order_notification_events_pending_idx
  ON public.wa_order_notification_events (tenant_id, notification_state, created_at);

CREATE TABLE IF NOT EXISTS public.restaurant_guest_loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  enabled boolean NOT NULL DEFAULT false,
  points_per_1000_units numeric(12,4) NOT NULL DEFAULT 1 CHECK (points_per_1000_units >= 0),
  minimum_order_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (minimum_order_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_guest_loyalty_programs_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT restaurant_guest_loyalty_programs_currency_uq
    UNIQUE (tenant_id, property_id, currency)
);

CREATE TABLE IF NOT EXISTS public.restaurant_guest_loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  guest_customer_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  entry_type text NOT NULL CHECK (entry_type IN ('earn', 'redeem', 'adjust', 'expire')),
  points_delta integer NOT NULL CHECK (points_delta <> 0),
  amount_basis numeric(14,2),
  reference_type text,
  reference_id uuid,
  idempotency_key text NOT NULL,
  note text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_guest_loyalty_ledger_customer_scope_fkey
    FOREIGN KEY (tenant_id, guest_customer_id)
    REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_guest_loyalty_ledger_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_guest_loyalty_ledger_dedupe_uq UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS restaurant_guest_loyalty_ledger_balance_idx
  ON public.restaurant_guest_loyalty_ledger (tenant_id, guest_customer_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.restaurant_guest_loyalty_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $wce$
BEGIN
  RAISE EXCEPTION 'Guest loyalty ledger is append-only';
END;
$wce$;
REVOKE ALL ON FUNCTION public.restaurant_guest_loyalty_ledger_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_guest_loyalty_ledger_immutable() TO service_role;
DROP TRIGGER IF EXISTS restaurant_guest_loyalty_ledger_immutable_guard
  ON public.restaurant_guest_loyalty_ledger;
CREATE TRIGGER restaurant_guest_loyalty_ledger_immutable_guard
BEFORE UPDATE OR DELETE ON public.restaurant_guest_loyalty_ledger
FOR EACH ROW EXECUTE FUNCTION public.restaurant_guest_loyalty_ledger_immutable();

ALTER TABLE public.wa_conversation_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_order_notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_guest_loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_guest_loyalty_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_conversation_handoffs_read_scoped ON public.wa_conversation_handoffs;
CREATE POLICY wa_conversation_handoffs_read_scoped ON public.wa_conversation_handoffs
FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS restaurant_guest_loyalty_programs_read_scoped ON public.restaurant_guest_loyalty_programs;
CREATE POLICY restaurant_guest_loyalty_programs_read_scoped ON public.restaurant_guest_loyalty_programs
FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS restaurant_guest_loyalty_ledger_read_scoped ON public.restaurant_guest_loyalty_ledger;
CREATE POLICY restaurant_guest_loyalty_ledger_read_scoped ON public.restaurant_guest_loyalty_ledger
FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));

GRANT SELECT ON public.wa_conversation_handoffs,
  public.restaurant_guest_loyalty_programs,
  public.restaurant_guest_loyalty_ledger TO authenticated;
GRANT ALL ON public.wa_conversation_handoffs,
  public.wa_order_notification_events,
  public.restaurant_guest_loyalty_programs,
  public.restaurant_guest_loyalty_ledger TO service_role;

NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION public.restaurant_guest_loyalty_balance(
  _tenant_id uuid,
  _guest_customer_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
  SELECT coalesce(sum(l.points_delta), 0)::bigint
  FROM public.restaurant_guest_loyalty_ledger l
  WHERE l.tenant_id = _tenant_id
    AND l.guest_customer_id = _guest_customer_id;
$wce$;
REVOKE ALL ON FUNCTION public.restaurant_guest_loyalty_balance(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_guest_loyalty_balance(uuid, uuid)
  TO service_role;
