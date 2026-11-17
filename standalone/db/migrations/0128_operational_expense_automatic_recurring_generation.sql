-- Automatic recurring expense generation. The cron job is idempotent and catches up missed due dates.
CREATE OR REPLACE FUNCTION public.restaurant_generate_scheduled_expense(p_schedule_id uuid,p_occurrence_date date)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE s public.restaurant_operational_expense_schedules%rowtype; v_expense_id uuid; v_next date;
BEGIN
  SELECT * INTO s FROM public.restaurant_operational_expense_schedules WHERE id=p_schedule_id FOR UPDATE;
  IF NOT FOUND OR NOT s.active THEN RAISE EXCEPTION 'Active expense schedule not found'; END IF;
  IF current_user NOT IN ('service_role','postgres') AND NOT public.restaurant_can_write_scoped(
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

CREATE OR REPLACE FUNCTION public.restaurant_generate_due_operational_expenses(p_run_date date DEFAULT current_date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s record; v_due date; v_active boolean; v_ends date; v_count integer:=0; v_iterations integer;
BEGIN
  FOR s IN SELECT id FROM public.restaurant_operational_expense_schedules WHERE active AND next_occurrence<=p_run_date ORDER BY next_occurrence LOOP
    v_iterations:=0;
    LOOP
      SELECT next_occurrence,active,ends_on INTO v_due,v_active,v_ends
      FROM public.restaurant_operational_expense_schedules WHERE id=s.id FOR UPDATE;
      EXIT WHEN NOT FOUND OR NOT v_active OR v_due>p_run_date OR (v_ends IS NOT NULL AND v_due>v_ends);
      v_iterations:=v_iterations+1;
      IF v_iterations>24 THEN
        INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,schedule_id,property_id,event_type,reason,metadata)
        SELECT tenant_id,id,property_id,'schedule_generation_failed','Catch-up exceeded 24 missed occurrences',jsonb_build_object('run_date',p_run_date)
        FROM public.restaurant_operational_expense_schedules WHERE id=s.id;
        EXIT;
      END IF;
      BEGIN
        PERFORM public.restaurant_generate_scheduled_expense(s.id,v_due);
        v_count:=v_count+1;
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.restaurant_operational_expense_audit_events(tenant_id,schedule_id,property_id,event_type,reason,metadata)
        SELECT tenant_id,id,property_id,'schedule_generation_failed',SQLERRM,jsonb_build_object('run_date',p_run_date,'occurrence_date',v_due)
        FROM public.restaurant_operational_expense_schedules WHERE id=s.id;
        EXIT;
      END;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.restaurant_generate_due_operational_expenses(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_generate_due_operational_expenses(date) TO service_role;

DO $schedule$
DECLARE v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = ''lexibite-operational-expense-scheduler''' INTO v_job_id;
    IF v_job_id IS NOT NULL THEN EXECUTE 'SELECT cron.unschedule($1)' USING v_job_id; END IF;
    EXECUTE 'SELECT cron.schedule(''lexibite-operational-expense-scheduler'',''10 0 * * *'',''SELECT public.restaurant_generate_due_operational_expenses(current_date);'')';
  END IF;
END
$schedule$;
