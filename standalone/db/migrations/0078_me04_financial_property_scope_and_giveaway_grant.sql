-- ME-04 financial integrity certification: two defects found and fixed
-- against live production (lusiqcmxfxhnehxmwihs), both proven by direct
-- inspection/reproduction before this migration was written.
--
-- ---------------------------------------------------------------------
-- DEFECT 1 — cross-property financial data leak (mandate section 13,
-- "tenant/property/outlet financial isolation ... mandatory certification
-- boundary").
--
-- Every other financial table with a property/outlet dimension
-- (restaurant_orders, restaurant_payments, restaurant_daily_closes,
-- restaurant_tender_declarations) was migrated to property-scoped RLS
-- (restaurant_can_read_scoped_strict / restaurant_can_write_scoped) by the
-- P1/P09/ME-01 property-scope sweeps (0027, 0032, 0033, 0072-0074).
--
-- Four financial tables were never brought into that sweep and still use
-- only the tenant-wide restaurant_can_read(tenant_id) /
-- restaurant_can_write(tenant_id, roles) checks, which do not consult
-- restaurant_members.property_id at all (confirmed by reading both
-- functions' bodies, 0001_fnb_core.sql lines 2947-2964):
--
--   - restaurant_cash_payouts / restaurant_cash_payout_events (0076): have
--     a property_id/location_id dimension (payouts) or one derivable via
--     their parent payout (events), but their RLS ignores it.
--   - restaurant_declaration_revisions (0076): scoped via close_id ->
--     restaurant_daily_closes, which itself is property-scoped, but the
--     revisions table's own RLS was not.
--   - restaurant_discount_applications (0001, giveaways/comps/discounts):
--     scoped via order_id -> restaurant_orders, which is property-scoped,
--     but this table's own RLS (unchanged since 0001) was not.
--
-- Net effect: a staff member whose restaurant_members grant is scoped to
-- one property (m.property_id set) can currently read cash-payout
-- requests/events, drawer-declaration revision history, and every
-- discount/comp/giveaway record for every OTHER property in the same
-- tenant, and (for cash payouts specifically, since restaurant_can_write
-- has the same gap) request/approve/pay out cash against a property they
-- have no grant for. Fixed by deriving each table's property the same way
-- its sibling tables already do, and switching to the scoped check
-- functions.
--
-- ---------------------------------------------------------------------
-- DEFECT 2 — the order-item-level discount/comp feature cannot succeed at
-- all in production (mandate section 10, "a 'free' item must not become an
-- invisible financial movement" / section 21, "if a financial-integrity
-- defect is found ... FIX IT").
--
-- Proven by a BEGIN...ROLLBACK reproduction against production (throwaway
-- tenant/order/order_item, rolled back, no data retained): a bare
-- UPDATE of restaurant_order_items.discount -- exactly what
-- pricing.server.ts's applyDiscount() does for a line-scoped discount --
-- is unconditionally rejected by the restaurant_giveaway_guard trigger
-- (0076) with "A discount or comp must be granted through the authorised
-- giveaway path, not written onto a sales line." (55007), because no
-- nova.giveaway_application token is set.
--
-- The only function that can set that token, restaurant_apply_giveaway,
-- plus its callers restaurant_request_giveaway/restaurant_decide_giveaway/
-- restaurant_reverse_giveaway, were granted EXECUTE to service_role only
-- (0048, then preserved as-is by 0076). 0048's own header comment
-- justifies this as "17 zero-argument (or action-only) trigger/control
-- functions ... with zero direct .rpc() callers" -- true for the 11 actual
-- trigger functions in this family, but restaurant_apply_giveaway,
-- restaurant_decide_giveaway, restaurant_request_giveaway and
-- restaurant_reverse_giveaway are not triggers at all: they are
-- multi-argument RPC entry points, and this repository's only
-- request-scoped Supabase client (src/integrations/supabase/auth-
-- middleware.ts) always forwards the calling user's own bearer JWT --
-- never a service-role key -- so revoking authenticated EXECUTE on them
-- made the entire family permanently uncallable by any real caller.
-- Combined with DEFECT 2's trigger, no code path -- old or new -- can
-- currently apply an order-item-level discount or comp.
--
-- Fix scoped narrowly to what's proven broken: grant authenticated
-- EXECUTE on restaurant_apply_giveaway only. It performs no independent
-- role/rule authorization of its own -- it applies whatever
-- restaurant_discount_applications row is handed to it, gated only on
-- that row already being status='approved' (enforced by the row's own
-- INSERT/UPDATE RLS, unchanged here) -- so granting it does not bypass
-- any authorization this pass can verify. restaurant_request_giveaway/
-- restaurant_decide_giveaway/restaurant_reverse_giveaway remain
-- service_role-only: they encode a materially different role model
-- (restaurant_members.role in a fixed owner/gm/manager list) than the
-- capability-based gate applyDiscount already uses
-- (assertCapability(..., "sales.manage")), reconciling the two is a
-- separate, larger authorization-design question outside this pass's
-- "smallest correct change" scope -- and per the application-code audit
-- this pass ran, nothing in the repository calls them, so leaving them
-- as-is changes no live behavior.

-- ---------------------------------------------------------------------
-- 1. Property-derivation helper for cash payouts (mirrors
--    restaurant_daily_close_property / restaurant_order_property).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_property(_payout_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(p.property_id, public.restaurant_location_property(p.location_id))
  FROM public.restaurant_cash_payouts p WHERE p.id = _payout_id;
$$;

REVOKE ALL ON FUNCTION public.restaurant_cash_payout_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_cash_payout_property(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. restaurant_cash_payouts: tenant-only -> property-scoped.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "cash payouts read" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts read scoped" ON public.restaurant_cash_payouts FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id)))
  );

DROP POLICY IF EXISTS "cash payouts write" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts write scoped" ON public.restaurant_cash_payouts FOR INSERT TO public
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

DROP POLICY IF EXISTS "cash payouts transition" ON public.restaurant_cash_payouts;
CREATE POLICY "cash payouts transition scoped" ON public.restaurant_cash_payouts FOR UPDATE TO public
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[], COALESCE(property_id, restaurant_location_property(location_id))));

-- ---------------------------------------------------------------------
-- 3. restaurant_cash_payout_events: tenant-only -> property-scoped (read
--    only -- inserts happen exclusively via the restaurant_cash_payout_trail
--    trigger, which runs as the SECURITY DEFINER owner and is unaffected
--    by RLS).
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "cash payout events read" ON public.restaurant_cash_payout_events;
CREATE POLICY "cash payout events read scoped" ON public.restaurant_cash_payout_events FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_cash_payout_property(payout_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','bartender']::restaurant_role[], restaurant_cash_payout_property(payout_id))
  );

-- ---------------------------------------------------------------------
-- 4. restaurant_declaration_revisions: tenant-only -> property-scoped via
--    the parent daily close (restaurant_daily_close_property already
--    exists, 0033).
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "declaration revisions read" ON public.restaurant_declaration_revisions;
CREATE POLICY "declaration revisions read scoped" ON public.restaurant_declaration_revisions FOR SELECT TO public
  USING (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_daily_close_property(close_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], restaurant_daily_close_property(close_id))
  );

DROP POLICY IF EXISTS "declaration revisions append" ON public.restaurant_declaration_revisions;
CREATE POLICY "declaration revisions append scoped" ON public.restaurant_declaration_revisions FOR INSERT TO public
  WITH CHECK (
    restaurant_can_read_scoped_strict(tenant_id, restaurant_daily_close_property(close_id))
    OR restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], restaurant_daily_close_property(close_id))
  );

-- ---------------------------------------------------------------------
-- 5. restaurant_discount_applications (giveaways/comps/discounts):
--    tenant-only -> property-scoped via the parent order
--    (restaurant_order_property already exists, 0027). order_id is
--    NOT NULL for every real row (both applyDiscount and
--    restaurant_request_giveaway always supply it), so no COALESCE
--    fallback is needed here.
-- ---------------------------------------------------------------------

-- Both policies preserve the original's exact permissiveness (any tenant
-- member may read/insert -- authorization for *who* may actually call
-- applyDiscount happens in the application layer via
-- assertCapability(..., "sales.manage"), unchanged by this migration) and
-- add only the missing property dimension, via restaurant_can_read_scoped_
-- strict, matching how every other scoped-but-role-agnostic financial
-- policy in this schema (e.g. cash payout events, declaration revisions)
-- is written. Introducing a new role list here would be an unproven,
-- unrelated tightening this pass has no evidence for.

DROP POLICY IF EXISTS "discount app read" ON public.restaurant_discount_applications;
CREATE POLICY "discount app read scoped" ON public.restaurant_discount_applications FOR SELECT TO authenticated
  USING (restaurant_can_read_scoped_strict(tenant_id, restaurant_order_property(order_id)));

DROP POLICY IF EXISTS "discount app insert" ON public.restaurant_discount_applications;
CREATE POLICY "discount app insert scoped" ON public.restaurant_discount_applications FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_read_scoped_strict(tenant_id, restaurant_order_property(order_id)));

-- ---------------------------------------------------------------------
-- 6. restaurant_apply_giveaway: authenticated EXECUTE (see DEFECT 2 above).
-- ---------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.restaurant_apply_giveaway(uuid) TO authenticated;
