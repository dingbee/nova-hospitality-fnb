-- Phase 5: reproducible operational profitability reporting snapshots.
-- Reporting projection only; operational source ledgers remain authoritative.
create table if not exists public.restaurant_operational_profitability_snapshots (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete set null,
 location_id uuid references public.restaurant_locations(id) on delete set null,
 period_start date not null,
 period_end date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 gross_sales numeric(14,2) not null default 0,
 discounts numeric(14,2) not null default 0,
 refunds numeric(14,2) not null default 0,
 sales_adjustments numeric(14,2) not null default 0,
 tax_collected numeric(14,2) not null default 0,
 net_sales numeric(14,2) not null default 0,
 recipe_cogs numeric(14,2) not null default 0,
 service_consumables numeric(14,2) not null default 0,
 other_direct_variable_costs numeric(14,2) not null default 0,
 direct_variable_costs numeric(14,2) not null default 0,
 contribution numeric(14,2) not null default 0,
 allocated_operating_expenses numeric(14,2) not null default 0,
 unallocated_operating_expenses numeric(14,2) not null default 0,
 operating_profit numeric(14,2) not null default 0,
 contribution_margin_percent numeric(6,2),
 operating_margin_percent numeric(6,2),
 confidence_state text not null check(confidence_state in ('fully_reconciled','partially_reconciled','estimated','pending_expense_verification','unallocated_costs_present','incomplete_source_data')),
 source_counts jsonb not null default '{}'::jsonb check(jsonb_typeof(source_counts)='object'),
 source_references jsonb not null default '{}'::jsonb check(jsonb_typeof(source_references)='object'),
 calculation_version text not null,
 computed_by uuid references auth.users(id) on delete set null,
 computed_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 check(period_end>=period_start),
 check(gross_sales>=0 and discounts>=0 and refunds>=0 and sales_adjustments>=0 and tax_collected>=0),
 check(recipe_cogs>=0 and service_consumables>=0 and other_direct_variable_costs>=0),
 check(allocated_operating_expenses>=0 and unallocated_operating_expenses>=0)
);
create index if not exists restaurant_operational_profitability_period_idx
 on public.restaurant_operational_profitability_snapshots(tenant_id,property_id,location_id,period_start desc,computed_at desc);
create table if not exists public.restaurant_operational_profitability_dimensions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 snapshot_id uuid not null references public.restaurant_operational_profitability_snapshots(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete set null,
 location_id uuid references public.restaurant_locations(id) on delete set null,
 dimension_type text not null check(dimension_type in ('menu_item','channel','outlet','property')),
 dimension_key text not null,
 dimension_name text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 net_sales numeric(14,2) not null default 0,
 direct_variable_costs numeric(14,2) not null default 0,
 contribution numeric(14,2) not null default 0,
 allocated_operating_expenses numeric(14,2) not null default 0,
 operating_profit numeric(14,2) not null default 0,
 source_references jsonb not null default '[]'::jsonb check(jsonb_typeof(source_references)='array'),
 created_at timestamptz not null default now(),
 unique(snapshot_id,dimension_type,dimension_key)
);
create index if not exists restaurant_operational_profitability_dimensions_snapshot_idx
 on public.restaurant_operational_profitability_dimensions(snapshot_id,dimension_type);
alter table public.restaurant_operational_profitability_snapshots enable row level security;
alter table public.restaurant_operational_profitability_dimensions enable row level security;
drop policy if exists restaurant_operational_profitability_snapshots_read on public.restaurant_operational_profitability_snapshots;
create policy restaurant_operational_profitability_snapshots_read on public.restaurant_operational_profitability_snapshots
 for select to authenticated using(
  public.restaurant_can_read_scoped(tenant_id,property_id)
  and public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)
 );
drop policy if exists restaurant_operational_profitability_snapshots_write on public.restaurant_operational_profitability_snapshots;
create policy restaurant_operational_profitability_snapshots_write on public.restaurant_operational_profitability_snapshots
 for all to authenticated
 using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id))
 with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
drop policy if exists restaurant_operational_profitability_dimensions_read on public.restaurant_operational_profitability_dimensions;
create policy restaurant_operational_profitability_dimensions_read on public.restaurant_operational_profitability_dimensions
 for select to authenticated using(
  public.restaurant_can_read_scoped(tenant_id,property_id)
  and public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)
 );
drop policy if exists restaurant_operational_profitability_dimensions_write on public.restaurant_operational_profitability_dimensions;
create policy restaurant_operational_profitability_dimensions_write on public.restaurant_operational_profitability_dimensions
 for all to authenticated
 using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id))
 with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
grant select,insert,update,delete on public.restaurant_operational_profitability_snapshots,public.restaurant_operational_profitability_dimensions to authenticated;
grant all on public.restaurant_operational_profitability_snapshots,public.restaurant_operational_profitability_dimensions to service_role;
