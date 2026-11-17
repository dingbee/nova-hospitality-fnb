-- P1 FINAL CLOSURE (1/2) — Intelligence Core property-scoped RLS.
--
-- Disclosed gap from the P1 report: intelligence_decisions, intelligence_events
-- and intelligence_plans remained tenant-only at the DB layer even after P1
-- scoped the Decisions Board's own queries at the application layer — a
-- direct read against these tables (any path that isn't
-- getRestaurantDecisionBoard's own filtered query) still saw every
-- property's data. Application-layer filtering is not the enforcement
-- boundary; RLS is.
--
-- Property attribution:
--   intelligence_decisions and intelligence_events both carry their own
--   property_id AND location_id columns (0010, 0011) — decisions.server.ts
--   and actions.server.ts already populate them at write time. Effective
--   property = COALESCE(property_id, restaurant_location_property(location_id))
--   so a row written with only a location still scopes correctly.
--   intelligence_plans carries neither column: its scope is entirely
--   defined by its owning decision (decision_id, NOT NULL, cascades), so
--   its policies join back to intelligence_decisions for the same
--   COALESCE expression.
--
-- NULL handling — deliberately NOT the loose restaurant_can_read_scoped
-- convention (where a NULL-property resource is readable by any tenant
-- member). A NULL property_id/location_id on a decision or event can mean
-- either "genuinely tenant-wide by design" (a cross-property staffing or
-- menu recommendation) or "attribution was never established" — the two
-- are indistinguishable in the schema, and this sprint's mandate is
-- explicit: never let a property-scoped user receive ambiguous
-- cross-property intelligence, and never fabricate a property assignment
-- to resolve the ambiguity. So this migration adds a new, stricter sibling
-- function, restaurant_can_read_scoped_strict: a NULL effective property is
-- visible ONLY to a caller holding a genuine tenant-wide grant (a
-- restaurant_members row with property_id IS NULL) — never to a
-- property-scoped-only caller, however many properties they hold. A
-- tenant-wide owner/GM's existing access is completely unaffected either
-- way. restaurant_can_read_scoped itself is untouched (still used
-- elsewhere) and this migration does not alter it.
--
-- Writes keep the existing, already-established (and looser) pattern:
-- restaurant_can_write_scoped (0027) already treats a NULL target property
-- as "any caller holding one of the required roles may write it" — that is
-- a decision about who may CREATE a tenant-wide record, a different
-- question from who may READ an already-ambiguous one, and this sprint's
-- mandate is specifically about read exposure. intelligence_decisions/
-- plans keep their existing elevated role gate
-- (restaurant_can_manage_intelligence's role list, unchanged) plus the new
-- property check. intelligence_events keeps its original, deliberately low
-- bar (0010: "not an elevated role... every staff member's normal job") —
-- restaurant_can_read_scoped (loose, no role requirement) now adds property
-- consistency on top of that same bar, nothing more.

CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped_strict(_tenant_id uuid, _property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
        AND (
          -- The resource has a property: a matching property-scoped grant,
          -- or any tenant-wide grant, covers it.
          (_property_id IS NOT NULL AND (m.property_id IS NULL OR m.property_id = _property_id))
          -- The resource has NO property (ambiguous or deliberately
          -- tenant-wide): only a genuine tenant-wide grant covers it.
          OR (_property_id IS NULL AND m.property_id IS NULL)
        )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.restaurant_can_read_scoped_strict(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_read_scoped_strict(uuid, uuid) TO authenticated, service_role;

-- ---------- intelligence_decisions ----------

DROP POLICY IF EXISTS "intelligence decisions readable by tenant" ON public.intelligence_decisions;
CREATE POLICY "intelligence decisions readable by tenant and property" ON public.intelligence_decisions
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

DROP POLICY IF EXISTS "intelligence decisions writable by tenant" ON public.intelligence_decisions;
CREATE POLICY "intelligence decisions writable by tenant and property" ON public.intelligence_decisions
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

DROP POLICY IF EXISTS "intelligence decisions updatable by tenant" ON public.intelligence_decisions;
CREATE POLICY "intelligence decisions updatable by tenant and property" ON public.intelligence_decisions
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

-- ---------- intelligence_events ----------

DROP POLICY IF EXISTS "intelligence events readable by tenant" ON public.intelligence_events;
CREATE POLICY "intelligence events readable by tenant and property" ON public.intelligence_events
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

-- Insert keeps its original, deliberately low bar (any tenant member, no
-- elevated role — 0010) and now additionally requires property consistency
-- via the existing LOOSE restaurant_can_read_scoped: a caller may emit an
-- event for their own property, or a tenant-wide caller for any property,
-- or anyone for a genuinely unattributed (NULL) event — the same
-- "ambiguous read" concern above does not apply to a caller creating their
-- own event about their own action.
DROP POLICY IF EXISTS "intelligence events insertable by tenant" ON public.intelligence_events;
CREATE POLICY "intelligence events insertable by tenant and property" ON public.intelligence_events
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_read_scoped(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

DROP POLICY IF EXISTS "intelligence events markable processed by tenant" ON public.intelligence_events;
CREATE POLICY "intelligence events markable processed by tenant and property" ON public.intelligence_events
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_read_scoped(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ))
  WITH CHECK (public.restaurant_can_read_scoped(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

-- ---------- intelligence_plans (scope entirely derived from the owning decision) ----------

DROP POLICY IF EXISTS "intelligence plans readable by tenant" ON public.intelligence_plans;
CREATE POLICY "intelligence plans readable by tenant and property" ON public.intelligence_plans
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.intelligence_decisions d
    WHERE d.id = decision_id
      AND public.restaurant_can_read_scoped_strict(
        d.tenant_id, COALESCE(d.property_id, public.restaurant_location_property(d.location_id))
      )
  ));

DROP POLICY IF EXISTS "intelligence plans writable by tenant" ON public.intelligence_plans;
CREATE POLICY "intelligence plans writable by tenant and property" ON public.intelligence_plans
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.intelligence_decisions d
    WHERE d.id = decision_id
      AND public.restaurant_can_write_scoped(
        d.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
        COALESCE(d.property_id, public.restaurant_location_property(d.location_id))
      )
  ));

DROP POLICY IF EXISTS "intelligence plans updatable by tenant" ON public.intelligence_plans;
CREATE POLICY "intelligence plans updatable by tenant and property" ON public.intelligence_plans
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.intelligence_decisions d
    WHERE d.id = decision_id
      AND public.restaurant_can_write_scoped(
        d.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
        COALESCE(d.property_id, public.restaurant_location_property(d.location_id))
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.intelligence_decisions d
    WHERE d.id = decision_id
      AND public.restaurant_can_write_scoped(
        d.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager','purchasing_officer','accountant']::restaurant_role[],
        COALESCE(d.property_id, public.restaurant_location_property(d.location_id))
      )
  ));

-- intelligence_plan_steps and intelligence_actions are OUT OF SCOPE for this
-- migration — the P1 report's disclosed gap named exactly three tables
-- (decisions, events, plans). Both remain tenant-only, unchanged, exactly
-- as before this migration.
