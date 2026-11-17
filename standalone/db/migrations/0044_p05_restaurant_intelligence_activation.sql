-- P05 — Restaurant Intelligence / Pro Intelligence Completion.
--
-- Activates the 6 primary + 1 secondary P05 capabilities that were seeded
-- coming_soon by migration 0034. Every code below now has a genuine,
-- tested, live-validated implementation (demand.server.ts, forecasting.server.ts,
-- revenue.server.ts, advancedAnalytics.server.ts, executive.server.ts,
-- multiLocation.server.ts, inventoryPro.server.ts) gated by
-- assertEntitled(..., "<code>", ...) inside each server function — this
-- migration only flips the commercial policy rows; it changes zero
-- application code.
--
-- Entitlement design: Core gets NO access to any of these seven codes
-- (state 'unavailable') — deliberately not mirroring menu_intelligence's
-- core=limited pattern, per the master prompt's explicit "do not dilute
-- Pro into Core + more reports" instruction. Pro gets 'advanced' (full
-- access to the capability as built). Enterprise gets 'enterprise'
-- (inherits Pro's access; no additional P05 behavior is gated further by
-- an Enterprise-only tier in this phase — P05 does not introduce new
-- pricing or a new subscription model).
--
-- 'active' capability status + a real entitlement state is what actually
-- unlocks the capability for a plan: capability status alone does not
-- grant access (see resolver.server.ts's resolveEntitlement), so both are
-- updated together here.

update public.commercial_capabilities
set status = 'active'
where code in (
  'inventory_intelligence',
  'demand_intelligence',
  'forecasting',
  'revenue_intelligence',
  'advanced_analytics',
  'executive_intelligence',
  'multi_location_command'
);

update public.commercial_plan_entitlements e
set state = case p.code
  when 'core' then 'unavailable'
  when 'pro' then 'advanced'
  when 'enterprise' then 'enterprise'
  else e.state
end
from public.commercial_capabilities c, public.commercial_plans p
where e.capability_id = c.id
  and e.plan_id = p.id
  and c.code in (
    'inventory_intelligence',
    'demand_intelligence',
    'forecasting',
    'revenue_intelligence',
    'advanced_analytics',
    'executive_intelligence',
    'multi_location_command'
  );
