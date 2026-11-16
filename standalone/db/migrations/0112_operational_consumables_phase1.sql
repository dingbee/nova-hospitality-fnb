-- Phase 1 recovery: service consumables are classified from the existing stock ledger.
-- This projection never creates a second stock movement or changes inventory balances.
create table if not exists public.restaurant_consumption_profiles (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete cascade,
 location_id uuid references public.restaurant_locations(id) on delete cascade,
 name text not null,
 cost_class text not null check(cost_class in ('service_consumable','other_direct_variable')),
 active boolean not null default true,
 effective_from date not null default current_date,
 effective_to date,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 check(effective_to is null or effective_to>=effective_from),
 check(property_id is not null or location_id is null),
 unique(tenant_id,property_id,location_id,name)
);
create table if not exists public.restaurant_consumption_rules (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 profile_id uuid not null references public.restaurant_consumption_profiles(id) on delete cascade,
 inventory_item_id uuid not null references public.restaurant_inventory_items(id) on delete cascade,
 unit_id uuid references public.restaurant_inventory_units(id) on delete set null,
 quantity_per_cover numeric(14,4),
 active boolean not null default true,
 effective_from date not null default current_date,
 effective_to date,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 check(quantity_per_cover is null or quantity_per_cover>0),
 check(effective_to is null or effective_to>=effective_from),
 unique(profile_id,inventory_item_id)
);
create table if not exists public.restaurant_consumption_events (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete set null,
 location_id uuid references public.restaurant_locations(id) on delete set null,
 profile_id uuid not null references public.restaurant_consumption_profiles(id) on delete restrict,
 rule_id uuid not null references public.restaurant_consumption_rules(id) on delete restrict,
 stock_movement_id uuid not null references public.restaurant_stock_movements(id) on delete restrict,
 order_id uuid references public.restaurant_orders(id) on delete set null,
 order_item_id uuid references public.restaurant_order_items(id) on delete set null,
 inventory_item_id uuid not null references public.restaurant_inventory_items(id) on delete restrict,
 cost_class text not null check(cost_class in ('service_consumable','other_direct_variable')),
 quantity numeric(14,4) not null check(quantity>=0),
 unit_cost numeric(14,4) not null check(unit_cost>=0),
 total_cost numeric(14,4) not null check(total_cost>=0),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 occurred_at timestamptz not null,
 created_at timestamptz not null default now(),
 unique(tenant_id,stock_movement_id)
);
create index if not exists restaurant_consumption_events_order_idx
 on public.restaurant_consumption_events(tenant_id,order_id,occurred_at);
create index if not exists restaurant_consumption_rules_item_idx
 on public.restaurant_consumption_rules(tenant_id,inventory_item_id,active);
alter table public.restaurant_consumption_profiles enable row level security;
alter table public.restaurant_consumption_rules enable row level security;
alter table public.restaurant_consumption_events enable row level security;
create policy restaurant_consumption_profiles_read on public.restaurant_consumption_profiles
 for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_consumption_profiles_write on public.restaurant_consumption_profiles
 for all to authenticated
 using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant']::restaurant_role[],property_id))
 with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_consumption_rules_read on public.restaurant_consumption_rules
 for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,(select p.property_id from public.restaurant_consumption_profiles p where p.id=profile_id)));
create policy restaurant_consumption_rules_write on public.restaurant_consumption_rules
 for all to authenticated
 using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant']::restaurant_role[],(select p.property_id from public.restaurant_consumption_profiles p where p.id=profile_id)))
 with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant']::restaurant_role[],(select p.property_id from public.restaurant_consumption_profiles p where p.id=profile_id)));
create policy restaurant_consumption_events_read on public.restaurant_consumption_events
 for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_consumption_events_write on public.restaurant_consumption_events
 for all to authenticated
 using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[],property_id))
 with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[],property_id));
grant select,insert,update,delete on public.restaurant_consumption_profiles,public.restaurant_consumption_rules,public.restaurant_consumption_events to authenticated;
grant all on public.restaurant_consumption_profiles,public.restaurant_consumption_rules,public.restaurant_consumption_events to service_role;

create or replace function public.restaurant_capture_operational_consumption()
returns trigger language plpgsql security invoker set search_path=public as $$
declare r record;
begin
 if new.movement_type::text not in ('consumption','wastage') or new.reference_type<>'restaurant_order' or new.reference_id is null then
  return new;
 end if;
 select p.id profile_id,p.cost_class,rr.id rule_id,rr.inventory_item_id
 into r
 from public.restaurant_consumption_rules rr
 join public.restaurant_consumption_profiles p on p.id=rr.profile_id and p.tenant_id=rr.tenant_id
 where rr.tenant_id=new.tenant_id and rr.inventory_item_id=new.inventory_item_id
  and rr.active and p.active
  and rr.effective_from<=new.occurred_at::date and (rr.effective_to is null or rr.effective_to>=new.occurred_at::date)
  and p.effective_from<=new.occurred_at::date and (p.effective_to is null or p.effective_to>=new.occurred_at::date)
  and (p.property_id is null or p.property_id=new.property_id)
  and (p.location_id is null or p.location_id=new.location_id)
 order by (p.location_id is not null) desc,(p.property_id is not null) desc,p.created_at desc
 limit 1;
 if not found then return new; end if;
 insert into public.restaurant_consumption_events(
  tenant_id,property_id,location_id,profile_id,rule_id,stock_movement_id,order_id,order_item_id,
  inventory_item_id,cost_class,quantity,unit_cost,total_cost,currency,occurred_at
 ) values(
  new.tenant_id,new.property_id,new.location_id,r.profile_id,r.rule_id,new.id,new.reference_id,new.order_item_id,
  new.inventory_item_id,r.cost_class,abs(new.quantity),new.unit_cost,new.total_cost,new.currency,new.occurred_at
 ) on conflict(tenant_id,stock_movement_id) do nothing;
 return new;
end $$;
drop trigger if exists restaurant_capture_operational_consumption on public.restaurant_stock_movements;
create trigger restaurant_capture_operational_consumption
 after insert on public.restaurant_stock_movements
 for each row execute function public.restaurant_capture_operational_consumption();
