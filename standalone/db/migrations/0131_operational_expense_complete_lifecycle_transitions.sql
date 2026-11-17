CREATE OR REPLACE FUNCTION public.restaurant_guard_operational_expense_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_category_tenant uuid;
  v_parent_tenant uuid;
  v_supplier_tenant uuid;
  v_location_tenant uuid;
  v_location_property uuid;
  v_property_currency text;
BEGIN
  SELECT c.tenant_id INTO v_category_tenant
  FROM public.restaurant_operational_expense_categories c WHERE c.id=NEW.category_id;
  IF v_category_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Expense category must belong to the same tenant.' USING ERRCODE='23514';
  END IF;
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT s.tenant_id INTO v_supplier_tenant FROM public.restaurant_suppliers s WHERE s.id=NEW.supplier_id;
    IF v_supplier_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Expense supplier must belong to the same tenant.' USING ERRCODE='23514';
    END IF;
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
    SELECT l.tenant_id,l.property_id INTO v_location_tenant,v_location_property
    FROM public.restaurant_locations l WHERE l.id=NEW.location_id;
    IF v_location_tenant IS DISTINCT FROM NEW.tenant_id OR v_location_property IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'Expense location must belong to the selected tenant and property.' USING ERRCODE='23514';
    END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.created_by IS NULL OR (auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM auth.uid()) THEN
      RAISE EXCEPTION 'Expense creator must match the authenticated creator.' USING ERRCODE='42501';
    END IF;
    IF NEW.expense_status NOT IN ('draft','recorded') OR NEW.approval_status<>'pending'
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'New expenses must be draft or recorded and enter approval as pending.' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Expense creator identity is immutable.' USING ERRCODE='42501';
  END IF;

  IF (NEW.category_id,NEW.property_id,NEW.location_id,NEW.supplier_id,NEW.description,NEW.amount,NEW.currency,NEW.incurred_on)
     IS DISTINCT FROM
     (OLD.category_id,OLD.property_id,OLD.location_id,OLD.supplier_id,OLD.description,OLD.amount,OLD.currency,OLD.incurred_on)
     AND OLD.expense_status NOT IN ('draft','recorded') THEN
    RAISE EXCEPTION 'Only draft or recorded expenses can be edited.' USING ERRCODE='42501';
  END IF;

  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF OLD.approval_status<>'pending' OR OLD.expense_status<>'recorded' THEN
      RAISE EXCEPTION 'Only recorded pending expenses can be decided.' USING ERRCODE='42501';
    END IF;
    IF auth.uid() IS NULL OR NEW.approved_by IS DISTINCT FROM auth.uid() AND NEW.rejected_by IS DISTINCT FROM auth.uid()
       OR NEW.created_by IS NULL OR NEW.created_by=auth.uid() THEN
      RAISE EXCEPTION 'Expense decision requires a distinct authenticated approver.' USING ERRCODE='42501';
    END IF;
    IF NOT public.restaurant_can_write_scoped(NEW.tenant_id,
      ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],NEW.property_id) THEN
      RAISE EXCEPTION 'Approver is not authorized for this tenant/property.' USING ERRCODE='42501';
    END IF;
    IF NEW.approval_status='approved' THEN
      IF NEW.approved_by IS DISTINCT FROM auth.uid() OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'Approval requires approver identity and timestamp.' USING ERRCODE='42501';
      END IF;
      NEW.expense_status:='approved';
    ELSIF NEW.approval_status='rejected' THEN
      IF NEW.rejected_by IS DISTINCT FROM auth.uid() OR NEW.rejected_at IS NULL OR nullif(trim(NEW.rejection_reason),'') IS NULL THEN
        RAISE EXCEPTION 'Rejection requires an independent approver and reason.' USING ERRCODE='42501';
      END IF;
      NEW.expense_status:='cancelled';
      NEW.cancelled_by:=auth.uid();
      NEW.cancelled_at:=coalesce(NEW.cancelled_at,now());
      NEW.cancellation_reason:=NEW.rejection_reason;
    ELSE
      RAISE EXCEPTION 'Unsupported approval transition.' USING ERRCODE='42501';
    END IF;
  END IF;

  IF NEW.expense_status IS DISTINCT FROM OLD.expense_status THEN
    IF OLD.expense_status='draft' AND NEW.expense_status='recorded' THEN
      NULL;
    ELSIF OLD.expense_status='recorded' AND NEW.expense_status='approved' AND OLD.approval_status='pending' AND NEW.approval_status='approved' THEN
      NULL;
    ELSIF OLD.expense_status IN ('draft','recorded') AND NEW.expense_status='cancelled' THEN
      IF OLD.approval_status<>'pending' OR OLD.paid_amount<>0 OR auth.uid() IS NULL
         OR NEW.cancelled_by IS DISTINCT FROM auth.uid()
         OR NEW.cancelled_at IS NULL OR nullif(trim(NEW.cancellation_reason),'') IS NULL
         OR NOT public.restaurant_can_write_scoped(NEW.tenant_id,
           ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],NEW.property_id) THEN
        RAISE EXCEPTION 'Cancellation requires an authorized actor, reason and unpaid pending expense.' USING ERRCODE='42501';
      END IF;
    ELSIF OLD.expense_status='approved' AND NEW.expense_status IN ('partially_paid','paid') THEN
      IF pg_trigger_depth()<2 OR NEW.paid_amount<=OLD.paid_amount
         OR (NEW.expense_status='paid' AND NEW.paid_amount<>NEW.amount)
         OR (NEW.expense_status='partially_paid' AND (NEW.paid_amount<=0 OR NEW.paid_amount>=NEW.amount)) THEN
        RAISE EXCEPTION 'Paid lifecycle status can only be advanced by the payment ledger.' USING ERRCODE='42501';
      END IF;
    ELSIF OLD.expense_status='partially_paid' AND NEW.expense_status='paid' THEN
      IF pg_trigger_depth()<2 OR NEW.paid_amount<=OLD.paid_amount OR NEW.paid_amount<>NEW.amount THEN
        RAISE EXCEPTION 'Paid lifecycle status can only be advanced by the payment ledger.' USING ERRCODE='42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported expense lifecycle transition.' USING ERRCODE='42501';
    END IF;
  END IF;

  IF (NEW.paid_amount,NEW.payment_status) IS DISTINCT FROM (OLD.paid_amount,OLD.payment_status)
     AND pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'Payment totals are derived from the immutable payment ledger.' USING ERRCODE='42501';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by AND OLD.approval_status='approved' THEN
    RAISE EXCEPTION 'Approval identity is immutable.' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
