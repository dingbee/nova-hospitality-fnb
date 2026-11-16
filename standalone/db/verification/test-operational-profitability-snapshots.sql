\set ON_ERROR_STOP on
begin;
create extension if not exists pgcrypto;
create schema if not exists auth;
create table auth.users(id uuid primary key);
do $$ begin create type public.restaurant_role as enum('owner','general_manager','restaurant_manager','accountant','chef'); exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.restaurant_tenants(id uuid primary key);
create table public.restaurant_properties(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id));
create table public.restaurant_locations(id uuid primary key,tenant_id uuid not null references public.restaurant_tenants(id),property_id uuid references public.restaurant_properties(id));
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
\ir ../migrations/0133_operational_profitability_snapshots.sql
insert into public.restaurant_tenants values('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
insert into public.restaurant_properties values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002');
insert into public.restaurant_members values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','accountant',null);
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
insert into public.restaurant_operational_profitability_snapshots(tenant_id,property_id,period_start,period_end,currency,net_sales,contribution,operating_profit,confidence_state,calculation_version)
values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','2026-11-01','2026-11-30','TZS',20000,12050,8050,'estimated','phase5-v1');
insert into public.restaurant_operational_profitability_dimensions(tenant_id,snapshot_id,property_id,dimension_type,dimension_key,dimension_name,currency,net_sales,direct_variable_costs,contribution,operating_profit)
select tenant_id,id,property_id,'menu_item','pilau','Pilau','TZS',20000,7950,12050,8050
from public.restaurant_operational_profitability_snapshots;
do $$ begin
 if (select count(*) from public.restaurant_operational_profitability_snapshots)<>1 then raise exception 'Snapshot persistence failed'; end if;
 if (select count(*) from public.restaurant_operational_profitability_dimensions)<>1 then raise exception 'Dimension persistence failed'; end if;
 if exists(select 1 from public.restaurant_operational_profitability_snapshots where currency<>'TZS') then raise exception 'Currency integrity failed'; end if;
end $$;
set local role authenticated;
do $$ begin
 if (select count(*) from public.restaurant_operational_profitability_snapshots)<>1 then raise exception 'Scoped accountant read failed'; end if;
 if exists(select 1 from public.restaurant_operational_profitability_snapshots where tenant_id='10000000-0000-0000-0000-000000000002') then raise exception 'Cross-tenant read isolation failed'; end if;
end $$;
reset role;
rollback;
