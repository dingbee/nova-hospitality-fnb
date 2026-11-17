-- P1 FINAL CLOSURE (2/2) — Reconciliation domain property-scoped RLS.
--
-- Disclosed gap from the P1 report: five reconciliation-domain tables
-- remained tenant-only at the DB layer (restaurant_daily_closes,
-- restaurant_tender_declarations, restaurant_reconciliation_runs,
-- restaurant_reconciliation_exceptions, restaurant_reconciliation_audit).
-- reconciliation.server.ts already scopes its write paths at the
-- application layer (openDailyClose/declareTenders/runReconciliation/
-- closeDay/reopenDay/resolveException all call assertCapability with a
-- locationId derived from the resource itself) — that is real, but it is
-- not the enforcement boundary; a direct read/write against these tables
-- was still tenant-wide regardless of the caller's property grant.
--
-- Property attribution, per table (verified against 0001_fnb_core.sql):
--   restaurant_daily_closes         — HAS property_id AND location_id, but
--                                      openDailyClose (reconciliation.server.ts)
--                                      only ever writes location_id — property_id
--                                      is always NULL in practice today.
--   restaurant_reconciliation_exceptions — same shape, same gap: persistExceptions
--                                      only ever writes location_id.
--   restaurant_reconciliation_runs  — location_id only, no property_id column.
--   restaurant_tender_declarations  — NEITHER column: scope is entirely
--                                      derived from its parent close_id.
--   restaurant_reconciliation_audit — NEITHER column, and no typed FK either
--                                      (subject_type/subject_id is a
--                                      polymorphic reference into whichever
--                                      of the three tables above the entry
--                                      is about).
-- Every derivation below therefore uses
-- COALESCE(property_id, restaurant_location_property(location_id)) where a
-- property_id column exists, and restaurant_location_property(location_id)
-- alone where it doesn't — the safest derivation actually supported by
-- what these records really carry, per the sprint's explicit "do not
-- fabricate property assignments" mandate.
--
-- Read semantics reuse restaurant_can_read_scoped_strict (0032): financial
-- reconciliation data carries the same "never let a property-scoped user
-- receive ambiguous cross-property data" requirement as Intelligence Core,
-- and a legacy/unattributable record (property attribution genuinely
-- unresolvable — e.g. an audit entry whose subject_type predates this
-- migration) must be preserved but excluded from property-scoped access,
-- never guessed at. A tenant-wide grant retains full access either way.
-- Write semantics reuse restaurant_can_write_scoped (0027, already the
-- established pattern) with each table's EXISTING role list, unchanged —
-- this migration only adds property consistency on top of roles already
-- required today.

-- ---------- derivation helpers ----------

CREATE OR REPLACE FUNCTION public.restaurant_daily_close_property(_close_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(property_id, public.restaurant_location_property(location_id))
  FROM public.restaurant_daily_closes WHERE id = _close_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_reconciliation_run_property(_run_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.restaurant_location_property(location_id)
  FROM public.restaurant_reconciliation_runs WHERE id = _run_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_reconciliation_exception_property(_exception_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(property_id, public.restaurant_location_property(location_id))
  FROM public.restaurant_reconciliation_exceptions WHERE id = _exception_id;
$$;

-- The audit trail's subject is polymorphic (subject_type names which of the
-- three tables above subject_id refers to). An unrecognized subject_type —
-- including any future one this migration doesn't know about — resolves to
-- NULL, i.e. "attribution genuinely unresolvable", which
-- restaurant_can_read_scoped_strict then correctly restricts to tenant-wide
-- grants only. Never a guess, never a fabricated property.
CREATE OR REPLACE FUNCTION public.restaurant_reconciliation_audit_property(_subject_type text, _subject_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE _subject_type
    WHEN 'daily_close' THEN public.restaurant_daily_close_property(_subject_id)
    WHEN 'reconciliation_run' THEN public.restaurant_reconciliation_run_property(_subject_id)
    WHEN 'reconciliation_exception' THEN public.restaurant_reconciliation_exception_property(_subject_id)
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_daily_close_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_daily_close_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_reconciliation_run_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_reconciliation_run_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_reconciliation_exception_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_reconciliation_exception_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_reconciliation_audit_property(text, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_reconciliation_audit_property(text, uuid) TO authenticated, service_role;

-- ---------- restaurant_daily_closes ----------

DROP POLICY IF EXISTS "daily closes read" ON public.restaurant_daily_closes;
CREATE POLICY "daily closes read scoped" ON public.restaurant_daily_closes FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

DROP POLICY IF EXISTS "daily closes write" ON public.restaurant_daily_closes;
CREATE POLICY "daily closes write scoped" ON public.restaurant_daily_closes FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

-- ---------- restaurant_tender_declarations (scope via parent close) ----------

DROP POLICY IF EXISTS "tender declarations read" ON public.restaurant_tender_declarations;
CREATE POLICY "tender declarations read scoped" ON public.restaurant_tender_declarations FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(tenant_id, public.restaurant_daily_close_property(close_id)));

DROP POLICY IF EXISTS "tender declarations write" ON public.restaurant_tender_declarations;
CREATE POLICY "tender declarations write scoped" ON public.restaurant_tender_declarations FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],
    public.restaurant_daily_close_property(close_id)
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],
    public.restaurant_daily_close_property(close_id)
  ));

-- ---------- restaurant_reconciliation_runs ----------

DROP POLICY IF EXISTS "reconciliation runs read" ON public.restaurant_reconciliation_runs;
CREATE POLICY "reconciliation runs read scoped" ON public.restaurant_reconciliation_runs FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(tenant_id, public.restaurant_location_property(location_id)));

DROP POLICY IF EXISTS "reconciliation runs write" ON public.restaurant_reconciliation_runs;
CREATE POLICY "reconciliation runs write scoped" ON public.restaurant_reconciliation_runs FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager']::restaurant_role[],
    public.restaurant_location_property(location_id)
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager']::restaurant_role[],
    public.restaurant_location_property(location_id)
  ));

-- ---------- restaurant_reconciliation_exceptions ----------

DROP POLICY IF EXISTS "reconciliation exceptions read" ON public.restaurant_reconciliation_exceptions;
CREATE POLICY "reconciliation exceptions read scoped" ON public.restaurant_reconciliation_exceptions FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(
    tenant_id, COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

DROP POLICY IF EXISTS "reconciliation exceptions write" ON public.restaurant_reconciliation_exceptions;
CREATE POLICY "reconciliation exceptions write scoped" ON public.restaurant_reconciliation_exceptions FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager','purchasing_officer']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ))
  WITH CHECK (public.restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager','purchasing_officer']::restaurant_role[],
    COALESCE(property_id, public.restaurant_location_property(location_id))
  ));

-- ---------- restaurant_reconciliation_audit ----------

DROP POLICY IF EXISTS "reconciliation audit read" ON public.restaurant_reconciliation_audit;
CREATE POLICY "reconciliation audit read scoped" ON public.restaurant_reconciliation_audit FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped_strict(
    tenant_id, public.restaurant_reconciliation_audit_property(subject_type, subject_id)
  ));

-- Append keeps its original, deliberately low bar (any tenant member — the
-- audit() helper in reconciliation.server.ts writes on behalf of whichever
-- role a given control action already required; the row itself carries no
-- role of its own to check) plus the same LOOSE property consistency
-- intelligence_events' insert uses: a property-scoped member may append an
-- entry about their own property (or an unresolvable one); a tenant-wide
-- member, any of them.
DROP POLICY IF EXISTS "reconciliation audit append" ON public.restaurant_reconciliation_audit;
CREATE POLICY "reconciliation audit append scoped" ON public.restaurant_reconciliation_audit FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_read_scoped(
    tenant_id, public.restaurant_reconciliation_audit_property(subject_type, subject_id)
  ));
