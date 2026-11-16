-- Phase 2 closure: enforce tenant/property integrity and independent approval at the database boundary.
-- The helper is shared across product RLS policies; reject a property ID that does not belong
-- to the supplied tenant before evaluating platform-admin or membership grants.
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(
  _tenant_id uuid,
  _roles public.restaurant_role[],
  _property_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      _property_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.restaurant_properties p
        WHERE p.id = _property_id
          AND p.tenant_id = _tenant_id
      )
    )
    AND (
      public.restaurant_is_platform_admin(auth.uid())
      OR (
        EXISTS (
          SELECT 1
          FROM public.restaurant_members m
          WHERE m.tenant_id = _tenant_id
            AND m.user_id = auth.uid()
            AND m.role = ANY(_roles)
            AND (
              _property_id IS NULL
              OR m.property_id IS NULL
              OR m.property_id = _property_id
            )
        )
        AND public.restaurant_member_active(auth.uid(), _tenant_id)
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.restaurant_guard_operational_expense_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_tenant uuid;
  v_location_tenant uuid;
  v_location_property uuid;
BEGIN
  SELECT c.tenant_id
    INTO v_category_tenant
    FROM public.restaurant_operational_expense_categories c
   WHERE c.id = NEW.category_id;

  IF v_category_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Expense category must belong to the same tenant.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.property_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.restaurant_properties p
        WHERE p.id = NEW.property_id
          AND p.tenant_id = NEW.tenant_id
     ) THEN
    RAISE EXCEPTION 'Expense property must belong to the same tenant.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.location_id IS NOT NULL THEN
    SELECT l.tenant_id, l.property_id
      INTO v_location_tenant, v_location_property
      FROM public.restaurant_locations l
     WHERE l.id = NEW.location_id;

    IF v_location_tenant IS DISTINCT FROM NEW.tenant_id
       OR v_location_property IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'Expense location must belong to the selected tenant and property.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_status <> 'pending'
       OR NEW.approved_by IS NOT NULL
       OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'New operational expenses must enter the approval workflow as pending.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF OLD.approval_status <> 'pending' OR NEW.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'Only pending-to-approved transitions are supported; use an authorized workflow action.'
        USING ERRCODE = '42501';
    END IF;

    IF auth.uid() IS NULL
       OR NEW.approved_by IS DISTINCT FROM auth.uid()
       OR NEW.approved_at IS NULL
       OR NEW.created_by = auth.uid() THEN
      RAISE EXCEPTION 'Expense approval requires a distinct authenticated approver.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.restaurant_can_write_scoped(
      NEW.tenant_id,
      ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],
      NEW.property_id
    ) THEN
      RAISE EXCEPTION 'Approver is not authorized for this tenant/property.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Approval identity and timestamp are immutable.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_guard_operational_expense_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS restaurant_operational_expense_integrity_guard
  ON public.restaurant_operational_expenses;

CREATE TRIGGER restaurant_operational_expense_integrity_guard
BEFORE INSERT OR UPDATE ON public.restaurant_operational_expenses
FOR EACH ROW
EXECUTE FUNCTION public.restaurant_guard_operational_expense_integrity();
