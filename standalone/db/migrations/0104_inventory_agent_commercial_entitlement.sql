-- 0104 — Inventory Agent commercial entitlement.
--
-- Inventory Agent is a distinct Pro capability. It is not the same thing as
-- base Inventory or read-only Inventory Intelligence: the Agent orchestrates
-- governed recommendations/actions and therefore requires its own commercial
-- entitlement boundary.
--
-- Core      : unavailable
-- Pro       : advanced
-- Enterprise: enterprise

INSERT INTO public.commercial_capabilities
  (code, name, description, category, status, sort_order)
VALUES
  (
    'inventory_agent',
    'Inventory Agent',
    'LexiBite Inventory Agent for replenishment orchestration, governed actions and independent verification.',
    'intelligence',
    'active',
    215
  )
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  status = 'active',
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

INSERT INTO public.commercial_plan_entitlements
  (plan_id, capability_id, state)
SELECT
  p.id,
  c.id,
  CASE p.code
    WHEN 'core' THEN 'unavailable'
    WHEN 'pro' THEN 'advanced'
    WHEN 'enterprise' THEN 'enterprise'
  END
FROM public.commercial_plans p
CROSS JOIN public.commercial_capabilities c
WHERE c.code = 'inventory_agent'
ON CONFLICT (plan_id, capability_id, effective_from) DO UPDATE
SET state = EXCLUDED.state,
    updated_at = now();
