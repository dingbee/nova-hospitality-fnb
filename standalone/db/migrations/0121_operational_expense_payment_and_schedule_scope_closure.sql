-- Phase 2 closure: payment authorization/integrity and recurring occurrence property isolation.
CREATE OR REPLACE FUNCTION public.restaurant_sync_operational_expense_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  x uuid;
  paid numeric(14,2);
  total numeric(14,2);
  curr text;
  expense_tenant uuid;
  expense_approval text;
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'Operational expense payments are immutable; use a controlled correction workflow.'
      USING ERRCODE = '42501';
  END IF;
  x := CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
  SELECT e.amount,e.currency,e.tenant_id,e.approval_status
    INTO total,curr,expense_tenant,expense_approval
    FROM public.restaurant_operational_expenses e WHERE e.id=x FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.tenant_id IS DISTINCT FROM expense_tenant THEN
      RAISE EXCEPTION 'Payment tenant must match expense tenant' USING ERRCODE='23514';
    END IF;
    IF NEW.currency IS DISTINCT FROM curr THEN
      RAISE EXCEPTION 'Payment currency mismatch' USING ERRCODE='23514';
    END IF;
    IF expense_approval <> 'approved' THEN
      RAISE EXCEPTION 'Only approved expenses can receive payments' USING ERRCODE='42501';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.restaurant_operational_expense_payments p WHERE p.expense_id=x AND p.currency<>curr) THEN
    RAISE EXCEPTION 'Payment currency mismatch';
  END IF;
  SELECT COALESCE(SUM(p.amount),0) INTO paid
    FROM public.restaurant_operational_expense_payments p WHERE p.expense_id=x;
  IF paid>total THEN RAISE EXCEPTION 'Payments exceed expense amount'; END IF;
  UPDATE public.restaurant_operational_expenses
     SET paid_amount=paid,
         payment_status=CASE WHEN paid=0 THEN 'unpaid' WHEN paid=total THEN 'paid' ELSE 'partially_paid' END,
         updated_at=now()
   WHERE id=x;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE UPDATE, DELETE ON public.restaurant_operational_expense_payments FROM authenticated;

DROP POLICY IF EXISTS restaurant_operational_expense_schedule_occurrences_read_scoped
  ON public.restaurant_operational_expense_schedule_occurrences;
CREATE POLICY restaurant_operational_expense_schedule_occurrences_read_scoped
ON public.restaurant_operational_expense_schedule_occurrences FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.restaurant_operational_expense_schedules s
    WHERE s.id=public.restaurant_operational_expense_schedule_occurrences.schedule_id
      AND s.tenant_id=public.restaurant_operational_expense_schedule_occurrences.tenant_id
      AND public.restaurant_can_read_scoped(s.tenant_id,s.property_id)
  )
);

DROP POLICY IF EXISTS restaurant_operational_expense_schedule_occurrences_write_scope
  ON public.restaurant_operational_expense_schedule_occurrences;
CREATE POLICY restaurant_operational_expense_schedule_occurrences_write_scope
ON public.restaurant_operational_expense_schedule_occurrences FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.restaurant_operational_expense_schedules s
    WHERE s.id=public.restaurant_operational_expense_schedule_occurrences.schedule_id
      AND s.tenant_id=public.restaurant_operational_expense_schedule_occurrences.tenant_id
      AND public.restaurant_can_write_scoped(s.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],s.property_id)
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.restaurant_operational_expense_schedules s
    WHERE s.id=public.restaurant_operational_expense_schedule_occurrences.schedule_id
      AND s.tenant_id=public.restaurant_operational_expense_schedule_occurrences.tenant_id
      AND public.restaurant_can_write_scoped(s.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],s.property_id)
  )
);
