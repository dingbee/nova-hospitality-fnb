-- 0042 Cost Reconciliation and Variance Intelligence. Additive; source ledgers remain authoritative.
create table if not exists public.restaurant_cost_reconciliation_runs (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete cascade, period_start date not null, period_end date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), source_fingerprint text not null,
 status text not null default 'completed' check(status in ('running','completed','failed')),
 source_counts jsonb not null default '{}'::jsonb, limitations jsonb not null default '[]'::jsonb,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(), check(period_end>=period_start),
 unique nulls not distinct(tenant_id,property_id,period_start,period_end,currency,source_fingerprint));
create table if not exists public.restaurant_cost_reconciliation_lines (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 run_id uuid not null references public.restaurant_cost_reconciliation_runs(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete cascade, source_type text not null, source_id uuid not null,
 variance_kind text not null check(variance_kind in ('stock_quantity','purchase_price','operating_expense','allocation','data_integrity')),
 currency text not null check(currency ~ '^[A-Z]{3}$'), expected_amount numeric(18,4) not null,
 actual_amount numeric(18,4) not null, variance_amount numeric(18,4) not null, evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), unique(run_id,source_type,source_id,variance_kind));
create table if not exists public.restaurant_cost_variances (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete cascade,
 reconciliation_line_id uuid not null references public.restaurant_cost_reconciliation_lines(id) on delete cascade,
 severity text not null check(severity in ('info','low','medium','high','critical')),
 investigation_status text not null default 'detected' check(investigation_status in ('detected','under_investigation','awaiting_explanation','action_required','resolved','closed','reopened')),
 assigned_to uuid references auth.users(id) on delete set null, resolution_details text, resolved_at timestamptz,
 resolved_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(reconciliation_line_id));
create table if not exists public.restaurant_cost_variance_events (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 variance_id uuid not null references public.restaurant_cost_variances(id) on delete cascade, event_type text not null,
 previous_status text, new_status text, note text, actor_id uuid references auth.users(id) on delete set null, created_at timestamptz not null default now());
create table if not exists public.restaurant_cost_variance_evidence (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 variance_id uuid not null references public.restaurant_cost_variances(id) on delete cascade, evidence_type text not null,
 reference text not null, description text, created_by uuid not null default auth.uid(), created_at timestamptz not null default now());
create table if not exists public.restaurant_cost_variance_thresholds (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
 property_id uuid references public.restaurant_properties(id) on delete cascade, variance_kind text not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), threshold_amount numeric(18,4) not null check(threshold_amount>=0),
 enabled boolean not null default true, created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 unique nulls not distinct(tenant_id,property_id,variance_kind,currency));
create index if not exists restaurant_cost_reconciliation_runs_scope_idx on public.restaurant_cost_reconciliation_runs(tenant_id,property_id,period_start desc);
create index if not exists restaurant_cost_reconciliation_lines_run_idx on public.restaurant_cost_reconciliation_lines(tenant_id,run_id);
create index if not exists restaurant_cost_variances_scope_idx on public.restaurant_cost_variances(tenant_id,property_id,investigation_status,severity);
create index if not exists restaurant_cost_variance_events_case_idx on public.restaurant_cost_variance_events(tenant_id,variance_id,created_at desc);
do $$ declare t text; begin
 foreach t in array array['restaurant_cost_reconciliation_runs','restaurant_cost_reconciliation_lines','restaurant_cost_variances','restaurant_cost_variance_events','restaurant_cost_variance_evidence','restaurant_cost_variance_thresholds'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public, anon',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create policy restaurant_cost_reconciliation_runs_read on public.restaurant_cost_reconciliation_runs for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_cost_reconciliation_lines_read on public.restaurant_cost_reconciliation_lines for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_cost_variances_read on public.restaurant_cost_variances for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_cost_variance_events_read on public.restaurant_cost_variance_events for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,(select v.property_id from public.restaurant_cost_variances v where v.id=variance_id)));
create policy restaurant_cost_variance_evidence_read on public.restaurant_cost_variance_evidence for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,(select v.property_id from public.restaurant_cost_variances v where v.id=variance_id)));
create policy restaurant_cost_variance_thresholds_read on public.restaurant_cost_variance_thresholds for select to authenticated using(public.restaurant_can_read_scoped(tenant_id,property_id));
create policy restaurant_cost_variance_thresholds_write on public.restaurant_cost_variance_thresholds for all to authenticated using(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id)) with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
-- Execution writes are limited to costing-authorized operational roles and the exact property scope.
create policy restaurant_cost_reconciliation_runs_write on public.restaurant_cost_reconciliation_runs for insert to authenticated with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_cost_reconciliation_lines_write on public.restaurant_cost_reconciliation_lines for insert to authenticated with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_cost_variances_write on public.restaurant_cost_variances for insert to authenticated with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],property_id));
create policy restaurant_cost_variance_events_write on public.restaurant_cost_variance_events for insert to authenticated with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],(select v.property_id from public.restaurant_cost_variances v where v.id=variance_id)));
create policy restaurant_cost_variance_evidence_write on public.restaurant_cost_variance_evidence for insert to authenticated with check(public.restaurant_can_write_scoped(tenant_id,array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[],(select v.property_id from public.restaurant_cost_variances v where v.id=variance_id)));
grant insert on public.restaurant_cost_reconciliation_runs,public.restaurant_cost_reconciliation_lines,public.restaurant_cost_variances,public.restaurant_cost_variance_events,public.restaurant_cost_variance_evidence to authenticated;
grant update (investigation_status,assigned_to,resolution_details,resolved_at,resolved_by,updated_at) on public.restaurant_cost_variances to authenticated;
grant insert, update, delete on public.restaurant_cost_variance_thresholds to authenticated;