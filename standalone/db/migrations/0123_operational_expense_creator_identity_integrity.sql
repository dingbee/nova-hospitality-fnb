-- Phase 2 closure: preserve the expense creator identity and prevent forged creator attribution.
CREATE OR REPLACE FUNCTION public.restaurant_guard_operational_expense_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_category_tenant uuid;
  v_location_tenant uuid;
  v_location_property uuid;
  v_property_currency text;
BEGIN
  SELECT c.tenant_id INTO v_category_tenant FROM public.restaurant_operational_expense_categories c WHERE c.id=NEW.category_id;
  IF v_category_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Expense category must belong to the same tenant.' USING ERRCODE='23514';
  END IF;
  IF NEW.property_id IS NOT NULL THEN
    SELECT p.currency INTO v_property_currency FROM public.restaurant_properties p
     WHERE p.id=NEW.property_id AND p.tenant_id=NEW.tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense property must belong to the same tenant.' USING ERRCODE='23514'; END IF;
    IF NEW.currency IS DISTINCT FROM v_property_currency THEN
      RAISE EXCEPTION 'Expense currency must match the selected property currency.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.location_id IS NOT NULL THEN
    SELECT l.tenant_id,l.property_id INTO v_location_tenant,v_location_property FROM public.restaurant_locations l WHERE l.id=NEW.location_id;
    IF v_location_tenant IS DISTINCT FROM NEW.tenant_id OR v_location_property IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'Expense location must belong to the selected tenant and property.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.created_by IS NULL OR (auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM auth.uid()) THEN
      RAISE EXCEPTION 'Expense creator must match the authenticated creator.' USING ERRCODE='42501';
    END IF;
    IF NEW.approval_status<>'pending' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'New operational expenses must enter the approval workflow as pending.' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Expense creator identity is immutable.' USING ERRCODE='42501';
  END IF;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF OLD.approval_status<>'pending' OR NEW.approval_status<>'approved' THEN
      RAISE EXCEPTION 'Only pending-to-approved transitions are supported; use an authorized workflow action.' USING ERRCODE='42501';
    END IF;
    IF auth.uid() IS NULL OR NEW.approved_by IS DISTINCT FROM auth.uid() OR NEW.approved_at IS NULL
       OR NEW.created_by IS NULL OR NEW.created_by=auth.uid() THEN
      RAISE EXCEPTION 'Expense approval requires a distinct authenticated approver.' USING ERRCODE='42501';
    END IF;
    IF NOT public.restaurant_can_write_scoped(NEW.tenant_id,
      ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],NEW.property_id) THEN
      RAISE EXCEPTION 'Approver is not authorized for this tenant/property.' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Approval identity and timestamp are immutable.' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
