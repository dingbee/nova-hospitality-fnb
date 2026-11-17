-- Permit the trusted service-role scheduler to generate due occurrences while preserving
-- tenant/property authorization for authenticated interactive callers.
CREATE OR REPLACE FUNCTION public.restaurant_generate_scheduled_expense(p_schedule_id uuid,p_occurrence_date date)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE s public.restaurant_operational_expense_schedules%rowtype; v_expense_id uuid; v_next date;
BEGIN
  SELECT * INTO s FROM public.restaurant_operational_expense_schedules WHERE id=p_schedule_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'Active expense schedule not found'; END IF;
  IF current_user<>'service_role' AND NOT public.restaurant_can_write_scoped(
    s.tenant_id,ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[],s.property_id
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT expense_id INTO v_expense_id FROM public.restaurant_operational_expense_schedule_occurrences
    WHERE schedule_id=s.id AND occurrence_date=p_occurrence_date;
  IF v_expense_id IS NOT NULL THEN RETURN v_expense_id; END IF;
  IF p_occurrence_date<>s.next_occurrence THEN RAISE EXCEPTION 'Occurrence date must match the schedule next_occurrence'; END IF;
  IF s.ends_on IS NOT NULL AND p_occurrence_date>s.ends_on THEN RAISE EXCEPTION 'Schedule has reached its end date'; END IF;
  INSERT INTO public.restaurant_operational_expenses(tenant_id,property_id,location_id,category_id,supplier_id,description,amount,currency,incurred_on,expense_status,created_by)
  VALUES(s.tenant_id,s.property_id,s.location_id,s.category_id,s.supplier_id,s.description,s.amount,s.currency,p_occurrence_date,'recorded',coalesce(auth.uid(),s.created_by))
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
REVOKE ALL ON FUNCTION public.restaurant_generate_scheduled_expense(uuid,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.restaurant_generate_scheduled_expense(uuid,date) TO authenticated,service_role;
