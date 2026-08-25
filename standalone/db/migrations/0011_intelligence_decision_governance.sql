-- Intelligence Core — decision/plan/action governance persistence.
--
-- restaurant/decisions/decisions.server.ts (candidate generation, live
-- since Phase 4) and intelligence/decisions/decision.server.ts (approval
-- governance, hardened for tenant scope in I2) have targeted these tables
-- since before I1. Per I2's finding, tenant identity was only ever meant
-- to travel inside the `context` JSONB column — not enforceable by RLS.
-- This migration gives each table the first-class restaurant_tenants
-- ownership I2 locked, matching intelligence_events (0010).
--
-- intelligence_plans / intelligence_plan_steps / intelligence_actions do
-- not carry their own tenant_id: a plan's tenant is entirely defined by
-- its owning decision (decision_id, now a real NOT NULL FK — actions
-- previously carried decision_id only inside payload JSONB, which is the
-- same anti-pattern I2 flagged for events; fixed here), so RLS joins back
-- to intelligence_decisions rather than denormalizing tenant_id onto every
-- child row.

create table public.intelligence_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  module text not null,
  domain text not null,
  decision_key text not null,
  title text not null,
  trigger text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'modified', 'executing', 'completed', 'failed', 'expired')),
  risk_level text not null default 'medium' check (risk_level in ('info', 'low', 'medium', 'high', 'critical')),
  confidence numeric not null default 0.5,
  requires_approval boolean not null default true,
  recommended_option_key text,
  options jsonb not null default '[]'::jsonb,
  criteria_weights jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '[]'::jsonb,
  reasoning jsonb not null default '{}'::jsonb,
  expected_outcomes jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  uncertainties jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  reasoning_sources jsonb not null default '[]'::jsonb,
  -- Retained for the business-context snapshot a decision was evaluated
  -- against (forecasts, prediction_keys, etc.) — not the authorization
  -- boundary. tenant_id above is.
  context jsonb not null default '{}'::jsonb,
  action_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  outcome jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, module, decision_key)
);

create index intelligence_decisions_tenant_idx on public.intelligence_decisions (tenant_id, created_at desc);

create table public.intelligence_plans (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.intelligence_decisions(id) on delete cascade,
  objective text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index intelligence_plans_decision_idx on public.intelligence_plans (decision_id);

create table public.intelligence_plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.intelligence_plans(id) on delete cascade,
  sequence integer not null,
  title text not null,
  objective text not null,
  module text not null,
  responsible_role text,
  depends_on integer,
  requires_approval boolean not null default false,
  expected_outcome text,
  status text not null default 'pending' check (status in ('pending', 'blocked', 'in_progress', 'done', 'skipped')),
  note text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index intelligence_plan_steps_plan_idx on public.intelligence_plan_steps (plan_id, sequence);

create table public.intelligence_actions (
  id uuid primary key default gen_random_uuid(),
  -- Was payload.decision_id only (I2's flagged pattern). A real FK is what
  -- lets RLS enforce tenant scope by joining back to the owning decision.
  decision_id uuid not null references public.intelligence_decisions(id) on delete cascade,
  module text not null,
  action_type text not null,
  title text,
  payload jsonb not null default '{}'::jsonb,
  automated boolean not null default false,
  requires_approval boolean not null default true,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  dedupe_key text unique,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  -- Populated by a future executor (I2's proposed → approved → queued →
  -- executing → executed/failed → verified lifecycle). Nothing writes
  -- these yet — no executor exists, and I3 does not build one.
  queued_at timestamptz,
  executing_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  verified_at timestamptz,
  verification_result jsonb,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index intelligence_actions_decision_idx on public.intelligence_actions (decision_id);

grant select, insert, update on public.intelligence_decisions, public.intelligence_plans,
  public.intelligence_plan_steps, public.intelligence_actions to authenticated;
grant all on public.intelligence_decisions, public.intelligence_plans,
  public.intelligence_plan_steps, public.intelligence_actions to service_role;

alter table public.intelligence_decisions enable row level security;
alter table public.intelligence_plans enable row level security;
alter table public.intelligence_plan_steps enable row level security;
alter table public.intelligence_actions enable row level security;

-- Same role set restaurant/core/permissions.ts already gates
-- "intelligence.read" behind (runRestaurantDecisionPass's existing
-- application-layer check) — RLS here is a matching backstop, not a new
-- policy decision.
-- (defined once, reused by every policy below via a helper predicate)
create or replace function public.restaurant_can_manage_intelligence(_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.restaurant_can_write(_tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'chef',
    'kitchen_manager', 'inventory_manager', 'purchasing_officer', 'accountant'
  ]::restaurant_role[]);
$$;

REVOKE EXECUTE ON FUNCTION public.restaurant_can_manage_intelligence(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_manage_intelligence(uuid) TO authenticated, service_role;

create policy "intelligence decisions readable by tenant"
  on public.intelligence_decisions for select to authenticated
  using (public.restaurant_can_read(tenant_id));
create policy "intelligence decisions writable by tenant"
  on public.intelligence_decisions for insert to authenticated
  with check (public.restaurant_can_manage_intelligence(tenant_id));
create policy "intelligence decisions updatable by tenant"
  on public.intelligence_decisions for update to authenticated
  using (public.restaurant_can_manage_intelligence(tenant_id))
  with check (public.restaurant_can_manage_intelligence(tenant_id));

create policy "intelligence plans readable by tenant"
  on public.intelligence_plans for select to authenticated
  using (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_read(d.tenant_id)
  ));
create policy "intelligence plans writable by tenant"
  on public.intelligence_plans for insert to authenticated
  with check (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ));
create policy "intelligence plans updatable by tenant"
  on public.intelligence_plans for update to authenticated
  using (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ))
  with check (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ));

create policy "intelligence plan steps readable by tenant"
  on public.intelligence_plan_steps for select to authenticated
  using (exists (
    select 1 from public.intelligence_plans p
    join public.intelligence_decisions d on d.id = p.decision_id
    where p.id = plan_id and public.restaurant_can_read(d.tenant_id)
  ));
create policy "intelligence plan steps writable by tenant"
  on public.intelligence_plan_steps for insert to authenticated
  with check (exists (
    select 1 from public.intelligence_plans p
    join public.intelligence_decisions d on d.id = p.decision_id
    where p.id = plan_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ));
create policy "intelligence plan steps updatable by tenant"
  on public.intelligence_plan_steps for update to authenticated
  using (exists (
    select 1 from public.intelligence_plans p
    join public.intelligence_decisions d on d.id = p.decision_id
    where p.id = plan_id and public.restaurant_can_read(d.tenant_id)
  ))
  with check (exists (
    select 1 from public.intelligence_plans p
    join public.intelligence_decisions d on d.id = p.decision_id
    where p.id = plan_id and public.restaurant_can_read(d.tenant_id)
  ));

create policy "intelligence actions readable by tenant"
  on public.intelligence_actions for select to authenticated
  using (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_read(d.tenant_id)
  ));
create policy "intelligence actions writable by tenant"
  on public.intelligence_actions for insert to authenticated
  with check (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ));
create policy "intelligence actions updatable by tenant"
  on public.intelligence_actions for update to authenticated
  using (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ))
  with check (exists (
    select 1 from public.intelligence_decisions d
    where d.id = decision_id and public.restaurant_can_manage_intelligence(d.tenant_id)
  ));
