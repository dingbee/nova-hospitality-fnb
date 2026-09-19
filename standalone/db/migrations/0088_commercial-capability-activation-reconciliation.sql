-- Commercial capability registry reconciliation.
--
-- P08 and ME-11 completed the underlying implementation, but the commercial
-- catalogue must explicitly reflect that those capabilities are now live.
-- This migration is idempotent and repairs environments where the original
-- implementation migrations were deployed without their commercial state
-- being applied.

BEGIN;

-- P08: API Access + Advanced Integrations.
UPDATE public.commercial_capabilities
SET status = 'active', updated_at = now()
WHERE code IN ('api_access', 'advanced_integrations');

UPDATE public.commercial_plan_entitlements pe
SET state = CASE p.code
  WHEN 'core' THEN 'unavailable'
  WHEN 'pro' THEN 'limited'
  WHEN 'enterprise' THEN 'advanced'
  ELSE pe.state
END,
updated_at = now()
FROM public.commercial_plans p, public.commercial_capabilities c
WHERE pe.plan_id = p.id
  AND pe.capability_id = c.id
  AND c.code = 'api_access';

UPDATE public.commercial_plan_entitlements pe
SET state = CASE p.code
  WHEN 'enterprise' THEN 'advanced'
  ELSE 'unavailable'
END,
updated_at = now()
FROM public.commercial_plans p, public.commercial_capabilities c
WHERE pe.plan_id = p.id
  AND pe.capability_id = c.id
  AND c.code = 'advanced_integrations';

-- ME-11 / P09: Enterprise Governance.
-- Governance is an Enterprise capability; it is not a roadmap placeholder.
UPDATE public.commercial_capabilities
SET status = 'active', updated_at = now()
WHERE code = 'enterprise_governance';

UPDATE public.commercial_plan_entitlements pe
SET state = CASE p.code
  WHEN 'enterprise' THEN 'enterprise'
  ELSE 'unavailable'
END,
updated_at = now()
FROM public.commercial_plans p, public.commercial_capabilities c
WHERE pe.plan_id = p.id
  AND pe.capability_id = c.id
  AND c.code = 'enterprise_governance';

COMMIT;
