-- Phase 2 complete workflow: category hierarchy, supplier links, lifecycle states,
-- rejection/cancellation, recurring schedule management, private attachments and audit history.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_operational_expenses_tenant_id_id_uq
  ON public.restaurant_operational_expenses(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_operational_expense_schedules_tenant_id_id_uq
  ON public.restaurant_operational_expense_schedules(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_operational_expense_categories_tenant_id_id_uq
  ON public.restaurant_operational_expense_categories(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_suppliers_tenant_id_id_uq
  ON public.restaurant_suppliers(tenant_id,id);

ALTER TABLE public.restaurant_operational_expense_categories
  ADD COLUMN IF NOT EXISTS parent_category_id uuid,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE public.restaurant_operational_expense_categories
  DROP CONSTRAINT IF EXISTS restaurant_operational_expense_categories_parent_tenant_fk;
ALTER TABLE public.restaurant_operational_expense_categories
  ADD CONSTRAINT restaurant_operational_expense_categories_parent_tenant_fk
  FOREIGN KEY (tenant_id,parent_category_id)
  REFERENCES public.restaurant_operational_expense_categories(tenant_id,id)
  ON DELETE RESTRICT;

ALTER TABLE public.restaurant_operational_expenses
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS expense_status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE public.restaurant_operational_expenses
  DROP CONSTRAINT IF EXISTS restaurant_operational_expenses_supplier_tenant_fk;
ALTER TABLE public.restaurant_operational_expenses
  ADD CONSTRAINT restaurant_operational_expenses_supplier_tenant_fk
  FOREIGN KEY (tenant_id,supplier_id)
  REFERENCES public.restaurant_suppliers(tenant_id,id)
  ON DELETE RESTRICT;
UPDATE public.restaurant_operational_expenses
SET expense_status = CASE
  WHEN approval_status='rejected' THEN 'cancelled'
  WHEN approval_status='approved' AND payment_status='paid' THEN 'paid'
  WHEN approval_status='approved' AND payment_status='partially_paid' THEN 'partially_paid'
  WHEN approval_status='approved' THEN 'approved'
  ELSE 'recorded'
END;
ALTER TABLE public.restaurant_operational_expenses
  DROP CONSTRAINT IF EXISTS restaurant_operational_expenses_expense_status_check;
ALTER TABLE public.restaurant_operational_expenses
  ADD CONSTRAINT restaurant_operational_expenses_expense_status_check
  CHECK (expense_status IN ('draft','recorded','approved','partially_paid','paid','cancelled'));
ALTER TABLE public.restaurant_operational_expenses
  DROP CONSTRAINT IF EXISTS restaurant_operational_expenses_rejection_fields_check;
ALTER TABLE public.restaurant_operational_expenses
  ADD CONSTRAINT restaurant_operational_expenses_rejection_fields_check
  CHECK (approval_status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND nullif(trim(rejection_reason),'') IS NOT NULL));

ALTER TABLE public.restaurant_operational_expense_schedules
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS ends_on date,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.restaurant_operational_expense_schedules
  DROP CONSTRAINT IF EXISTS restaurant_operational_expense_schedules_supplier_tenant_fk;
ALTER TABLE public.restaurant_operational_expense_schedules
  ADD CONSTRAINT restaurant_operational_expense_schedules_supplier_tenant_fk
  FOREIGN KEY (tenant_id,supplier_id)
  REFERENCES public.restaurant_suppliers(tenant_id,id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.restaurant_operational_expense_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  expense_id uuid,
  schedule_id uuid,
  property_id uuid,
  location_id uuid,
  event_type text NOT NULL,
  actor_id uuid,
  reason text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_operational_expense_audit_entity_check
    CHECK ((expense_id IS NOT NULL)::integer + (schedule_id IS NOT NULL)::integer = 1),
  CONSTRAINT restaurant_operational_expense_audit_expense_fk
    FOREIGN KEY (tenant_id,expense_id)
    REFERENCES public.restaurant_operational_expenses(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT restaurant_operational_expense_audit_schedule_fk
    FOREIGN KEY (tenant_id,schedule_id)
    REFERENCES public.restaurant_operational_expense_schedules(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS restaurant_operational_expense_audit_expense_idx
  ON public.restaurant_operational_expense_audit_events(tenant_id,expense_id,created_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_operational_expense_audit_schedule_idx
  ON public.restaurant_operational_expense_audit_events(tenant_id,schedule_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.restaurant_operational_expense_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_operational_expense_attachments_expense_fk
    FOREIGN KEY (tenant_id,expense_id)
    REFERENCES public.restaurant_operational_expenses(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS restaurant_operational_expense_attachments_expense_idx
  ON public.restaurant_operational_expense_attachments(tenant_id,expense_id,created_at DESC);

ALTER TABLE public.restaurant_operational_expense_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_operational_expense_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS restaurant_operational_expense_audit_read_scope ON public.restaurant_operational_expense_audit_events;
CREATE POLICY restaurant_operational_expense_audit_read_scope
ON public.restaurant_operational_expense_audit_events FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id,property_id));
DROP POLICY IF EXISTS restaurant_operational_expense_attachments_read_scope ON public.restaurant_operational_expense_attachments;
CREATE POLICY restaurant_operational_expense_attachments_read_scope
ON public.restaurant_operational_expense_attachments FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.restaurant_operational_expenses e
    WHERE e.id=expense_id AND e.tenant_id=tenant_id
      AND public.restaurant_can_read_scoped(e.tenant_id,e.property_id))
);
DROP POLICY IF EXISTS restaurant_operational_expense_attachments_insert_scope ON public.restaurant_operational_expense_attachments;
CREATE POLICY restaurant_operational_expense_attachments_insert_scope
ON public.restaurant_operational_expense_attachments FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by=auth.uid()
  AND EXISTS (SELECT 1 FROM public.restaurant_operational_expenses e
    WHERE e.id=expense_id AND e.tenant_id=tenant_id
      AND e.expense_status IN ('draft','recorded')
      AND public.restaurant_can_write_scoped(e.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],e.property_id))
);
DROP POLICY IF EXISTS restaurant_operational_expense_attachments_delete_scope ON public.restaurant_operational_expense_attachments;
CREATE POLICY restaurant_operational_expense_attachments_delete_scope
ON public.restaurant_operational_expense_attachments FOR DELETE TO authenticated
USING (
  uploaded_by=auth.uid()
  AND EXISTS (SELECT 1 FROM public.restaurant_operational_expenses e
    WHERE e.id=expense_id AND e.tenant_id=tenant_id
      AND e.expense_status IN ('draft','recorded')
      AND public.restaurant_can_write_scoped(e.tenant_id,
        ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],e.property_id))
);
REVOKE ALL ON public.restaurant_operational_expense_audit_events FROM anon,authenticated;
GRANT SELECT ON public.restaurant_operational_expense_audit_events TO authenticated;
REVOKE UPDATE,DELETE ON public.restaurant_operational_expense_attachments FROM authenticated;
GRANT SELECT,INSERT ON public.restaurant_operational_expense_attachments TO authenticated;
GRANT ALL ON public.restaurant_operational_expense_audit_events,public.restaurant_operational_expense_attachments TO service_role;

-- Private evidence bucket: paths are generated server-side as tenant/expense/file.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('restaurant-expense-attachments','restaurant-expense-attachments',false,10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=10485760,
  allowed_mime_types=ARRAY['application/pdf','image/jpeg','image/png','image/webp'];

CREATE OR REPLACE FUNCTION public.restaurant_can_access_expense_attachment_path(_name text,_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.restaurant_operational_expenses e
    WHERE e.id=(storage.foldername(_name))[2]::uuid
      AND e.tenant_id=(storage.foldername(_name))[1]::uuid
      AND CASE WHEN _write THEN
        e.expense_status IN ('draft','recorded')
        AND public.restaurant_can_write_scoped(e.tenant_id,
          ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],e.property_id)
      ELSE public.restaurant_can_read_scoped(e.tenant_id,e.property_id) END
  );
$$;
REVOKE EXECUTE ON FUNCTION public.restaurant_can_access_expense_attachment_path(text,boolean) FROM anon,public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_access_expense_attachment_path(text,boolean) TO authenticated,service_role;
DROP POLICY IF EXISTS restaurant_expense_attachments_private_read ON storage.objects;
CREATE POLICY restaurant_expense_attachments_private_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='restaurant-expense-attachments' AND public.restaurant_can_access_expense_attachment_path(name,false));
DROP POLICY IF EXISTS restaurant_expense_attachments_private_insert ON storage.objects;
CREATE POLICY restaurant_expense_attachments_private_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='restaurant-expense-attachments' AND public.restaurant_can_access_expense_attachment_path(name,true));
DROP POLICY IF EXISTS restaurant_expense_attachments_private_delete ON storage.objects;
CREATE POLICY restaurant_expense_attachments_private_delete ON storage.objects FOR DELETE TO authenticated
USING (bucket_id='restaurant-expense-attachments' AND public.restaurant_can_access_expense_attachment_path(name,true));

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

CREATE OR REPLACE FUNCTION public.restaurant_guard_operational_expense_schedule_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_currency text; v_category_tenant uuid; v_supplier_tenant uuid; v_location_tenant uuid; v_location_property uuid;
BEGIN
  SELECT tenant_id INTO v_category_tenant FROM public.restaurant_operational_expense_categories WHERE id=NEW.category_id;
  IF v_category_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Schedule category must belong to tenant.' USING ERRCODE='23514'; END IF;
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT tenant_id INTO v_supplier_tenant FROM public.restaurant_suppliers WHERE id=NEW.supplier_id;
    IF v_supplier_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Schedule supplier must belong to tenant.' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.property_id IS NOT NULL THEN
    SELECT currency INTO v_currency FROM public.restaurant_properties WHERE id=NEW.property_id AND tenant_id=NEW.tenant_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Schedule property must belong to tenant.' USING ERRCODE='23514'; END IF;
    IF NEW.currency IS DISTINCT FROM v_currency THEN RAISE EXCEPTION 'Schedule currency must match property currency.' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.location_id IS NOT NULL THEN
    SELECT tenant_id,property_id INTO v_location_tenant,v_location_property FROM public.restaurant_locations WHERE id=NEW.location_id;
    IF v_location_tenant IS DISTINCT FROM NEW.tenant_id OR v_location_property IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'Schedule location must belong to selected property.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.ends_on IS NOT NULL AND NEW.next_occurrence>NEW.ends_on THEN
    RAISE EXCEPTION 'Next occurrence cannot be after schedule end date.' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS restaurant_operational_expense_schedule_integrity_guard ON public.restaurant_operational_expense_schedules;
CREATE TRIGGER restaurant_operational_expense_schedule_integrity_guard
BEFORE INSERT OR UPDATE ON public.restaurant_operational_expense_schedules
FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_operational_expense_schedule_integrity();
REVOKE ALL ON FUNCTION public.restaurant_guard_operational_expense_schedule_integrity() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_sync_operational_expense_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE x uuid; paid numeric(14,2); total numeric(14,2); curr text; expense_tenant uuid; expense_approval text;
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') AND current_user='authenticated' THEN
    RAISE EXCEPTION 'Operational expense payments are immutable; use a controlled correction workflow.' USING ERRCODE='42501';
  END IF;
  x:=CASE WHEN TG_OP='DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
  SELECT amount,currency,tenant_id,approval_status INTO total,curr,expense_tenant,expense_approval
    FROM public.restaurant_operational_expenses WHERE id=x FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF TG_OP<>'DELETE' THEN
    IF NEW.tenant_id IS DISTINCT FROM expense_tenant OR NEW.currency IS DISTINCT FROM curr THEN
      RAISE EXCEPTION 'Payment tenant and currency must match expense.' USING ERRCODE='23514';
    END IF;
    IF expense_approval<>'approved' THEN RAISE EXCEPTION 'Only approved expenses can receive payments.' USING ERRCODE='42501'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.restaurant_operational_expense_payments p WHERE p.expense_id=x AND p.currency<>curr) THEN
    RAISE EXCEPTION 'Payment currency mismatch';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO paid FROM public.restaurant_operational_expense_payments WHERE expense_id=x;
  IF paid>total THEN RAISE EXCEPTION 'Payments exceed expense amount'; END IF;
  UPDATE public.restaurant_operational_expenses
     SET paid_amount=paid,
         payment_status=CASE WHEN paid=0 THEN 'unpaid' WHEN paid=total THEN 'paid' ELSE 'partially_paid' END,
         expense_status=CASE WHEN paid=0 THEN 'approved' WHEN paid=total THEN 'paid' ELSE 'partially_paid' END,
         updated_at=now()
   WHERE id=x;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.restaurant_sync_operational_expense_payment() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_generate_scheduled_expense(p_schedule_id uuid,p_occurrence_date date)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE s public.restaurant_operational_expense_schedules%rowtype; v_expense_id uuid; v_next date;
BEGIN
  SELECT * INTO s FROM public.restaurant_operational_expense_schedules WHERE id=p_schedule_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'Active expense schedule not found'; END IF;
  IF NOT public.restaurant_can_write_scoped(s.tenant_id,ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],s.property_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT expense_id INTO v_expense_id FROM public.restaurant_operational_expense_schedule_occurrences
    WHERE schedule_id=s.id AND occurrence_date=p_occurrence_date;
  IF v_expense_id IS NOT NULL THEN RETURN v_expense_id; END IF;
  IF p_occurrence_date<>s.next_occurrence THEN RAISE EXCEPTION 'Occurrence date must match the schedule next_occurrence'; END IF;
  IF s.ends_on IS NOT NULL AND p_occurrence_date>s.ends_on THEN RAISE EXCEPTION 'Schedule has reached its end date'; END IF;
  INSERT INTO public.restaurant_operational_expenses(tenant_id,property_id,location_id,category_id,supplier_id,description,amount,currency,incurred_on,expense_status)
  VALUES(s.tenant_id,s.property_id,s.location_id,s.category_id,s.supplier_id,s.description,s.amount,s.currency,p_occurrence_date,'recorded')
  RETURNING id INTO v_expense_id;
  INSERT INTO public.restaurant_operational_expense_schedule_occurrences(tenant_id,schedule_id,occurrence_date,expense_id)
  VALUES(s.tenant_id,s.id,p_occurrence_date,v_expense_id);
  v_next:=CASE s.cadence WHEN 'weekly' THEN p_occurrence_date+7 WHEN 'monthly' THEN (p_occurrence_date+interval '1 month')::date
    WHEN 'quarterly' THEN (p_occurrence_date+interval '3 months')::date WHEN 'annually' THEN (p_occurrence_date+interval '1 year')::date END;
  UPDATE public.restaurant_operational_expense_schedules
    SET next_occurrence=v_next,active=CASE WHEN s.ends_on IS NOT NULL AND v_next>s.ends_on THEN false ELSE active END
    WHERE id=s.id;
  RETURN v_expense_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_audit_operational_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_action text; v_reason text; v_expense public.restaurant_operational_expenses%rowtype;
BEGIN
  IF TG_OP='INSERT' THEN
    v_action:='created';
    v_expense:=NEW;
    INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,expense_id,property_id,location_id,event_type,actor_id,after_state)
    VALUES(NEW.tenant_id,NEW.id,NEW.property_id,NEW.location_id,v_action,coalesce(auth.uid(),NEW.created_by),to_jsonb(NEW));
    RETURN NEW;
  END IF;
  v_expense:=NEW;
  v_action:=CASE
    WHEN NEW.approval_status IS DISTINCT FROM OLD.approval_status AND NEW.approval_status='approved' THEN 'approved'
    WHEN NEW.approval_status IS DISTINCT FROM OLD.approval_status AND NEW.approval_status='rejected' THEN 'rejected'
    WHEN NEW.expense_status IS DISTINCT FROM OLD.expense_status AND NEW.expense_status='cancelled' THEN 'cancelled'
    WHEN NEW.expense_status IS DISTINCT FROM OLD.expense_status AND NEW.expense_status='recorded' THEN 'recorded'
    WHEN (NEW.category_id,NEW.property_id,NEW.location_id,NEW.supplier_id,NEW.description,NEW.amount,NEW.currency,NEW.incurred_on)
       IS DISTINCT FROM (OLD.category_id,OLD.property_id,OLD.location_id,OLD.supplier_id,OLD.description,OLD.amount,OLD.currency,OLD.incurred_on) THEN 'edited'
    ELSE 'updated'
  END;
  v_reason:=coalesce(NEW.rejection_reason,NEW.cancellation_reason);
  INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,expense_id,property_id,location_id,event_type,actor_id,reason,before_state,after_state)
  VALUES(NEW.tenant_id,NEW.id,NEW.property_id,NEW.location_id,v_action,auth.uid(),v_reason,to_jsonb(OLD),to_jsonb(NEW));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS restaurant_operational_expense_audit_trg ON public.restaurant_operational_expenses;
CREATE TRIGGER restaurant_operational_expense_audit_trg
AFTER INSERT OR UPDATE ON public.restaurant_operational_expenses
FOR EACH ROW EXECUTE FUNCTION public.restaurant_audit_operational_expense();
REVOKE ALL ON FUNCTION public.restaurant_audit_operational_expense() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_audit_operational_expense_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_action text;
BEGIN
  v_action:=CASE WHEN TG_OP='INSERT' THEN 'schedule_created'
    WHEN OLD.active AND NOT NEW.active THEN 'schedule_paused'
    WHEN NOT OLD.active AND NEW.active THEN 'schedule_resumed'
    ELSE 'schedule_updated' END;
  INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,schedule_id,property_id,location_id,event_type,actor_id,before_state,after_state)
  VALUES(NEW.tenant_id,NEW.id,NEW.property_id,NEW.location_id,v_action,auth.uid(),
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS restaurant_operational_expense_schedule_audit_trg ON public.restaurant_operational_expense_schedules;
CREATE TRIGGER restaurant_operational_expense_schedule_audit_trg
AFTER INSERT OR UPDATE ON public.restaurant_operational_expense_schedules
FOR EACH ROW EXECUTE FUNCTION public.restaurant_audit_operational_expense_schedule();
REVOKE ALL ON FUNCTION public.restaurant_audit_operational_expense_schedule() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_audit_operational_expense_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e public.restaurant_operational_expenses%rowtype;
BEGIN
  SELECT * INTO e FROM public.restaurant_operational_expenses WHERE id=NEW.expense_id;
  INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,expense_id,property_id,location_id,event_type,actor_id,after_state,metadata)
  VALUES(NEW.tenant_id,NEW.expense_id,e.property_id,e.location_id,'payment_recorded',coalesce(auth.uid(),NEW.recorded_by),
    to_jsonb(NEW),jsonb_build_object('amount',NEW.amount,'currency',NEW.currency,'reference',NEW.reference));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS restaurant_operational_expense_payment_audit_trg ON public.restaurant_operational_expense_payments;
CREATE TRIGGER restaurant_operational_expense_payment_audit_trg
AFTER INSERT ON public.restaurant_operational_expense_payments
FOR EACH ROW EXECUTE FUNCTION public.restaurant_audit_operational_expense_payment();
REVOKE ALL ON FUNCTION public.restaurant_audit_operational_expense_payment() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_audit_operational_expense_attachment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e public.restaurant_operational_expenses%rowtype;
BEGIN
  SELECT * INTO e FROM public.restaurant_operational_expenses WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
  INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,expense_id,property_id,location_id,event_type,actor_id,metadata)
  VALUES(e.tenant_id,e.id,e.property_id,e.location_id,
    CASE WHEN TG_OP='DELETE' THEN 'attachment_removed' ELSE 'attachment_added' END,
    auth.uid(),jsonb_build_object('file_name',CASE WHEN TG_OP='DELETE' THEN OLD.file_name ELSE NEW.file_name END));
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DROP TRIGGER IF EXISTS restaurant_operational_expense_attachment_audit_trg ON public.restaurant_operational_expense_attachments;
CREATE TRIGGER restaurant_operational_expense_attachment_audit_trg
AFTER INSERT OR DELETE ON public.restaurant_operational_expense_attachments
FOR EACH ROW EXECUTE FUNCTION public.restaurant_audit_operational_expense_attachment();
REVOKE ALL ON FUNCTION public.restaurant_audit_operational_expense_attachment() FROM PUBLIC,anon,authenticated;

GRANT SELECT,INSERT,UPDATE ON public.restaurant_operational_expense_categories TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.restaurant_operational_expenses TO authenticated;
GRANT SELECT,INSERT,UPDATE ON public.restaurant_operational_expense_schedules TO authenticated;
