-- P09 enterprise closure — Import Studio workspace-management authorization.
--
-- import.server.ts's workspace orchestration functions (createImportWorkspace,
-- uploadImportSource, parseImportSource, confirmImportMapping,
-- decideStagedRecord, bulkDecideStagedRecords, commitImportWorkspace) called
-- assertCapability(..., "import.manage") with no property scope, even though
-- restaurant_import_workspaces carries a real property_id/location_id the
-- caller controls. A property-scoped owner/general_manager/restaurant_manager
-- could drive an entire import workspace — upload a source, approve staged
-- rows, commit — against a SIBLING property's workspace, using only their own
-- property's grant. That application-layer gap is fixed in the same change
-- as this migration (each call site now resolves the workspace's own scope
-- before checking capability, the same lookup-then-scope pattern already used
-- for restaurant_menu_items/restaurant_recipe_components in 0061).
--
-- This migration closes the same gap at the RLS layer. The commitX writes
-- Import Studio itself performs (upsertInventoryItem, upsertMenu, etc.) are
-- already property-scoped via 0061/0062 — those are canonical tables. This
-- migration is specifically about the staging/orchestration tables Import
-- Studio owns: restaurant_import_workspaces (has property_id directly),
-- restaurant_import_sources (property derived via its parent workspace_id),
-- restaurant_import_field_mappings (property derived via source_id ->
-- workspace_id), and restaurant_import_staged_records (has workspace_id
-- directly, same as sources).

CREATE OR REPLACE FUNCTION public.restaurant_import_workspace_property(_workspace_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_import_workspaces WHERE id = _workspace_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_import_source_property(_source_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.property_id
  FROM public.restaurant_import_sources s
  JOIN public.restaurant_import_workspaces w ON w.id = s.workspace_id
  WHERE s.id = _source_id;
$$;

REVOKE ALL ON FUNCTION public.restaurant_import_workspace_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_import_workspace_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_import_source_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_import_source_property(uuid) TO authenticated, service_role;

-- restaurant_import_workspaces: has property_id directly.
DROP POLICY IF EXISTS "import workspaces write" ON public.restaurant_import_workspaces;
CREATE POLICY "import workspaces write scoped" ON public.restaurant_import_workspaces FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], property_id));

-- restaurant_import_sources: property derived via its own workspace_id column.
DROP POLICY IF EXISTS "import sources write" ON public.restaurant_import_sources;
CREATE POLICY "import sources write scoped" ON public.restaurant_import_sources FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_workspace_property(workspace_id)));

-- restaurant_import_field_mappings: property derived via source_id -> workspace_id.
DROP POLICY IF EXISTS "import mappings write" ON public.restaurant_import_field_mappings;
CREATE POLICY "import mappings write scoped" ON public.restaurant_import_field_mappings FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_source_property(source_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_source_property(source_id)));

-- restaurant_import_staged_records: has workspace_id directly.
DROP POLICY IF EXISTS "import staged write" ON public.restaurant_import_staged_records;
CREATE POLICY "import staged write scoped" ON public.restaurant_import_staged_records FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], public.restaurant_import_workspace_property(workspace_id)));
