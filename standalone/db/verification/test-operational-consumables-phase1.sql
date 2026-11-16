\set ON_ERROR_STOP on
begin;
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$ begin create type public.restaurant_role as enum('owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender','inventory_manager','purchasing_officer','accountant','viewer'); exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.restaurant_tenants(id uuid primary key);
create table public.restaurant_properties(id uuid primary key,tenant_id uuid references public.restaurant_tenants(id));
create table public.restaurant_locations(id uuid primary key,tenant_id uuid references public.restaurant_tenants(id),property_id uuid references public.restaurant_properties(id));
create table public.restaurant_inventory_units(id uuid primary key);
create table public.restaurant_inventory_items(id uuid primary key,tenant_id uuid references public.restaurant_tenants(id),property_id uuid references public.restaurant_properties(id));
create table public.restaurant_orders(id uuid primary key,tenant_id uuid references public.restaurant_tenants(id));
create table public.restaurant_order_items(id uuid primary key,tenant_id uuid references public.restaurant_tenants(id),order_id uuid references public.restaurant_orders(id));
create table public.restaurant_stock_movements(
 id uuid primary key,tenant_id uuid references public.restaurant_tenants(id),property_id uuid,location_id uuid,
 movement_type text,inventory_item_id uuid references public.restaurant_inventory_items(id),unit_id uuid,
 quantity numeric(14,4),unit_cost numeric(14,4),total_cost numeric(14,4),currency text,
 reference_type text,reference_id uuid,order_item_id uuid,occurred_at timestamptz default now()
);
create table public.restaurant_members(tenant_id uuid,user_id uuid,role public.restaurant_role,property_id uuid);
create or replace function public.restaurant_can_read_scoped(_tenant_id uuid,_property_id uuid) returns boolean language sql stable as $$
 select exists(select 1 from public.restaurant_members m where m.tenant_id=_tenant_id and m.user_id=auth.uid()
 and (_property_id is null or m.property_id is null or m.property_id=_property_id))
$$;
create or replace function public.restaurant_can_write_scoped(_tenant_id uuid,_roles public.restaurant_role[],_property_id uuid) returns boolean language sql stable as $$
 select exists(select 1 from public.restaurant_members m where m.tenant_id=_tenant_id and m.user_id=auth.uid()
 and m.role=any(_roles) and (_property_id is null or m.property_id is null or m.property_id=_property_id))
$$;
grant usage on schema auth to authenticated;
grant select on public.restaurant_members to authenticated;
\ir ../migrations/0112_operational_consumables_phase1.sql
insert into public.restaurant_tenants values('10000000-0000-0000-0000-000000000001');
insert into public.restaurant_properties values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
insert into public.restaurant_locations values('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
insert into public.restaurant_inventory_items values('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
insert into public.restaurant_orders values('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
insert into public.restaurant_order_items values('70000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');
insert into public.restaurant_members values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','owner',null);
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
insert into public.restaurant_consumption_profiles(tenant_id,property_id,name,cost_class)
values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Guest service supplies','service_consumable');
insert into public.restaurant_consumption_rules(tenant_id,profile_id,inventory_item_id,quantity_per_cover)
select '10000000-0000-0000-0000-000000000001',p.id,'50000000-0000-0000-0000-000000000001',1
from public.restaurant_consumption_profiles p where p.name='Guest service supplies';
insert into public.restaurant_stock_movements(
 id,tenant_id,property_id,location_id,movement_type,inventory_item_id,quantity,unit_cost,total_cost,currency,
 reference_type,reference_id,order_item_id,occurred_at
) values(
 '80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
 'consumption','50000000-0000-0000-0000-000000000001',-2,475,950,'TZS','restaurant_order',
 '60000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',now()
);
do $$ begin
 if (select count(*) from public.restaurant_consumption_events)<>1 then raise exception 'Service consumable stock movement was not classified'; end if;
 if not exists(select 1 from public.restaurant_consumption_events where total_cost=950 and currency='TZS' and cost_class='service_consumable') then raise exception 'Consumable event lost source cost or currency'; end if;
end $$;
set local role authenticated;
do $$ begin
 if (select count(*) from public.restaurant_consumption_events)<>1 then raise exception 'Scoped consumption event read failed'; end if;
end $$;
reset role;
rollback;
