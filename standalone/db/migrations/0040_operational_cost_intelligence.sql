-- 0040 — Operational Cost Intelligence (P1/P2 persistence + P3 allocation)
-- Additive domain tables. Inventory consumption remains authoritative in
-- restaurant_stock_movements; this migration never duplicates that ledger.

create table if not exists public.restaurant_operational_expense_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  name text not null,
  category_key text not null,
  is_system boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, category_key)
);

create table if not exists public.restaurant_operational_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete restrict,
  location_id uuid references public.restaurant_locations(id) on delete restrict,
  category_id uuid not null references public.restaurant_operational_expense_categories(id) on delete restrict,
  supplier_id uuid,
  description text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  incurred_on date not null,
  due_on date,
  approval_status text not null default 'pending'
    check (approval_status in ('pending','approved','rejected')),
  approved_by uuid,
  approved_at timestamptz,
  rejection_reason text,
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','partially_paid','paid')),
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0 and paid_amount <= amount),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (property_id is not null or location_id is null),
  check ((approval_status <> 'approved') or (approved_by is not null and approved_at is not null)),
  check ((approval_status <> 'rejected') or rejection_reason is not null)
);

create table if not exists public.restaurant_operational_expense_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  expense_id uuid not null references public.restaurant_operational_expenses(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_at timestamptz not null default now(),
  reference text,
  recorded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_operational_expense_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete restrict,
  location_id uuid references public.restaurant_locations(id) on delete restrict,
  category_id uuid not null references public.restaurant_operational_expense_categories(id) on delete restrict,
  description text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  cadence text not null check (cadence in ('weekly','monthly','quarterly','annually')),
  next_occurrence date not null,
  active boolean not null default true,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_cost_allocation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from date not null,
  effective_to date,
  version integer not null check (version > 0),
  targets jsonb not null check (jsonb_typeof(targets) = 'array' and jsonb_array_length(targets) > 0),
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, name, version),
  check (effective_to is null or effective_to >= effective_from),
  check ((status <> 'approved') or (approved_by is not null and approved_at is not null))
);

create table if not exists public.restaurant_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  source_type text not null check (source_type in ('operational_expense','operational_consumption')),
  source_id uuid not null,
  property_id uuid not null references public.restaurant_properties(id) on delete restrict,
  location_id uuid references public.restaurant_locations(id) on delete restrict,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  period_start date not null,
  amount numeric(14,2) not null check (amount > 0),
  allocation_method text not null check (allocation_method in ('direct','approved_rule','activity_driver','manual')),
  rule_id uuid references public.restaurant_cost_allocation_rules(id) on delete restrict,
  rule_version integer,
  approved_by uuid,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  check ((allocation_method = 'approved_rule') = (rule_id is not null)),
  check ((allocation_method <> 'manual') or approved_by is not null)
);

create table if not exists public.restaurant_cost_allocation_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  source_type text not null check (source_type in ('operational_expense','operational_consumption')),
  source_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  period_start date not null,
  source_amount numeric(14,2) not null check (source_amount >= 0),
  reason text not null,
  resolved_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_type, source_id)
);

create unique index if not exists restaurant_cost_allocations_source_target_uq
  on public.restaurant_cost_allocations(tenant_id, source_type, source_id, property_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists restaurant_operational_expenses_scope_date_idx
  on public.restaurant_operational_expenses(tenant_id, property_id, location_id, incurred_on);
create index if not exists restaurant_cost_allocations_scope_period_idx
  on public.restaurant_cost_allocations(tenant_id, property_id, location_id, period_start);

-- Payment state is derived transactionally from payment rows, never trusted
-- from a caller-supplied status field.
create or replace function public.restaurant_sync_operational_expense_payment()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_total numeric(14,2); v_amount numeric(14,2);
begin
  select amount into v_amount from public.restaurant_operational_expenses
   where id = coalesce(new.expense_id, old.expense_id) for update;
  select coalesce(sum(amount),0) into v_total from public.restaurant_operational_expense_payments
   where expense_id = coalesce(new.expense_id, old.expense_id);
  if v_total > v_amount then raise exception 'Payments exceed expense amount'; end if;
  update public.restaurant_operational_expenses
     set paid_amount = v_total,
         payment_status = case when v_total = 0 then 'unpaid' when v_total = v_amount then 'paid' else 'partially_paid' end,
         updated_at = now()
   where id = coalesce(new.expense_id, old.expense_id);
  return coalesce(new, old);
end $$;

drop trigger if exists restaurant_operational_expense_payment_sync on public.restaurant_operational_expense_payments;
create trigger restaurant_operational_expense_payment_sync
 after insert or update or delete on public.restaurant_operational_expense_payments
 for each row execute function public.restaurant_sync_operational_expense_payment();

-- All new tables use the same tenant + property authorization contract as
-- the existing restaurant domain. NULL property is tenant-wide only for
-- members of that tenant (0029 fixed the earlier NULL-scope bypass).
do $$
declare t text;
begin
 foreach t in array array[
  'restaurant_operational_expense_categories','restaurant_operational_expenses',
  'restaurant_operational_expense_payments','restaurant_operational_expense_schedules',
  'restaurant_cost_allocation_rules','restaurant_cost_allocations',
  'restaurant_cost_allocation_exceptions'
 ] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('drop policy if exists %I on public.%I', t || '_read_scoped', t);
  execute format('drop policy if exists %I on public.%I', t || '_write_scoped', t);
  execute format('create policy %I on public.%I for select to authenticated using (public.restaurant_can_read_scoped(tenant_id, property_id))', t || '_read_scoped', t);
  -- Tables without property_id are tenant-scoped through the tenant membership
  -- check; property-bearing tables enforce property scope at the DB boundary.
 end loop;
end $$;

-- Categories and payment rows are tenant scoped; expense/schedule/allocation
-- tables with property_id require property-scoped writes.
drop policy if exists restaurant_operational_expense_categories_write_scoped on public.restaurant_operational_expense_categories;
create policy restaurant_operational_expense_categories_write_scoped on public.restaurant_operational_expense_categories
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null));

drop policy if exists restaurant_operational_expenses_write_scoped on public.restaurant_operational_expenses;
create policy restaurant_operational_expenses_write_scoped on public.restaurant_operational_expenses
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id));

drop policy if exists restaurant_operational_expense_payments_write_scoped on public.restaurant_operational_expense_payments;
create policy restaurant_operational_expense_payments_write_scoped on public.restaurant_operational_expense_payments
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], (select e.property_id from public.restaurant_operational_expenses e where e.id = expense_id)))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], (select e.property_id from public.restaurant_operational_expenses e where e.id = expense_id)));

drop policy if exists restaurant_operational_expense_schedules_write_scoped on public.restaurant_operational_expense_schedules;
create policy restaurant_operational_expense_schedules_write_scoped on public.restaurant_operational_expense_schedules
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id));

drop policy if exists restaurant_cost_allocation_rules_write_scoped on public.restaurant_cost_allocation_rules;
create policy restaurant_cost_allocation_rules_write_scoped on public.restaurant_cost_allocation_rules
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null));

drop policy if exists restaurant_cost_allocations_write_scoped on public.restaurant_cost_allocations;
create policy restaurant_cost_allocations_write_scoped on public.restaurant_cost_allocations
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], property_id));

drop policy if exists restaurant_cost_allocation_exceptions_write_scoped on public.restaurant_cost_allocation_exceptions;
create policy restaurant_cost_allocation_exceptions_write_scoped on public.restaurant_cost_allocation_exceptions
 for all to authenticated using (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null))
 with check (public.restaurant_can_write_scoped(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[], null));

grant select, insert, update, delete on public.restaurant_operational_expense_categories,
 public.restaurant_operational_expenses, public.restaurant_operational_expense_payments,
 public.restaurant_operational_expense_schedules, public.restaurant_cost_allocation_rules,
 public.restaurant_cost_allocations, public.restaurant_cost_allocation_exceptions to authenticated;
grant all on public.restaurant_operational_expense_categories,
 public.restaurant_operational_expenses, public.restaurant_operational_expense_payments,
 public.restaurant_operational_expense_schedules, public.restaurant_cost_allocation_rules,
 public.restaurant_cost_allocations, public.restaurant_cost_allocation_exceptions to service_role;
