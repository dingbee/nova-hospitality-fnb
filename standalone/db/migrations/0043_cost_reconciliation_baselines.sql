-- 0043 Reconciliation source baselines. Additive; no operational source rows are changed.
alter table public.restaurant_cost_reconciliation_lines
  drop constraint if exists restaurant_cost_reconciliation_lines_variance_kind_check;
alter table public.restaurant_cost_reconciliation_lines
  add constraint restaurant_cost_reconciliation_lines_variance_kind_check
  check (variance_kind in ('stock_quantity','consumption_cost','purchase_price','operating_expense','allocation','data_integrity'));

create table if not exists public.restaurant_operational_cost_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid not null references public.restaurant_properties(id) on delete cascade,
  category_id uuid not null references public.restaurant_operational_expense_categories(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  budget_amount numeric(14,2) not null check(budget_amount > 0),
  status text not null default 'draft' check(status in ('draft','approved','retired')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(period_end >= period_start),
  check((status = 'approved') = (approved_by is not null and approved_at is not null)),
  unique(tenant_id,property_id,category_id,period_start,period_end,currency)
);
create index if not exists restaurant_operational_cost_budgets_scope_period_idx
  on public.restaurant_operational_cost_budgets(tenant_id,property_id,period_start,period_end,status);

alter table public.restaurant_operational_cost_budgets enable row level security;
revoke all on public.restaurant_operational_cost_budgets from public, anon;
grant select,insert,update on public.restaurant_operational_cost_budgets to authenticated;
grant all on public.restaurant_operational_cost_budgets to service_role;
create policy restaurant_operational_cost_budgets_read
  on public.restaurant_operational_cost_budgets for select to authenticated
  using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_operational_cost_budgets_write
  on public.restaurant_operational_cost_budgets for all to authenticated
  using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id))
  with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
