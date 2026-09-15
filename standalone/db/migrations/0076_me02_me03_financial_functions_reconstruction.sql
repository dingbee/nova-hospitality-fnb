-- Corrective integration (ME-01/02/03 reconciliation): the 18 production-only
-- financial-control functions.
--
-- Root cause: migration 0048_p11_security_hardening.sql REVOKEs/GRANTs
-- EXECUTE on 20 cash-payout/daily-close/tender-declaration/giveaway
-- functions, but never CREATEs them -- their defining migration was never
-- committed to Git. They have been live in production
-- (lusiqcmxfxhnehxmwihs) since before this repository's earliest captured
-- baseline. Of the 20, `restaurant_daily_close_property` was independently
-- defined in 0033_p1_reconciliation_property_scope.sql; the other 19
-- (the 18 named in the ME-03 evidence document plus restaurant_day_is_locked,
-- found while reading their bodies -- every one of the 18 calls it) are
-- reconstructed below verbatim from live `pg_get_functiondef` /
-- `pg_get_triggerdef` output plus `information_schema`/`pg_constraint`/
-- `pg_indexes`/`pg_policies` introspection, captured 2026-09-15 against the
-- authoritative production database. Three backing tables
-- (restaurant_cash_payouts, restaurant_cash_payout_events,
-- restaurant_declaration_revisions) were likewise never committed. Two
-- existing tables (restaurant_daily_closes, restaurant_discount_applications)
-- are missing columns this subsystem depends on.
--
-- Every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded
-- DO blocks) so this migration is a no-op against the production database it
-- was reconstructed from, and reproduces the identical live state on a fresh
-- install.

-- ---------------------------------------------------------------------
-- 1. Missing columns on existing tables
-- ---------------------------------------------------------------------

ALTER TABLE public.restaurant_daily_closes
  ADD COLUMN IF NOT EXISTS blind_declaration boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cash_payouts numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_cash numeric(14,2),
  ADD COLUMN IF NOT EXISTS variance_tolerance numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_override_reason text,
  ADD COLUMN IF NOT EXISTS variance_authorized_by uuid,
  ADD COLUMN IF NOT EXISTS variance_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_request_id text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_daily_closes_tolerance_nonneg'
  ) THEN
    ALTER TABLE public.restaurant_daily_closes
      ADD CONSTRAINT restaurant_daily_closes_tolerance_nonneg
      CHECK (variance_tolerance >= 0 AND cash_payouts >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_daily_closes_client_request_key
  ON public.restaurant_daily_closes (tenant_id, client_request_id)
  WHERE (client_request_id IS NOT NULL);

ALTER TABLE public.restaurant_discount_applications
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'discount',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS percent numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS request_key text,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS applied_amount numeric(14,4),
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS reverses_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_discount_applications_reverses_id_fkey'
  ) THEN
    ALTER TABLE public.restaurant_discount_applications
      ADD CONSTRAINT restaurant_discount_applications_reverses_id_fkey
      FOREIGN KEY (reverses_id) REFERENCES public.restaurant_discount_applications(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_discount_app_kind_chk'
  ) THEN
    ALTER TABLE public.restaurant_discount_applications
      ADD CONSTRAINT restaurant_discount_app_kind_chk CHECK (kind = ANY (ARRAY['discount','comp']));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_discount_app_status_chk'
  ) THEN
    ALTER TABLE public.restaurant_discount_applications
      ADD CONSTRAINT restaurant_discount_app_status_chk CHECK (status = ANY (ARRAY['pending','approved','rejected']));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rest_discount_app_item ON public.restaurant_discount_applications (tenant_id, order_item_id);
CREATE INDEX IF NOT EXISTS idx_rest_discount_app_status ON public.restaurant_discount_applications (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_discount_rule_id ON public.restaurant_discount_applications (discount_rule_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_order_id ON public.restaurant_discount_applications (order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_order_item_id ON public.restaurant_discount_applications (order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_reverses_id ON public.restaurant_discount_applications (reverses_id);

-- ---------------------------------------------------------------------
-- 2. Missing tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.restaurant_cash_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'TZS',
  category text,
  reason text NOT NULL,
  reference text,
  document_number text,
  client_request_id text,
  reversal_of uuid REFERENCES public.restaurant_cash_payouts(id) ON DELETE RESTRICT,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  paid_by uuid,
  paid_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_cash_payouts_reason_chk CHECK (length(btrim(reason)) >= 5),
  CONSTRAINT restaurant_cash_payouts_signed_chk CHECK (
    (reversal_of IS NULL AND amount > 0) OR (reversal_of IS NOT NULL AND amount < 0)
  ),
  CONSTRAINT restaurant_cash_payouts_status_chk CHECK (status = ANY (ARRAY['requested','approved','paid','rejected']))
);

CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payouts_location_id ON public.restaurant_cash_payouts (location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payouts_property_id ON public.restaurant_cash_payouts (property_id);
CREATE INDEX IF NOT EXISTS restaurant_cash_payouts_day_idx ON public.restaurant_cash_payouts (tenant_id, business_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_cash_payouts_request_key ON public.restaurant_cash_payouts (tenant_id, client_request_id) WHERE (client_request_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS restaurant_cash_payouts_reversal_idx ON public.restaurant_cash_payouts (reversal_of);

ALTER TABLE public.restaurant_cash_payouts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_cash_payouts TO authenticated;
GRANT ALL ON public.restaurant_cash_payouts TO service_role;

DROP POLICY IF EXISTS "cash payouts read" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts read" ON public.restaurant_cash_payouts FOR SELECT TO public
  USING (restaurant_can_read(tenant_id));

DROP POLICY IF EXISTS "cash payouts write" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts write" ON public.restaurant_cash_payouts FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[]));

DROP POLICY IF EXISTS "cash payouts transition" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts transition" ON public.restaurant_cash_payouts FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[]));

CREATE TABLE IF NOT EXISTS public.restaurant_cash_payout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  payout_id uuid NOT NULL REFERENCES public.restaurant_cash_payouts(id) ON DELETE CASCADE,
  action text NOT NULL,
  previous_state text,
  new_state text,
  amount numeric(14,2) NOT NULL,
  reason text,
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payout_events_tenant_id ON public.restaurant_cash_payout_events (tenant_id);
CREATE INDEX IF NOT EXISTS restaurant_cash_payout_events_payout_idx ON public.restaurant_cash_payout_events (payout_id, occurred_at DESC);

ALTER TABLE public.restaurant_cash_payout_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.restaurant_cash_payout_events TO authenticated;
GRANT ALL ON public.restaurant_cash_payout_events TO service_role;

DROP POLICY IF EXISTS "cash payout events read" ON public.restaurant_cash_payout_events;
CREATE POLICY "cash payout events read" ON public.restaurant_cash_payout_events FOR SELECT TO public
  USING (restaurant_can_read(tenant_id));

CREATE TABLE IF NOT EXISTS public.restaurant_declaration_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  close_id uuid NOT NULL REFERENCES public.restaurant_daily_closes(id) ON DELETE CASCADE,
  declaration_id uuid,
  method text NOT NULL,
  revision integer NOT NULL,
  declared_amount numeric(14,2) NOT NULL,
  system_amount numeric(14,2) NOT NULL,
  variance numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'TZS',
  notes text,
  superseded_reason text,
  declared_by uuid,
  declared_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_declaration_revisions_tenant_id ON public.restaurant_declaration_revisions (tenant_id);
CREATE INDEX IF NOT EXISTS restaurant_declaration_revisions_close_idx ON public.restaurant_declaration_revisions (close_id, method, revision);

ALTER TABLE public.restaurant_declaration_revisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.restaurant_declaration_revisions TO authenticated;
GRANT ALL ON public.restaurant_declaration_revisions TO service_role;

DROP POLICY IF EXISTS "declaration revisions read" ON public.restaurant_declaration_revisions;
CREATE POLICY "declaration revisions read" ON public.restaurant_declaration_revisions FOR SELECT TO public
  USING (restaurant_can_read(tenant_id));

DROP POLICY IF EXISTS "declaration revisions append" ON public.restaurant_declaration_revisions;
CREATE POLICY "declaration revisions append" ON public.restaurant_declaration_revisions FOR INSERT TO public
  WITH CHECK (restaurant_can_read(tenant_id));

-- ---------------------------------------------------------------------
-- 3. Functions (verbatim pg_get_functiondef, captured 2026-09-15)
-- ---------------------------------------------------------------------

-- restaurant_day_is_locked: a 19th function in this same drift class,
-- discovered while reading the bodies of the 18 above (restaurant_cash_
-- payout_control, restaurant_giveaway_guard, restaurant_giveaway_period_lock
-- and restaurant_request_giveaway all call it). Same root cause as the other
-- 18: revoked/granted by 0048 but never CREATEd by any Git migration.
CREATE OR REPLACE FUNCTION public.restaurant_day_is_locked(_tenant_id uuid, _location_id uuid, _business_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.restaurant_daily_closes c WHERE c.tenant_id=_tenant_id AND c.business_date=_business_date AND c.status='closed' AND (c.location_id IS NULL OR c.location_id=_location_id)); $function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_total(_tenant_id uuid, _location_id uuid, _business_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT round(COALESCE(SUM(p.amount),0),2) FROM public.restaurant_cash_payouts p WHERE p.tenant_id=_tenant_id AND p.business_date=_business_date AND p.status IN ('approved','paid') AND (_location_id IS NULL OR p.location_id IS NULL OR p.location_id=_location_id); $function$;

CREATE OR REPLACE FUNCTION public.restaurant_expected_tender(_close_id uuid, _method text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE c record; win_from timestamptz; win_to timestamptz; ledger numeric:=0; BEGIN SELECT * INTO c FROM public.restaurant_daily_closes WHERE id=_close_id; IF c IS NULL THEN RAISE EXCEPTION 'Daily close does not exist.'; END IF; win_from:=(c.business_date::timestamp AT TIME ZONE 'UTC')+interval '4 hours'; win_to:=win_from+interval '24 hours'; SELECT COALESCE(SUM(p.amount),0) INTO ledger FROM public.restaurant_payments p JOIN public.restaurant_orders o ON o.id=p.order_id AND o.tenant_id=p.tenant_id WHERE p.tenant_id=c.tenant_id AND p.method=_method AND o.opened_at>=win_from AND o.opened_at<win_to AND (c.location_id IS NULL OR o.location_id=c.location_id); IF _method='cash' THEN RETURN round(COALESCE(c.opening_float,0)+ledger-COALESCE(c.cash_payouts,0),2); END IF; RETURN round(ledger,2); END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE privileged boolean:=current_user IN ('service_role','postgres','supabase_admin'); original record; reversed_so_far numeric; BEGIN IF TG_OP='INSERT' THEN IF public.restaurant_day_is_locked(NEW.tenant_id,NEW.location_id,NEW.business_date) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before recording a cash payout against it.' USING ERRCODE='55006'; END IF; NEW.status:='requested'; NEW.requested_by:=COALESCE(NEW.requested_by,auth.uid()); NEW.requested_at:=now(); NEW.approved_by:=NULL; NEW.approved_at:=NULL; NEW.paid_by:=NULL; NEW.paid_at:=NULL; NEW.rejected_by:=NULL; NEW.rejected_at:=NULL; NEW.rejection_reason:=NULL; IF NEW.reversal_of IS NOT NULL THEN SELECT * INTO original FROM public.restaurant_cash_payouts WHERE id=NEW.reversal_of FOR UPDATE; IF original IS NULL THEN RAISE EXCEPTION 'The payout being reversed does not exist.' USING ERRCODE='no_data_found'; END IF; IF original.tenant_id<>NEW.tenant_id OR original.business_date<>NEW.business_date OR COALESCE(original.location_id,'00000000-0000-0000-0000-000000000000'::uuid)<>COALESCE(NEW.location_id,'00000000-0000-0000-0000-000000000000'::uuid) THEN RAISE EXCEPTION 'A reversal must sit in the same tenant, outlet and business day as the payout it corrects.' USING ERRCODE='check_violation'; END IF; IF original.reversal_of IS NOT NULL THEN RAISE EXCEPTION 'A reversal cannot itself be reversed.' USING ERRCODE='check_violation'; END IF; IF original.status NOT IN ('approved','paid') THEN RAISE EXCEPTION 'Only an approved or paid payout can be reversed; this one is %.',original.status USING ERRCODE='check_violation'; END IF; SELECT COALESCE(SUM(-r.amount),0) INTO reversed_so_far FROM public.restaurant_cash_payouts r WHERE r.reversal_of=original.id AND r.status IN ('requested','approved','paid'); IF reversed_so_far+(-NEW.amount)>original.amount+0.005 THEN RAISE EXCEPTION 'A payout cannot be reversed by more than it took out of the drawer.' USING ERRCODE='check_violation'; END IF; END IF; RETURN NEW; END IF; IF NEW.tenant_id<>OLD.tenant_id OR NEW.business_date<>OLD.business_date OR NEW.amount<>OLD.amount OR COALESCE(NEW.location_id,'00000000-0000-0000-0000-000000000000'::uuid)<>COALESCE(OLD.location_id,'00000000-0000-0000-0000-000000000000'::uuid) OR COALESCE(NEW.reversal_of,'00000000-0000-0000-0000-000000000000'::uuid)<>COALESCE(OLD.reversal_of,'00000000-0000-0000-0000-000000000000'::uuid) OR COALESCE(NEW.requested_by,'00000000-0000-0000-0000-000000000000'::uuid)<>COALESCE(OLD.requested_by,'00000000-0000-0000-0000-000000000000'::uuid) OR COALESCE(NEW.client_request_id,'')<>COALESCE(OLD.client_request_id,'') THEN RAISE EXCEPTION 'A recorded cash payout cannot be rewritten. Reverse it with a counter-entry instead.' USING ERRCODE='55006'; END IF; IF NEW.status=OLD.status THEN RETURN NEW; END IF; IF public.restaurant_day_is_locked(OLD.tenant_id,OLD.location_id,OLD.business_date) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before changing a cash payout in it.' USING ERRCODE='55006'; END IF; IF OLD.status IN ('paid','rejected') THEN RAISE EXCEPTION 'A % payout is final. Reverse it with a counter-entry instead.',OLD.status USING ERRCODE='55006'; END IF; IF NEW.status='approved' THEN IF OLD.status<>'requested' THEN RAISE EXCEPTION 'Only a requested payout can be approved.' USING ERRCODE='check_violation'; END IF; NEW.approved_by:=COALESCE(NEW.approved_by,auth.uid()); NEW.approved_at:=now(); IF NEW.approved_by IS NULL THEN RAISE EXCEPTION 'An approval must carry the name of the person who gave it.' USING ERRCODE='check_violation'; END IF; IF NEW.approved_by=OLD.requested_by THEN RAISE EXCEPTION 'A cash payout must be approved by someone other than the person who requested it.' USING ERRCODE='check_violation'; END IF; IF NOT privileged AND NOT public.restaurant_can_write(NEW.tenant_id,ARRAY['owner','general_manager','accountant']::public.restaurant_role[]) THEN RAISE EXCEPTION 'Approving a cash payout requires an owner, general manager or accountant.' USING ERRCODE='42501'; END IF; ELSIF NEW.status='paid' THEN IF OLD.status<>'approved' THEN RAISE EXCEPTION 'Only an approved payout can be paid out.' USING ERRCODE='check_violation'; END IF; NEW.paid_by:=COALESCE(NEW.paid_by,auth.uid()); NEW.paid_at:=now(); IF NEW.paid_by IS NULL THEN RAISE EXCEPTION 'A payment must carry the name of the person who handed the cash over.' USING ERRCODE='check_violation'; END IF; IF NOT privileged AND NOT public.restaurant_can_write(NEW.tenant_id,ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::public.restaurant_role[]) THEN RAISE EXCEPTION 'Paying out cash requires a member of the outlet''s cash-handling roles.' USING ERRCODE='42501'; END IF; ELSIF NEW.status='rejected' THEN NEW.rejected_by:=COALESCE(NEW.rejected_by,auth.uid()); NEW.rejected_at:=now(); IF COALESCE(length(btrim(NEW.rejection_reason)),0)<5 THEN RAISE EXCEPTION 'Refusing a cash payout requires a reason.' USING ERRCODE='check_violation'; END IF; IF NOT privileged AND NOT public.restaurant_can_write(NEW.tenant_id,ARRAY['owner','general_manager','accountant']::public.restaurant_role[]) THEN RAISE EXCEPTION 'Refusing a cash payout requires an owner, general manager or accountant.' USING ERRCODE='42501'; END IF; ELSE RAISE EXCEPTION 'A cash payout cannot move from % to %.',OLD.status,NEW.status USING ERRCODE='check_violation'; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_events_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF current_user IN ('service_role','postgres','supabase_admin') THEN RETURN COALESCE(NEW,OLD); END IF; RAISE EXCEPTION 'A cash payout event is a permanent record and cannot be changed or removed.' USING ERRCODE='55006'; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF current_user IN ('service_role','postgres','supabase_admin') THEN RETURN OLD; END IF; RAISE EXCEPTION 'A cash payout cannot be deleted. Reverse it with a counter-entry instead.' USING ERRCODE='55006'; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_trail()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE act text; why text; BEGIN IF TG_OP='INSERT' THEN act:=CASE WHEN NEW.reversal_of IS NOT NULL THEN 'payout.reversal_requested' ELSE 'payout.requested' END; why:=NEW.reason; ELSIF NEW.status<>OLD.status THEN act:='payout.'||NEW.status; why:=COALESCE(NEW.rejection_reason,NEW.reason); ELSE RETURN NEW; END IF; INSERT INTO public.restaurant_cash_payout_events(tenant_id,payout_id,action,previous_state,new_state,amount,reason,actor_id) VALUES(NEW.tenant_id,NEW.id,act,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END,NEW.status,NEW.amount,why,auth.uid()); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_daily_close_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE declared_count integer; BEGIN IF NEW.status<>'closed' OR OLD.status='closed' THEN RETURN NEW; END IF; SELECT count(*) INTO declared_count FROM public.restaurant_tender_declarations d WHERE d.close_id=NEW.id; IF NEW.declared_at IS NULL AND declared_count=0 THEN RAISE EXCEPTION 'The drawer must be declared before the day can be closed.' USING ERRCODE='check_violation'; END IF; NEW.expected_cash:=public.restaurant_expected_tender(NEW.id,'cash'); SELECT COALESCE(round(SUM(d.variance),2),0) INTO NEW.declared_variance FROM public.restaurant_tender_declarations d WHERE d.close_id=NEW.id; IF abs(COALESCE(NEW.declared_variance,0))>COALESCE(NEW.variance_tolerance,0)+0.005 THEN IF NEW.variance_authorized_by IS NULL OR COALESCE(length(btrim(NEW.variance_override_reason)),0)<10 THEN RAISE EXCEPTION 'The drawer is out by % beyond the tolerance of %. Closing requires an authorised reason.',round(abs(COALESCE(NEW.declared_variance,0)),2),round(COALESCE(NEW.variance_tolerance,0),2) USING ERRCODE='check_violation'; END IF; NEW.variance_authorized_at:=COALESCE(NEW.variance_authorized_at,now()); END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_daily_close_payout_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN NEW.cash_payouts:=GREATEST(0,public.restaurant_cash_payout_total(NEW.tenant_id,NEW.location_id,NEW.business_date)); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_declaration_revisions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF current_user IN ('service_role','postgres','supabase_admin') THEN RETURN COALESCE(NEW,OLD); END IF; RAISE EXCEPTION 'A declaration revision is a permanent record and cannot be changed or removed.' USING ERRCODE='55006'; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_tender_declaration_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF NEW.declared_amount=OLD.declared_amount THEN RETURN NEW; END IF; INSERT INTO public.restaurant_declaration_revisions(tenant_id,close_id,declaration_id,method,revision,declared_amount,system_amount,variance,currency,notes,superseded_reason,declared_by,declared_at) VALUES(OLD.tenant_id,OLD.close_id,OLD.id,OLD.method,OLD.revision,OLD.declared_amount,OLD.system_amount,OLD.variance,OLD.currency,OLD.notes,NEW.revision_reason,OLD.declared_by,OLD.created_at); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_tender_declaration_control()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE c record; expected numeric; BEGIN SELECT * INTO c FROM public.restaurant_daily_closes WHERE id=NEW.close_id; IF c IS NULL THEN RAISE EXCEPTION 'Daily close not found.' USING ERRCODE='no_data_found'; END IF; IF c.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'That daily close belongs to a different tenant.' USING ERRCODE='check_violation'; END IF; IF c.status='closed' THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before declaring against it.' USING ERRCODE='55006'; END IF; expected:=public.restaurant_expected_tender(NEW.close_id,NEW.method); NEW.system_amount:=expected; NEW.variance:=round(NEW.declared_amount-expected,2); NEW.currency:=COALESCE(NEW.currency,c.currency); IF TG_OP='INSERT' THEN NEW.revision:=1; RETURN NEW; END IF; IF NEW.declared_amount<>OLD.declared_amount THEN IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'A corrected declaration must be recorded as revision %.',OLD.revision+1 USING ERRCODE='check_violation'; END IF; IF COALESCE(length(btrim(NEW.revision_reason)),0)<5 THEN RAISE EXCEPTION 'Correcting a declared amount requires a reason.' USING ERRCODE='check_violation'; END IF; ELSIF NEW.revision<>OLD.revision THEN RAISE EXCEPTION 'A declaration revision cannot be renumbered.' USING ERRCODE='check_violation'; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_apply_giveaway(_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _app public.restaurant_discount_applications; _base numeric(14,4); _rem numeric(14,4); _share numeric(14,4); _line record; _n int; _i int:=0; BEGIN SELECT * INTO _app FROM public.restaurant_discount_applications WHERE id=_application_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Giveaway not found.' USING ERRCODE='22023'; END IF; IF _app.status<>'approved' THEN RAISE EXCEPTION 'Only an approved giveaway may be applied to a bill.' USING ERRCODE='55007'; END IF; IF _app.applied_at IS NOT NULL THEN RETURN; END IF; PERFORM set_config('nova.giveaway_application',_app.id::text,true); IF _app.order_item_id IS NOT NULL THEN UPDATE public.restaurant_order_items i SET discount=ROUND(GREATEST(0,COALESCE(i.discount,0)+_app.amount),2),line_total=ROUND(GREATEST(0,COALESCE(i.line_total,0)-_app.amount),2),discount_rule_id=COALESCE(_app.discount_rule_id,i.discount_rule_id),discount_reason=COALESCE(_app.reason,i.discount_reason),is_comp=CASE WHEN _app.kind='comp' AND _app.amount>0 THEN true WHEN _app.kind='comp' AND _app.amount<0 THEN false ELSE i.is_comp END,comp_reason=CASE WHEN _app.kind='comp' AND _app.amount>0 THEN _app.reason WHEN _app.kind='comp' AND _app.amount<0 THEN NULL ELSE i.comp_reason END,comp_by=CASE WHEN _app.kind='comp' AND _app.amount>0 THEN _app.actor_id WHEN _app.kind='comp' AND _app.amount<0 THEN NULL ELSE i.comp_by END,comp_at=CASE WHEN _app.kind='comp' AND _app.amount>0 THEN now() WHEN _app.kind='comp' AND _app.amount<0 THEN NULL ELSE i.comp_at END,updated_at=now() WHERE i.id=_app.order_item_id AND i.tenant_id=_app.tenant_id; ELSE SELECT COALESCE(SUM(i.quantity*i.unit_price),0) INTO _base FROM public.restaurant_order_items i WHERE i.tenant_id=_app.tenant_id AND i.order_id=_app.order_id AND i.status<>'voided'; IF _base<=0 THEN RAISE EXCEPTION 'This bill has no chargeable lines to discount.' USING ERRCODE='22023'; END IF; SELECT COUNT(*) INTO _n FROM public.restaurant_order_items i WHERE i.tenant_id=_app.tenant_id AND i.order_id=_app.order_id AND i.status<>'voided'; _rem:=_app.amount; FOR _line IN SELECT i.id,(i.quantity*i.unit_price) line_base FROM public.restaurant_order_items i WHERE i.tenant_id=_app.tenant_id AND i.order_id=_app.order_id AND i.status<>'voided' ORDER BY i.created_at,i.id LOOP _i:=_i+1; IF _i=_n THEN _share:=_rem; ELSE _share:=ROUND(_app.amount*(_line.line_base/_base),2); _rem:=_rem-_share; END IF; UPDATE public.restaurant_order_items i SET discount=ROUND(GREATEST(0,COALESCE(i.discount,0)+_share),2),line_total=ROUND(GREATEST(0,COALESCE(i.line_total,0)-_share),2),discount_rule_id=COALESCE(_app.discount_rule_id,i.discount_rule_id),discount_reason=COALESCE(_app.reason,i.discount_reason),updated_at=now() WHERE i.id=_line.id AND i.tenant_id=_app.tenant_id; END LOOP; END IF; UPDATE public.restaurant_discount_applications SET applied_at=now(),applied_amount=_app.amount,updated_at=now() WHERE id=_app.id; UPDATE public.restaurant_orders o SET subtotal=sub.subtotal,discount_total=sub.discount_total,total=sub.total,updated_at=now() FROM (SELECT ROUND(COALESCE(SUM(i.quantity*i.unit_price),0),2) subtotal,ROUND(COALESCE(SUM(i.discount),0),2) discount_total,ROUND(COALESCE(SUM(i.line_total),0),2) total FROM public.restaurant_order_items i WHERE i.tenant_id=_app.tenant_id AND i.order_id=_app.order_id AND i.status<>'voided') sub WHERE o.id=_app.order_id AND o.tenant_id=_app.tenant_id; PERFORM set_config('nova.giveaway_application','',true); END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_decide_giveaway(_tenant_id uuid, _application_id uuid, _approve boolean, _reason text)
 RETURNS restaurant_discount_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _app public.restaurant_discount_applications; _roles text[]; _admin boolean; BEGIN _admin:=public.restaurant_is_platform_admin(auth.uid()); SELECT COALESCE(ARRAY_AGG(m.role::text),'{}') INTO _roles FROM public.restaurant_members m WHERE m.tenant_id=_tenant_id AND m.user_id=auth.uid(); IF NOT (_admin OR _roles && ARRAY['owner','general_manager','accountant']) THEN RAISE EXCEPTION 'Forbidden — approving an escalated discount requires owner, general manager or accountant authority.' USING ERRCODE='42501'; END IF; SELECT * INTO _app FROM public.restaurant_discount_applications WHERE id=_application_id AND tenant_id=_tenant_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Giveaway not found in this tenant.' USING ERRCODE='22023'; END IF; IF _app.status<>'pending' THEN RETURN _app; END IF; IF _app.actor_id=auth.uid() THEN RAISE EXCEPTION 'A discount may not be approved by the person who requested it.' USING ERRCODE='42501'; END IF; IF _approve THEN UPDATE public.restaurant_discount_applications SET status='approved',approved_by=auth.uid(),approved_at=now(),decision_reason=NULLIF(BTRIM(_reason),'') ,updated_at=now() WHERE id=_app.id RETURNING * INTO _app; PERFORM public.restaurant_apply_giveaway(_app.id); ELSE IF COALESCE(BTRIM(_reason),'')='' THEN RAISE EXCEPTION 'Rejecting a discount requires a reason.' USING ERRCODE='22023'; END IF; UPDATE public.restaurant_discount_applications SET status='rejected',rejected_by=auth.uid(),rejected_at=now(),decision_reason=BTRIM(_reason),updated_at=now() WHERE id=_app.id RETURNING * INTO _app; END IF; SELECT * INTO _app FROM public.restaurant_discount_applications WHERE id=_app.id; RETURN _app; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_giveaway_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _token text; _ok boolean; _loc uuid; _opened date; BEGIN IF TG_OP='INSERT' THEN IF COALESCE(NEW.discount,0)<>0 OR COALESCE(NEW.is_comp,false) THEN RAISE EXCEPTION 'A discount or comp must be granted through the authorised giveaway path, not written onto a sales line.' USING ERRCODE='55007'; END IF; RETURN NEW; END IF; IF NEW.discount IS DISTINCT FROM OLD.discount OR NEW.is_comp IS DISTINCT FROM OLD.is_comp OR NEW.comp_reason IS DISTINCT FROM OLD.comp_reason OR NEW.comp_by IS DISTINCT FROM OLD.comp_by OR NEW.comp_at IS DISTINCT FROM OLD.comp_at OR NEW.discount_rule_id IS DISTINCT FROM OLD.discount_rule_id OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason THEN _token:=NULLIF(current_setting('nova.giveaway_application',true),''); IF _token IS NULL THEN RAISE EXCEPTION 'A discount or comp must be granted through the authorised giveaway path, not written onto a sales line.' USING ERRCODE='55007'; END IF; SELECT true INTO _ok FROM public.restaurant_discount_applications a WHERE a.id=_token::uuid AND a.tenant_id=NEW.tenant_id AND a.status='approved' AND (a.order_item_id IS NULL OR a.order_item_id=NEW.id) AND a.order_id=NEW.order_id; IF NOT COALESCE(_ok,false) THEN RAISE EXCEPTION 'That giveaway is not an approved grant for this sales line.' USING ERRCODE='55007'; END IF; SELECT o.location_id,(o.created_at)::date INTO _loc,_opened FROM public.restaurant_orders o WHERE o.id=NEW.order_id AND o.tenant_id=NEW.tenant_id; IF public.restaurant_day_is_locked(NEW.tenant_id,_loc,_opened) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before discounting or comping a bill on it.' USING ERRCODE='55006'; END IF; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_giveaway_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN RAISE EXCEPTION 'Giveaway evidence is append-only — reverse the grant instead of deleting it.' USING ERRCODE='55008'; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_giveaway_period_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _loc uuid; _opened date; BEGIN SELECT o.location_id,(o.created_at)::date INTO _loc,_opened FROM public.restaurant_orders o WHERE o.id=NEW.order_id AND o.tenant_id=NEW.tenant_id; IF public.restaurant_day_is_locked(NEW.tenant_id,_loc,_opened) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before discounting or comping a bill on it.' USING ERRCODE='55006'; END IF; RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_request_giveaway(_tenant_id uuid, _order_id uuid, _order_item_id uuid, _kind text, _rule_id uuid, _basis text, _value numeric, _reason text, _request_key text)
 RETURNS restaurant_discount_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _existing public.restaurant_discount_applications; _app public.restaurant_discount_applications; _order record; _item record; _rule public.restaurant_discount_rules; _roles text[]; _admin boolean; _base numeric(14,4); _amount numeric(14,4); _percent numeric(9,4); _role_ceiling numeric(9,4); _status text; BEGIN IF _kind IS NULL OR _kind NOT IN ('discount','comp') THEN RAISE EXCEPTION 'Unknown giveaway kind "%".',_kind USING ERRCODE='22023'; END IF; _admin:=public.restaurant_is_platform_admin(auth.uid()); SELECT COALESCE(ARRAY_AGG(m.role::text),'{}') INTO _roles FROM public.restaurant_members m WHERE m.tenant_id=_tenant_id AND m.user_id=auth.uid(); IF NOT (_admin OR _roles && ARRAY['owner','general_manager','restaurant_manager']) THEN RAISE EXCEPTION 'Forbidden — granting a discount or comp requires owner, general manager or restaurant manager authority.' USING ERRCODE='42501'; END IF; IF _request_key IS NOT NULL THEN SELECT * INTO _existing FROM public.restaurant_discount_applications WHERE tenant_id=_tenant_id AND request_key=_request_key; IF FOUND THEN RETURN _existing; END IF; END IF; SELECT o.id,o.status,o.currency,o.location_id,o.property_id,o.created_at INTO _order FROM public.restaurant_orders o WHERE o.id=_order_id AND o.tenant_id=_tenant_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Order not found in this tenant.' USING ERRCODE='22023'; END IF; IF _order.status::text IN ('closed','cancelled','voided') THEN RAISE EXCEPTION 'A settled bill can no longer be discounted or comped — its value is final.' USING ERRCODE='55007'; END IF; IF public.restaurant_day_is_locked(_tenant_id,_order.location_id,(_order.created_at)::date) THEN RAISE EXCEPTION 'That business day is closed. Reopen the day before discounting or comping a bill on it.' USING ERRCODE='55006'; END IF; IF _order_item_id IS NOT NULL THEN SELECT i.id,i.quantity,i.unit_price,i.status,i.is_comp INTO _item FROM public.restaurant_order_items i WHERE i.id=_order_item_id AND i.tenant_id=_tenant_id AND i.order_id=_order_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Sales line not found on this bill.' USING ERRCODE='22023'; END IF; IF _item.status::text='voided' THEN RAISE EXCEPTION 'A voided line cannot be discounted or comped.' USING ERRCODE='55007'; END IF; _base:=ROUND(_item.quantity*_item.unit_price,2); ELSE IF _kind='comp' THEN RAISE EXCEPTION 'A comp is granted on a single sales line, never on a whole bill.' USING ERRCODE='22023'; END IF; SELECT ROUND(COALESCE(SUM(i.quantity*i.unit_price),0),2) INTO _base FROM public.restaurant_order_items i WHERE i.tenant_id=_tenant_id AND i.order_id=_order_id AND i.status<>'voided'; END IF; IF COALESCE(_base,0)<=0 THEN RAISE EXCEPTION 'There is no chargeable value to give away here.' USING ERRCODE='22023'; END IF; IF _kind='comp' THEN IF COALESCE(_item.is_comp,false) THEN RAISE EXCEPTION 'That line is already comped.' USING ERRCODE='55007'; END IF; IF COALESCE(BTRIM(_reason),'')='' THEN RAISE EXCEPTION 'A comp always requires a reason.' USING ERRCODE='22023'; END IF; _amount:=_base; _percent:=100; ELSE IF _rule_id IS NULL THEN RAISE EXCEPTION 'A discount must cite a configured discount rule.' USING ERRCODE='42501'; END IF; SELECT * INTO _rule FROM public.restaurant_discount_rules WHERE id=_rule_id AND tenant_id=_tenant_id; IF NOT FOUND THEN RAISE EXCEPTION 'Discount rule not found in this tenant.' USING ERRCODE='22023'; END IF; IF NOT _rule.active OR _rule.effective_from>now() OR (_rule.effective_to IS NOT NULL AND _rule.effective_to<now()) THEN RAISE EXCEPTION 'Discount rule "%" is not in force.',_rule.code USING ERRCODE='55007'; END IF; IF COALESCE(_basis,'percent')='percent' THEN _percent:=_value; _amount:=ROUND(_base*(_value/100.0),2); ELSE _amount:=ROUND(_value,2); _percent:=ROUND((_amount/_base)*100.0,4); END IF; IF _rule.requires_reason AND COALESCE(BTRIM(_reason),'')='' THEN RAISE EXCEPTION 'A reason is required for this discount.' USING ERRCODE='22023'; END IF; SELECT MAX((_rule.role_limits ->> t.role)::numeric) INTO _role_ceiling FROM UNNEST(_roles) AS t(role) WHERE _rule.role_limits ? t.role; _role_ceiling:=LEAST(_rule.max_percent,COALESCE(_role_ceiling,_rule.max_percent)); IF NOT _admin AND _percent>_role_ceiling THEN RAISE EXCEPTION 'Your role may grant up to % percent under rule "%".',_role_ceiling,_rule.code USING ERRCODE='42501'; END IF; END IF; _status:='approved'; IF _kind='discount' AND _rule.approval_threshold_percent IS NOT NULL AND _percent>_rule.approval_threshold_percent THEN _status:='pending'; END IF; INSERT INTO public.restaurant_discount_applications(tenant_id,discount_rule_id,order_id,order_item_id,scope,basis,value,amount,percent,currency,reason,actor_id,actor_role,kind,status,request_key,approved_by,approved_at) VALUES(_tenant_id,_rule.id,_order_id,_order_item_id,(CASE WHEN _order_item_id IS NULL THEN 'order' ELSE 'product' END)::public.restaurant_discount_scope,(CASE WHEN _kind='comp' THEN 'fixed' ELSE COALESCE(_basis,'percent') END)::public.restaurant_charge_basis,CASE WHEN _kind='comp' THEN _base ELSE _value END,_amount,_percent,COALESCE(_order.currency,'TZS'),NULLIF(BTRIM(_reason),''),auth.uid(),COALESCE(_roles[1],CASE WHEN _admin THEN 'platform_admin' END),_kind,_status,_request_key,CASE WHEN _status='approved' THEN auth.uid() END,CASE WHEN _status='approved' THEN now() END) RETURNING * INTO _app; IF _status='approved' THEN PERFORM public.restaurant_apply_giveaway(_app.id); SELECT * INTO _app FROM public.restaurant_discount_applications WHERE id=_app.id; END IF; RETURN _app; END; $function$;

CREATE OR REPLACE FUNCTION public.restaurant_reverse_giveaway(_tenant_id uuid, _application_id uuid, _reason text, _request_key text)
 RETURNS restaurant_discount_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE _src public.restaurant_discount_applications; _existing public.restaurant_discount_applications; _rev public.restaurant_discount_applications; _roles text[]; _admin boolean; BEGIN _admin:=public.restaurant_is_platform_admin(auth.uid()); SELECT COALESCE(ARRAY_AGG(m.role::text),'{}') INTO _roles FROM public.restaurant_members m WHERE m.tenant_id=_tenant_id AND m.user_id=auth.uid(); IF NOT (_admin OR _roles && ARRAY['owner','general_manager','restaurant_manager']) THEN RAISE EXCEPTION 'Forbidden — reversing a discount or comp requires owner, general manager or restaurant manager authority.' USING ERRCODE='42501'; END IF; IF _request_key IS NOT NULL THEN SELECT * INTO _existing FROM public.restaurant_discount_applications WHERE tenant_id=_tenant_id AND request_key=_request_key; IF FOUND THEN RETURN _existing; END IF; END IF; SELECT * INTO _src FROM public.restaurant_discount_applications WHERE id=_application_id AND tenant_id=_tenant_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Giveaway not found in this tenant.' USING ERRCODE='22023'; END IF; IF _src.status<>'approved' OR _src.applied_at IS NULL THEN RAISE EXCEPTION 'Only a granted, applied giveaway can be reversed.' USING ERRCODE='55007'; END IF; IF EXISTS(SELECT 1 FROM public.restaurant_discount_applications WHERE reverses_id=_src.id AND status='approved') THEN RAISE EXCEPTION 'That giveaway has already been reversed.' USING ERRCODE='55007'; END IF; IF COALESCE(BTRIM(_reason),'')='' THEN RAISE EXCEPTION 'Reversing a giveaway requires a reason.' USING ERRCODE='22023'; END IF; INSERT INTO public.restaurant_discount_applications(tenant_id,discount_rule_id,order_id,order_item_id,scope,basis,value,amount,percent,currency,reason,actor_id,actor_role,kind,status,request_key,reverses_id,approved_by,approved_at) VALUES(_src.tenant_id,_src.discount_rule_id,_src.order_id,_src.order_item_id,_src.scope,_src.basis,-_src.value,-_src.amount,-_src.percent,_src.currency,BTRIM(_reason),auth.uid(),COALESCE(_roles[1],CASE WHEN _admin THEN 'platform_admin' END),_src.kind,'approved',_request_key,_src.id,auth.uid(),now()) RETURNING * INTO _rev; PERFORM public.restaurant_apply_giveaway(_rev.id); SELECT * INTO _rev FROM public.restaurant_discount_applications WHERE id=_rev.id; RETURN _rev; END; $function$;

-- ---------------------------------------------------------------------
-- 4. Triggers (verbatim pg_get_triggerdef, captured 2026-09-15)
-- ---------------------------------------------------------------------

DROP TRIGGER IF EXISTS restaurant_cash_payout_events_immutable ON public.restaurant_cash_payout_events;
CREATE TRIGGER restaurant_cash_payout_events_immutable BEFORE DELETE OR UPDATE ON public.restaurant_cash_payout_events FOR EACH ROW EXECUTE FUNCTION restaurant_cash_payout_events_immutable();

DROP TRIGGER IF EXISTS restaurant_cash_payout_control ON public.restaurant_cash_payouts;
CREATE TRIGGER restaurant_cash_payout_control BEFORE INSERT OR UPDATE ON public.restaurant_cash_payouts FOR EACH ROW EXECUTE FUNCTION restaurant_cash_payout_control();

DROP TRIGGER IF EXISTS restaurant_cash_payout_no_delete ON public.restaurant_cash_payouts;
CREATE TRIGGER restaurant_cash_payout_no_delete BEFORE DELETE ON public.restaurant_cash_payouts FOR EACH ROW EXECUTE FUNCTION restaurant_cash_payout_no_delete();

DROP TRIGGER IF EXISTS restaurant_cash_payout_trail ON public.restaurant_cash_payouts;
CREATE TRIGGER restaurant_cash_payout_trail AFTER INSERT OR UPDATE ON public.restaurant_cash_payouts FOR EACH ROW EXECUTE FUNCTION restaurant_cash_payout_trail();

DROP TRIGGER IF EXISTS restaurant_daily_close_control ON public.restaurant_daily_closes;
CREATE TRIGGER restaurant_daily_close_control BEFORE UPDATE ON public.restaurant_daily_closes FOR EACH ROW EXECUTE FUNCTION restaurant_daily_close_control();

DROP TRIGGER IF EXISTS restaurant_daily_close_payout_sync ON public.restaurant_daily_closes;
CREATE TRIGGER restaurant_daily_close_payout_sync BEFORE INSERT OR UPDATE ON public.restaurant_daily_closes FOR EACH ROW EXECUTE FUNCTION restaurant_daily_close_payout_sync();

DROP TRIGGER IF EXISTS restaurant_declaration_revisions_immutable ON public.restaurant_declaration_revisions;
CREATE TRIGGER restaurant_declaration_revisions_immutable BEFORE DELETE OR UPDATE ON public.restaurant_declaration_revisions FOR EACH ROW EXECUTE FUNCTION restaurant_declaration_revisions_immutable();

DROP TRIGGER IF EXISTS restaurant_giveaway_no_delete ON public.restaurant_discount_applications;
CREATE TRIGGER restaurant_giveaway_no_delete BEFORE DELETE ON public.restaurant_discount_applications FOR EACH ROW EXECUTE FUNCTION restaurant_giveaway_no_delete();

DROP TRIGGER IF EXISTS restaurant_giveaway_period_lock ON public.restaurant_discount_applications;
CREATE TRIGGER restaurant_giveaway_period_lock BEFORE INSERT OR UPDATE ON public.restaurant_discount_applications FOR EACH ROW EXECUTE FUNCTION restaurant_giveaway_period_lock();

DROP TRIGGER IF EXISTS restaurant_giveaway_guard ON public.restaurant_order_items;
CREATE TRIGGER restaurant_giveaway_guard BEFORE INSERT OR UPDATE ON public.restaurant_order_items FOR EACH ROW EXECUTE FUNCTION restaurant_giveaway_guard();

DROP TRIGGER IF EXISTS restaurant_tender_declaration_archive ON public.restaurant_tender_declarations;
CREATE TRIGGER restaurant_tender_declaration_archive AFTER UPDATE ON public.restaurant_tender_declarations FOR EACH ROW EXECUTE FUNCTION restaurant_tender_declaration_archive();

DROP TRIGGER IF EXISTS restaurant_tender_declaration_control ON public.restaurant_tender_declarations;
CREATE TRIGGER restaurant_tender_declaration_control BEFORE INSERT OR UPDATE ON public.restaurant_tender_declarations FOR EACH ROW EXECUTE FUNCTION restaurant_tender_declaration_control();

-- ---------------------------------------------------------------------
-- 5. Grants — exact live state (captured via has_function_privilege,
--    2026-09-15): PUBLIC/anon revoked on all 18; authenticated re-granted
--    only on the two read-only, argument-checked lookups; service_role
--    (the server-side path these are actually invoked through) keeps
--    EXECUTE on everything. Matches migration 0048's own stated policy of
--    revoking PUBLIC by default and re-granting only what a real caller
--    needs.
-- ---------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.restaurant_day_is_locked(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_day_is_locked(uuid, uuid, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_total(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_total(uuid, uuid, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.restaurant_expected_tender(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_expected_tender(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.restaurant_apply_giveaway(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_apply_giveaway(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_decide_giveaway(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_decide_giveaway(uuid, uuid, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_control() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_control() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_events_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_events_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_no_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_no_delete() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_trail() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_trail() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_daily_close_control() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_daily_close_control() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_daily_close_payout_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_daily_close_payout_sync() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_declaration_revisions_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_declaration_revisions_immutable() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_giveaway_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_giveaway_guard() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_giveaway_no_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_giveaway_no_delete() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_giveaway_period_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_giveaway_period_lock() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_tender_declaration_archive() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_tender_declaration_archive() TO service_role;

REVOKE ALL ON FUNCTION public.restaurant_tender_declaration_control() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_tender_declaration_control() TO service_role;
