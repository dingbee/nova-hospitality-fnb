-- Commercial capability registry reconciliation — v2 correction.
--
-- 0088_commercial_capability_activation_reconciliation.sql joins
-- commercial_capabilities to the UPDATE target (commercial_plan_entitlements
-- pe) inside a JOIN ... ON clause. PostgreSQL rejects that: the UPDATE
-- target cannot be referenced from a JOIN condition in its own FROM list
-- ("invalid reference to FROM-clause entry for table "pe""), so 0088 has
-- never actually applied anywhere it was run against a real PostgreSQL
-- server — every environment that ran it rolled the migration back.
--
-- This is a forward migration, not an edit of 0088: 0088 is left as-authored
-- (never modify historical migrations) and installations that recorded it
-- as skipped/failed are unaffected; this migration is what actually performs
-- the reconciliation, using a comma-joined FROM list so the WHERE clause
-- can reference the UPDATE target. Already applied to the hosted project as
-- commercial_capability_activation_reconciliation_v2 (20260919130013).

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
