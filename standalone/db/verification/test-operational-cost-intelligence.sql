\set ON_ERROR_STOP on
begin;
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$ begin create type public.restaurant_role as enum('owner','general_manager','restaurant_manager','accountant'); exception when duplicate_object then null; end $$;
create table public.restaurant_tenants(id uuid primary key);
create table public.restaurant_properties(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id));
create table public.restaurant_locations(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id),property_id uuid references public.restaurant_properties(id));
create table public.restaurant_members(tenant_id uuid,user_id uuid,role public.restaurant_role,property_id uuid);
create table public.restaurant_stock_movements(
 id uuid primary key,tenant_id uuid not null,property_id uuid,location_id uuid,movement_type text not null,
 total_cost numeric(14,2) not null,currency text not null,occurred_at timestamptz not null
);

create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create or replace function public.restaurant_can_read_scoped(_tenant_id uuid,_property_id uuid) returns boolean language sql stable as $$
 select exists(select 1 from public.restaurant_members m where m.tenant_id=_tenant_id and m.user_id=auth.uid()
 and (_property_id is null or m.property_id is null or m.property_id=_property_id))
$$;
create or replace function public.restaurant_can_write_scoped(_tenant_id uuid,_roles public.restaurant_role[],_property_id uuid) returns boolean language sql stable as $$
 select exists(select 1 from public.restaurant_members m where m.tenant_id=_tenant_id and m.user_id=auth.uid()
 and m.role=any(_roles) and (_property_id is null or m.property_id is null or m.property_id=_property_id))
$$;
create or replace function public.restaurant_is_platform_admin(uuid) returns boolean language sql stable as $$ select false $$;
create role authenticated;
create role anon;
create role service_role bypassrls;
\ir ../migrations/0040_operational_cost_intelligence.sql

insert into public.restaurant_tenants values
 ('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
insert into public.restaurant_properties values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002'),
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001');
insert into public.restaurant_members values
 ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','owner',null);
insert into public.restaurant_locations values
 ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
insert into public.restaurant_stock_movements values
 ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',null,'40000000-0000-0000-0000-000000000001','consumption',1250,'TZS',now());

-- Seed tenant B through service role so the authenticated tenant-A check proves isolation.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
set local role service_role;
insert into public.restaurant_operational_expense_categories(tenant_id,name,category_key)
 values('10000000-0000-0000-0000-000000000002','Utilities B','utilities-b');
insert into public.restaurant_operational_expenses(tenant_id,property_id,category_id,description,amount,currency,incurred_on)
 select '10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',id,'Tenant B electricity',50000,'TZS','2026-11-01'
 from public.restaurant_operational_expense_categories where category_key='utilities-b';
reset role;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
insert into public.restaurant_operational_expense_categories(tenant_id,name,category_key)
 values('10000000-0000-0000-0000-000000000001','Utilities','utilities');
insert into public.restaurant_operational_expenses(tenant_id,property_id,category_id,description,amount,currency,incurred_on)
 select '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',id,'Electricity',100000,'TZS','2026-11-01'
 from public.restaurant_operational_expense_categories where category_key='utilities';
-- Payment trigger derives paid state and rejects overpayment.
insert into public.restaurant_operational_expense_payments(tenant_id,expense_id,amount,currency)
 select tenant_id,id,40000,'TZS' from public.restaurant_operational_expenses where description='Electricity';
do $$ begin
 if (select payment_status from public.restaurant_operational_expenses where description='Electricity') <> 'partially_paid'
 then raise exception 'partial payment state not synchronized'; end if;
end $$;
insert into public.restaurant_operational_expense_payments(tenant_id,expense_id,amount,currency)
 select tenant_id,id,60000,'TZS' from public.restaurant_operational_expenses where description='Electricity';
do $$ begin
 if (select payment_status from public.restaurant_operational_expenses where description='Electricity') <> 'paid'
 then raise exception 'full payment state not synchronized'; end if;
end $$;
do $$ begin
 begin
  insert into public.restaurant_operational_expense_payments(tenant_id,expense_id,amount,currency)
   select tenant_id,id,1,'TZS' from public.restaurant_operational_expenses where description='Electricity';
  raise exception 'overpayment unexpectedly accepted';
 exception when others then
  if sqlerrm='overpayment unexpectedly accepted' then raise; end if;
 end;
end $$;
-- Authenticate the owner for the allocation RPC's authorization check.
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
-- Approve and atomically allocate the complete expense to its property.
update public.restaurant_operational_expenses set approval_status='approved',
 approved_by='30000000-0000-0000-0000-000000000001',approved_at=now() where description='Electricity';
select public.restaurant_commit_expense_allocations(
 (select id from public.restaurant_operational_expenses where description='Electricity'),
 '[{"property_id":"20000000-0000-0000-0000-000000000001","location_id":null,"amount":100000,"currency":"TZS","allocation_method":"direct"}]'::jsonb,
 null
);
do $$ begin
 if (select sum(amount) from public.restaurant_cost_allocations where source_type='operational_expense') <> 100000 then
  raise exception 'expense-to-allocation reconciliation failed'; end if;
 if exists(select 1 from public.restaurant_cost_allocation_exceptions) then
  raise exception 'fully allocated expense incorrectly left an exception'; end if;
end $$;
-- Idempotency: a second allocation attempt must fail rather than double count.
do $$ begin
 begin
  perform public.restaurant_commit_expense_allocations(
   (select id from public.restaurant_operational_expenses where description='Electricity'),
   '[{"property_id":"20000000-0000-0000-0000-000000000001","amount":100000,"currency":"TZS","allocation_method":"direct"}]'::jsonb,null);
  raise exception 'duplicate allocation unexpectedly accepted';
 exception when others then
  if sqlerrm='duplicate allocation unexpectedly accepted' then raise; end if;
 end;
end $$;
-- Recurring schedule idempotency: retries return one expense and advance once.
insert into public.restaurant_operational_expense_schedules(tenant_id,property_id,category_id,description,amount,currency,cadence,next_occurrence)
select '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',id,'Monthly rent',250000,'TZS','monthly',date '2026-11-15'
from public.restaurant_operational_expense_categories where category_key='utilities';
select public.restaurant_generate_scheduled_expense((select id from public.restaurant_operational_expense_schedules where description='Monthly rent'),date '2026-11-15');
select public.restaurant_generate_scheduled_expense((select id from public.restaurant_operational_expense_schedules where description='Monthly rent'),date '2026-11-15');
do $ begin
 if (select count(*) from public.restaurant_operational_expenses where description='Monthly rent')<>1 then raise exception 'Recurring schedule generated duplicate expenses'; end if;
 if (select next_occurrence from public.restaurant_operational_expense_schedules where description='Monthly rent')<>date '2026-12-15' then raise exception 'Recurring schedule did not advance exactly once'; end if;
end $;
-- Approved hybrid rules must match their versioned target weights exactly to minor-unit tolerance.
insert into public.restaurant_operational_expenses(tenant_id,category_id,description,amount,currency,incurred_on)
select '10000000-0000-0000-0000-000000000001',id,'Shared utilities',100000,'TZS',date '2026-11-01'
from public.restaurant_operational_expense_categories where category_key='utilities';
insert into public.restaurant_cost_allocation_rules(tenant_id,name,currency,effective_from,version,targets,status,approved_by,approved_at)
values('10000000-0000-0000-0000-000000000001','Utilities 60/40','TZS',date '2026-01-01',1,
'[{"property_id":"20000000-0000-0000-0000-000000000001","location_id":null,"weight":60},{"property_id":"20000000-0000-0000-0000-000000000003","location_id":null,"weight":40}]',
'approved','30000000-0000-0000-0000-000000000001',now());
update public.restaurant_operational_expenses set approval_status='approved',approved_by='30000000-0000-0000-0000-000000000001',approved_at=now() where description='Shared utilities';
select public.restaurant_commit_expense_allocations(
 (select id from public.restaurant_operational_expenses where description='Shared utilities'),
 jsonb_build_array(
  jsonb_build_object('property_id','20000000-0000-0000-0000-000000000001','amount',60000,'currency','TZS','allocation_method','approved_rule','rule_id',(select id from public.restaurant_cost_allocation_rules where name='Utilities 60/40'),'rule_version',1),
  jsonb_build_object('property_id','20000000-0000-0000-0000-000000000003','amount',40000,'currency','TZS','allocation_method','approved_rule','rule_id',(select id from public.restaurant_cost_allocation_rules where name='Utilities 60/40'),'rule_version',1)
 ),null
);
do $ begin
 if (select sum(amount) from public.restaurant_cost_allocations where source_id=(select id from public.restaurant_operational_expenses where description='Shared utilities'))<>100000 then raise exception 'Approved rule allocation did not reconcile'; end if;
end $;
-- Existing stock movement remains the source ledger; allocation is a scoped cost projection.
select public.restaurant_commit_consumption_allocation('50000000-0000-0000-0000-000000000001',null);
do $ begin
 if (select sum(amount) from public.restaurant_cost_allocations where source_type='operational_consumption' and source_id='50000000-0000-0000-0000-000000000001')<>1250 then raise exception 'Consumption allocation did not reconcile'; end if;
end $;
-- Tenant/property-scoped RLS: user from tenant A cannot read tenant B.
set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
do $$ begin
 if (select count(*) from public.restaurant_operational_expenses) <> 3 then
  raise exception 'tenant member should see exactly own tenant expense';
 end if;
end $$;
reset role;
rollback;
