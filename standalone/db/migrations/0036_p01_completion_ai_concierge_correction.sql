-- P01 COMPLETION PASS — registry correction: "ai_concierge" was seeded as
-- coming_soon in migration 0034, but this codebase already ships a real,
-- active, AI-provider-backed guest-facing concierge (guest "Ask NOVA" /
-- Ask LexiBite — src/modules/restaurant/selforder/selfnova.server.ts,
-- reachable unauthenticated from any table QR code, calling the same
-- callReasoningProvider() Menu Intelligence and Staff Ask LexiBite use).
-- A capability marked coming_soon can never resolve to an ENTITLED state
-- (resolveEntitlement forces every plan's entitlement to "coming_soon",
-- which assertEntitled never accepts) — so wiring real commercial
-- enforcement onto it as currently seeded would have switched the feature
-- off for every existing tenant, which is exactly the retroactive removal
-- migration 0034's own header explicitly rules out ("this migration
-- introduces commercial governance, it does not retroactively take away
-- anything a customer already has").
--
-- Fix: correct the registry to reflect reality (status -> active) and give
-- it the same "already works unconditionally today" baseline every other
-- pre-existing capability received in 0034 — included on every plan, no
-- new tiering business decision invented here. Enforcement (entitlement +
-- optional quota + usage recording) is then wired into askNova() exactly
-- like Menu Intelligence's runMenuIntelligenceReasoning() — see the
-- accompanying application-code change.

UPDATE public.commercial_capabilities
SET status = 'active'
WHERE code = 'ai_concierge';

-- 0034's own baseline INSERT already ran for every capability (including
-- ai_concierge, when it was still coming_soon), so plan_entitlement ROWS
-- already exist here with state='coming_soon' — this must UPDATE them,
-- not just insert new ones.
UPDATE public.commercial_plan_entitlements pe
SET state = 'included'
FROM public.commercial_capabilities c
WHERE pe.capability_id = c.id
  AND c.code = 'ai_concierge'
  AND pe.state = 'coming_soon';

-- Defensive fallback for an environment where no row exists at all for
-- this capability/plan pair (e.g. a plan created after 0034 ran). No
-- unique constraint exists on (plan_id, capability_id) — this table is
-- keyed by an independent surrogate id — so idempotency is enforced
-- explicitly with NOT EXISTS rather than ON CONFLICT.
INSERT INTO public.commercial_plan_entitlements (plan_id, capability_id, state)
SELECT p.id, c.id, 'included'
FROM public.commercial_plans p
CROSS JOIN public.commercial_capabilities c
WHERE c.code = 'ai_concierge'
  AND NOT EXISTS (
    SELECT 1 FROM public.commercial_plan_entitlements pe
    WHERE pe.plan_id = p.id AND pe.capability_id = c.id
  );
