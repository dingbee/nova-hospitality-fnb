-- 0040 Operational Cost Intelligence persistence. Existing stock movement ledger remains authoritative.
create table if not exists public.restaurant_operational_expense_categories(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,name text not null,category_key text not null,active boolean not null default true,created_at timestamptz not null default now(),unique(tenant_id,category_key));
create table if not exists public.restaurant_operational_expenses(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,property_id uuid references public.restaurant_properties(id),location_id uuid references public.restaurant_locations(id),category_id uuid not null references public.restaurant_operational_expense_categories(id),description text not null,amount numeric(14,2) not null check(amount>0),currency text not null check(currency ~ '^[A-Z]{3}$'),incurred_on date not null,approval_status text not null default 'pending' check(approval_status in('pending','approved','rejected')),approved_by uuid,approved_at timestamptz,payment_status text not null default 'unpaid' check(payment_status in('unpaid','partially_paid','paid')),paid_amount numeric(14,2) not null default 0 check(paid_amount>=0 and paid_amount<=amount),created_by uuid not null default auth.uid(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(property_id is not null or location_id is null),check(approval_status<>'approved' or (approved_by is not null and approved_at is not null)));
create table if not exists public.restaurant_operational_expense_payments(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,expense_id uuid not null references public.restaurant_operational_expenses(id),amount numeric(14,2) not null check(amount>0),currency text not null check(currency ~ '^[A-Z]{3}$'),paid_at timestamptz not null default now(),reference text,recorded_by uuid not null default auth.uid());
create table if not exists public.restaurant_operational_expense_schedules(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,property_id uuid references public.restaurant_properties(id),location_id uuid references public.restaurant_locations(id),category_id uuid not null references public.restaurant_operational_expense_categories(id),description text not null,amount numeric(14,2) not null check(amount>0),currency text not null check(currency ~ '^[A-Z]{3}$'),cadence text not null check(cadence in('weekly','monthly','quarterly','annually')),next_occurrence date not null,active boolean not null default true,created_by uuid not null default auth.uid(),check(property_id is not null or location_id is null));
create table if not exists public.restaurant_cost_allocation_rules(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,name text not null,currency text not null check(currency ~ '^[A-Z]{3}$'),effective_from date not null,effective_to date,version integer not null check(version>0),targets jsonb not null check(jsonb_typeof(targets)='array' and jsonb_array_length(targets)>0),status text not null default 'draft' check(status in('draft','approved','retired')),approved_by uuid,approved_at timestamptz,created_by uuid not null default auth.uid(),unique(tenant_id,name,version),check(effective_to is null or effective_to>=effective_from),check(status<>'approved' or (approved_by is not null and approved_at is not null)));
create table if not exists public.restaurant_cost_allocations(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,source_type text not null check(source_type in('operational_expense','operational_consumption')),source_id uuid not null,property_id uuid not null references public.restaurant_properties(id),location_id uuid references public.restaurant_locations(id),currency text not null check(currency ~ '^[A-Z]{3}$'),period_start date not null,amount numeric(14,2) not null check(amount>0),allocation_method text not null check(allocation_method in('direct','approved_rule','activity_driver','manual')),rule_id uuid references public.restaurant_cost_allocation_rules(id),rule_version integer,approved_by uuid,created_by uuid not null default auth.uid(),check((allocation_method='approved_rule')=(rule_id is not null)),check(allocation_method<>'manual' or approved_by is not null));
create table if not exists public.restaurant_operational_expense_schedule_occurrences(
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 schedule_id uuid not null references public.restaurant_operational_expense_schedules(id) on delete cascade,
 occurrence_date date not null,
 expense_id uuid references public.restaurant_operational_expenses(id),
 created_at timestamptz not null default now(),
 unique(schedule_id,occurrence_date)
);
create table if not exists public.restaurant_cost_allocation_exceptions(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,source_type text not null check(source_type in('operational_expense','operational_consumption')),source_id uuid not null,currency text not null check(currency ~ '^[A-Z]{3}$'),period_start date not null,source_amount numeric(14,2) not null check(source_amount>=0),reason text not null,resolved_at timestamptz,created_by uuid not null default auth.uid(),unique(tenant_id,source_type,source_id));
create index if not exists restaurant_operational_expenses_scope_date_idx on public.restaurant_operational_expenses(tenant_id,property_id,location_id,incurred_on);
create index if not exists restaurant_cost_allocations_scope_period_idx on public.restaurant_cost_allocations(tenant_id,property_id,location_id,period_start);
create or replace function public.restaurant_sync_operational_expense_payment() returns trigger language plpgsql security invoker set search_path=public as $$
declare x uuid; paid numeric(14,2); total numeric(14,2); curr text;
begin x:=case when tg_op='DELETE' then old.expense_id else new.expense_id end;
select amount,currency into total,curr from public.restaurant_operational_expenses where id=x for update;
if not found then raise exception 'Expense not found'; end if;
if exists(select 1 from public.restaurant_operational_expense_payments where expense_id=x and currency<>curr) then raise exception 'Payment currency mismatch'; end if;
select coalesce(sum(amount),0) into paid from public.restaurant_operational_expense_payments where expense_id=x;
if paid>total then raise exception 'Payments exceed expense amount'; end if;
update public.restaurant_operational_expenses set paid_amount=paid,payment_status=case when paid=0 then 'unpaid' when paid=total then 'paid' else 'partially_paid' end,updated_at=now() where id=x;
if tg_op='DELETE' then return old; else return new; end if; end $$;
drop trigger if exists restaurant_operational_expense_payment_sync on public.restaurant_operational_expense_payments;
create trigger restaurant_operational_expense_payment_sync after insert or update or delete on public.restaurant_operational_expense_payments for each row execute function public.restaurant_sync_operational_expense_payment();
do $$ declare t text; s text; begin foreach t in array array['restaurant_operational_expense_categories','restaurant_operational_expenses','restaurant_operational_expense_payments','restaurant_operational_expense_schedules','restaurant_operational_expense_schedule_occurrences','restaurant_cost_allocation_rules','restaurant_cost_allocations','restaurant_cost_allocation_exceptions'] loop
execute format('alter table public.%I enable row level security',t);
s:=case when t in('restaurant_operational_expenses','restaurant_operational_expense_schedules','restaurant_cost_allocations') then 'property_id' when t='restaurant_operational_expense_payments' then '(select property_id from public.restaurant_operational_expenses e where e.id=expense_id)' else 'null' end;
execute format('create policy %I on public.%I for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,%s))',t||'_read_scoped',t,s);
end loop; end $$;
create policy restaurant_operational_expense_categories_write_scoped on public.restaurant_operational_expense_categories for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null));
create policy restaurant_operational_expenses_write_scoped on public.restaurant_operational_expenses for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_operational_expense_payments_write_scoped on public.restaurant_operational_expense_payments for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],(select property_id from public.restaurant_operational_expenses e where e.id=expense_id))) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],(select property_id from public.restaurant_operational_expenses e where e.id=expense_id)));
create policy restaurant_operational_expense_schedule_occurrences_write_scoped on public.restaurant_operational_expense_schedule_occurrences for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null));
create policy restaurant_operational_expense_schedules_write_scoped on public.restaurant_operational_expense_schedules for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_cost_allocation_rules_write_scoped on public.restaurant_cost_allocation_rules for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null));
create policy restaurant_cost_allocations_write_scoped on public.restaurant_cost_allocations for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_cost_allocation_exceptions_write_scoped on public.restaurant_cost_allocation_exceptions for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],null));
grant select,insert,update,delete on public.restaurant_operational_expense_categories,public.restaurant_operational_expenses,public.restaurant_operational_expense_payments,public.restaurant_operational_expense_schedules,public.restaurant_operational_expense_schedule_occurrences,public.restaurant_cost_allocation_rules,public.restaurant_cost_allocations,public.restaurant_cost_allocation_exceptions to authenticated;
grant all on public.restaurant_operational_expense_categories,public.restaurant_operational_expenses,public.restaurant_operational_expense_payments,public.restaurant_operational_expense_schedules,public.restaurant_cost_allocation_rules,public.restaurant_cost_allocations,public.restaurant_cost_allocation_exceptions to service_role;

create or replace function public.restaurant_generate_scheduled_expense(p_schedule_id uuid,p_occurrence_date date)
returns uuid language plpgsql security invoker set search_path=public as $$
declare s public.restaurant_operational_expense_schedules%rowtype; v_expense_id uuid; v_next date;
begin
 select * into s from public.restaurant_operational_expense_schedules where id=p_schedule_id for update;
 if not found or not s.active then raise exception 'Active expense schedule not found'; end if;
 if not public.restaurant_can_write_scoped(s.tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],s.property_id) then raise exception 'Not authorized'; end if;
 if p_occurrence_date<>s.next_occurrence then raise exception 'Occurrence date must match the schedule next_occurrence'; end if;
 select expense_id into v_expense_id from public.restaurant_operational_expense_schedule_occurrences
 where schedule_id=s.id and occurrence_date=p_occurrence_date;
 if v_expense_id is not null then return v_expense_id; end if;
 insert into public.restaurant_operational_expenses(tenant_id,property_id,location_id,category_id,description,amount,currency,incurred_on)
 values(s.tenant_id,s.property_id,s.location_id,s.category_id,s.description,s.amount,s.currency,p_occurrence_date)
 returning id into v_expense_id;
 insert into public.restaurant_operational_expense_schedule_occurrences(tenant_id,schedule_id,occurrence_date,expense_id)
 values(s.tenant_id,s.id,p_occurrence_date,v_expense_id);
 v_next:=case s.cadence when 'weekly' then (p_occurrence_date+7) when 'monthly' then (p_occurrence_date+interval '1 month')::date when 'quarterly' then (p_occurrence_date+interval '3 months')::date when 'annually' then (p_occurrence_date+interval '1 year')::date end;
 update public.restaurant_operational_expense_schedules set next_occurrence=v_next where id=s.id;
 return v_expense_id;
end $$;
revoke all on function public.restaurant_generate_scheduled_expense(uuid,date) from public,anon;
grant execute on function public.restaurant_generate_scheduled_expense(uuid,date) to authenticated,service_role;

create or replace function public.restaurant_commit_expense_allocations(p_expense_id uuid,p_allocations jsonb,p_unallocated_reason text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare e public.restaurant_operational_expenses%rowtype; a numeric(14,2); u numeric(14,2); r jsonb; n integer:=0;
begin
 if jsonb_typeof(p_allocations)<>'array' then raise exception 'Allocations must be an array'; end if;
 select * into e from public.restaurant_operational_expenses where id=p_expense_id for update;
 if not found then raise exception 'Expense not found'; end if;
 if e.approval_status<>'approved' then raise exception 'Only approved expenses can be allocated'; end if;
 if not public.restaurant_can_write_scoped(e.tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],e.property_id) then raise exception 'Not authorized'; end if;
 perform pg_advisory_xact_lock(hashtextextended(e.tenant_id::text||':expense:'||p_expense_id::text,0));
 if exists(select 1 from public.restaurant_cost_allocations where tenant_id=e.tenant_id and source_type='operational_expense' and source_id=p_expense_id)
 or exists(select 1 from public.restaurant_cost_allocation_exceptions where tenant_id=e.tenant_id and source_type='operational_expense' and source_id=p_expense_id) then raise exception 'Expense already allocated'; end if;
 select coalesce(sum((x->>'amount')::numeric),0) into a from jsonb_array_elements(p_allocations) x;
 u:=e.amount-a;
 if a<0 or u<0 then raise exception 'Allocation exceeds source amount'; end if;
 if u>0 and nullif(trim(p_unallocated_reason),'') is null then raise exception 'Unallocated remainder requires reason'; end if;
 for r in select value from jsonb_array_elements(p_allocations) loop
  if (r->>'amount')::numeric<=0 or round((r->>'amount')::numeric,2)<>(r->>'amount')::numeric or r->>'currency'<>e.currency then raise exception 'Invalid allocation amount or currency'; end if;
  if coalesce(r->>'allocation_method','') not in ('direct','approved_rule','activity_driver','manual') then raise exception 'Invalid allocation method'; end if;
  if not exists(select 1 from public.restaurant_properties p where p.id=(r->>'property_id')::uuid and p.tenant_id=e.tenant_id) then raise exception 'Allocation target property is outside expense tenant'; end if;
  if nullif(r->>'location_id','') is not null and not exists(select 1 from public.restaurant_locations l where l.id=(r->>'location_id')::uuid and l.tenant_id=e.tenant_id and l.property_id=(r->>'property_id')::uuid) then raise exception 'Allocation target location does not belong to target property'; end if;
  if not public.restaurant_can_write_scoped(e.tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],(r->>'property_id')::uuid) then raise exception 'Not authorized for target property'; end if;
  if r->>'allocation_method'='direct' then
   if e.property_id is null or (r->>'property_id')::uuid<>e.property_id
      or (e.location_id is not null and nullif(r->>'location_id','')::uuid<>e.location_id) then
     raise exception 'Direct allocation must preserve source property and location attribution';
   end if;
  end if;
  if r->>'allocation_method'='approved_rule' and not exists(
    select 1 from public.restaurant_cost_allocation_rules ar
    where ar.id=(r->>'rule_id')::uuid and ar.tenant_id=e.tenant_id and ar.status='approved'
      and ar.currency=e.currency and ar.effective_from<=e.incurred_on
      and (ar.effective_to is null or ar.effective_to>=e.incurred_on)
      and ar.version=(r->>'rule_version')::integer
      and exists(select 1 from jsonb_array_elements(ar.targets) t
        where t->>'property_id'=r->>'property_id'
          and coalesce(t->>'location_id','')=coalesce(r->>'location_id',''))
  ) then raise exception 'Allocation rule is not approved, effective or applicable to target'; end if;
  if r->>'allocation_method'='approved_rule' then
    if (select count(*) from jsonb_array_elements(p_allocations)) <>
       (select jsonb_array_length(ar.targets) from public.restaurant_cost_allocation_rules ar where ar.id=(r->>'rule_id')::uuid) then
      raise exception 'Approved rule allocation must include every configured target exactly once';
    end if;
    if exists(
      select 1 from jsonb_array_elements(p_allocations) x
      where x->>'rule_id'=r->>'rule_id'
      group by x->>'property_id',coalesce(x->>'location_id','')
      having count(*)>1
    ) then raise exception 'Duplicate approved-rule allocation target'; end if;
    if abs((r->>'amount')::numeric - round(e.amount *
      (select (t->>'weight')::numeric / nullif((select sum((v->>'weight')::numeric) from jsonb_array_elements(ar.targets) v),0)
       from jsonb_array_elements(ar.targets) t
       where t->>'property_id'=r->>'property_id' and coalesce(t->>'location_id','')=coalesce(r->>'location_id','')),2)) > 0.01 then
      raise exception 'Approved-rule allocation amount does not match configured weight';
    end if;
  end if;
  if r->>'allocation_method'='manual' and nullif(r->>'approved_by','')::uuid is distinct from auth.uid() then raise exception 'Manual allocation must be approved by the acting user'; end if;
  insert into public.restaurant_cost_allocations(tenant_id,source_type,source_id,property_id,location_id,currency,period_start,amount,allocation_method,rule_id,rule_version,approved_by)
  values(e.tenant_id,'operational_expense',p_expense_id,(r->>'property_id')::uuid,nullif(r->>'location_id','')::uuid,e.currency,date_trunc('month',e.incurred_on)::date,
   (r->>'amount')::numeric,r->>'allocation_method',nullif(r->>'rule_id','')::uuid,nullif(r->>'rule_version','')::integer,nullif(r->>'approved_by','')::uuid);
  n:=n+1;
 end loop;
 if u>0 then insert into public.restaurant_cost_allocation_exceptions(tenant_id,source_type,source_id,currency,period_start,source_amount,reason)
 values(e.tenant_id,'operational_expense',p_expense_id,e.currency,date_trunc('month',e.incurred_on)::date,u,p_unallocated_reason); end if;
 if round(a+u,2)<>e.amount then raise exception 'Allocation reconciliation failed'; end if;
 return jsonb_build_object('source_amount',e.amount,'allocated_amount',a,'unallocated_amount',u,'balanced',true,'allocation_count',n);
end $$;
revoke all on function public.restaurant_commit_expense_allocations(uuid,jsonb,text) from public,anon;
grant execute on function public.restaurant_commit_expense_allocations(uuid,jsonb,text) to authenticated,service_role;
