-- P1 CRITICAL FIX — restaurant_can_read_scoped tenant-isolation bypass.
--
-- Discovered during this P1 sprint's live database verification (not a bug
-- introduced by P1 — present since restaurant_can_read_scoped's original
-- definition in 0027_property_scope.sql, and silently inherited by every
-- policy built on it, including restaurant_can_read_transfer).
--
-- The original definition:
--   auth.uid() IS NOT NULL AND (
--     is_platform_admin OR _property_id IS NULL OR EXISTS(membership...)
--   )
-- placed "_property_id IS NULL" OUTSIDE the tenant-membership EXISTS check.
-- Any authenticated Supabase user — in ANY tenant, or none at all — could
-- therefore read a row whose derived property_id is NULL (any resource
-- never assigned to a specific property, which is the common/default case
-- for most existing data) regardless of tenant membership. This is a full
-- cross-tenant read for every unscoped resource on every table whose SELECT
-- policy composes restaurant_can_read_scoped, including restaurant_orders,
-- restaurant_payments, restaurant_purchase_orders, restaurant_locations,
-- restaurant_mobile_money_accounts/collections, and (via
-- restaurant_can_read_transfer) restaurant_stock_transfers.
--
-- Live-verified before and after this fix (see the P1 final report):
--   - a synthetic authenticated user with ZERO restaurant_members rows in
--     ANY tenant: restaurant_can_read_scoped(<real tenant>, NULL) was TRUE
--     before this fix, FALSE after.
--   - a real member of the tenant reading a NULL-property resource in
--     THEIR OWN tenant: TRUE before and after (unaffected — correct).
--   - that same real member reading a NULL-property resource in a
--     DIFFERENT tenant: FALSE before and after (unaffected — correct).
--
-- restaurant_can_write_scoped never had this bug — it already placed
-- "_property_id IS NULL" inside the EXISTS clause, correctly requiring
-- real tenant membership either way. This fix makes restaurant_can_read_
-- scoped match that already-correct pattern: additive only, no schema
-- change, and behaviourally identical for every previously-correct case.
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant_id uuid, _property_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
        AND (_property_id IS NULL OR m.property_id IS NULL OR m.property_id = _property_id)
    )
  );
$function$;
