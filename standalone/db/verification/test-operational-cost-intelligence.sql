\set ON_ERROR_STOP on
begin;
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$ begin create type public.restaurant_role as enum('owner','general_manager','restaurant_manager','accountant'); exception when duplicate_object then null; end $$;
create table public.restaurant_tenants(id uuid primary key);
create table public.restaurant_properties(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id));
create table public.restaurant_locations(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id),property_id uuid references public.restaurant_properties(id));
create table public.restaurant_members(tenant_id uuid,user_id uuid,role public.restaurant_role,property_id uuid);
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
create role service_role;
\ir ../migrations/0040_operational_cost_intelligence.sql

insert into public.restaurant_tenants values
 ('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
insert into public.restaurant_properties values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002');
insert into public.restaurant_members values
 ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','owner',null);
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
-- Approve and atomically allocate the complete expense to its property.
update public.restaurant_operational_expenses set approval_status='approved',
 approved_by='30000000-0000-0000-0000-000000000001',approved_at=now() where description='Electricity';
select public.restaurant_commit_expense_allocations(
 (select id from public.restaurant_operational_expenses where description='Electricity'),
 '[{"property_id":"20000000-0000-0000-0000-000000000001","location_id":null,"amount":100000,"currency":"TZS","allocation_method":"direct"}]'::jsonb,
 null
);
do $ begin
 if (select sum(amount) from public.restaurant_cost_allocations where source_type='operational_expense') <> 100000 then
  raise exception 'expense-to-allocation reconciliation failed'; end if;
 if exists(select 1 from public.restaurant_cost_allocation_exceptions) then
  raise exception 'fully allocated expense incorrectly left an exception'; end if;
end $;
-- Idempotency: a second allocation attempt must fail rather than double count.
do $ begin
 begin
  perform public.restaurant_commit_expense_allocations(
   (select id from public.restaurant_operational_expenses where description='Electricity'),
   '[{"property_id":"20000000-0000-0000-0000-000000000001","amount":100000,"currency":"TZS","allocation_method":"direct"}]'::jsonb,null);
  raise exception 'duplicate allocation unexpectedly accepted';
 exception when others then
  if sqlerrm='duplicate allocation unexpectedly accepted' then raise; end if;
 end;
end $;
-- Tenant/property-scoped RLS: user from tenant A cannot read tenant B.
set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
do $$ begin
 if (select count(*) from public.restaurant_operational_expenses) <> 1 then
  raise exception 'tenant member should see exactly own tenant expense';
 end if;
end $$;
reset role;
rollback;
