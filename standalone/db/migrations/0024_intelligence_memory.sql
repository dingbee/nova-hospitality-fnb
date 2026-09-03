-- I15 "NOVA MEMORY & OPERATING AGENT"
--
-- intelligence_memory / intelligence_feedback are referenced by the
-- Intelligence Core's existing memory.server.ts (remember/recall/
-- reviewMemory/submitFeedback), whose contracts (scope/memory_tier/
-- confidence/source/status vocabulary) were already designed in an
-- earlier phase — but the tables themselves were never migrated. Every
-- call site already wraps its call in try/catch expecting exactly this
-- ("intelligence_memory not yet built"). This migration creates them,
-- reusing that existing column/status/tier design verbatim, and adds two
-- ADDITIVE, nullable columns (tenant_id, user_id) the generic platform
-- code never needed but restaurant-tenant isolation and personal-vs-
-- restaurant memory genuinely require (see the I15 architectural
-- verdict). Nothing about the existing generic remember()/recall() call
-- shape changes; restaurant code writes/reads these same tables through
-- its own new, tenant-RBAC-aware server module instead of the generic
-- Intel Core wrapper, whose assertIntelRead/assertIntelDecide is a
-- platform-wide permission with no restaurant tenant-membership check.

create table if not exists public.intelligence_memory (
  id uuid primary key default gen_random_uuid(),
  -- "guest"/"reservation"/"room"/"property"/"module"/"global" are the
  -- pre-existing hospitality-platform scopes (INTEL_MEMORY_SCOPES).
  -- "tenant"/"user" are added for restaurant staff memory: tenant-level
  -- operating preferences vs one staff member's personal preferences.
  scope text not null check (scope in ('guest','reservation','room','module','property','global','tenant','user')),
  scope_id uuid,
  module text check (module in ('pms','booking','guest','revenue','marketing','restaurant','operations','finance','content','platform')),
  tenant_id uuid references public.restaurant_tenants(id) on delete cascade,
  user_id uuid,
  memory_key text not null,
  memory_value text not null,
  memory_type text not null default 'fact',
  -- observed (a fact), learned (a repeated pattern derived from evidence),
  -- strategic (an explicit, durable preference/policy) — see spec section 3-4.
  memory_tier text not null default 'observed' check (memory_tier in ('observed','learned','strategic')),
  confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  -- provenance (spec section 6): who/what asserted this memory.
  source text not null default 'system' check (source in ('user_stated','system_observed','decision','action','verified_outcome','admin_configured','inferred','decision_engine','system')),
  source_event_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new','reviewing','accepted','dismissed','expired','superseded')),
  expires_at timestamptz,
  last_used_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists intelligence_memory_scope_idx on public.intelligence_memory (scope, scope_id, memory_key);
create index if not exists intelligence_memory_tenant_idx on public.intelligence_memory (tenant_id, user_id, memory_key) where tenant_id is not null;
create index if not exists intelligence_memory_status_idx on public.intelligence_memory (tenant_id, status);

alter table public.intelligence_memory enable row level security;

-- Tenant-level memory (user_id null) is readable by any tenant member;
-- personal memory (user_id set) is readable only by its own owner —
-- never another staff member, even a manager (spec section 40).
create policy "intelligence memory readable by tenant/owner"
  on public.intelligence_memory for select
  using (
    tenant_id is null
    or (public.restaurant_can_read(tenant_id) and (user_id is null or user_id = auth.uid()))
  );

-- Personal memory: the owning user may write their own row (any tenant
-- member, no elevated role required — remembering your own preference is
-- not a governance action). Tenant-level memory (user_id null) requires
-- the same managerial capability set intelligence_decisions already uses.
create policy "intelligence memory writable by tenant/owner"
  on public.intelligence_memory for insert
  with check (
    tenant_id is null
    or (user_id is not null and user_id = auth.uid() and public.restaurant_can_read(tenant_id))
    or (user_id is null and public.restaurant_can_manage_intelligence(tenant_id))
  );

create policy "intelligence memory updatable by tenant/owner"
  on public.intelligence_memory for update
  using (
    tenant_id is null
    or (user_id is not null and user_id = auth.uid() and public.restaurant_can_read(tenant_id))
    or (user_id is null and public.restaurant_can_manage_intelligence(tenant_id))
  )
  with check (
    tenant_id is null
    or (user_id is not null and user_id = auth.uid() and public.restaurant_can_read(tenant_id))
    or (user_id is null and public.restaurant_can_manage_intelligence(tenant_id))
  );

create table if not exists public.intelligence_feedback (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('insight','recommendation','prediction','action','memory')),
  subject_id uuid not null,
  module text check (module in ('pms','booking','guest','revenue','marketing','restaurant','operations','finance','content','platform')),
  tenant_id uuid references public.restaurant_tenants(id) on delete cascade,
  stage text check (stage in ('observe','understand','reason','recommend','act','learn')),
  rating int check (rating between 1 and 5),
  useful boolean,
  correction text,
  comment text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists intelligence_feedback_subject_idx on public.intelligence_feedback (subject_type, subject_id);
create index if not exists intelligence_feedback_tenant_idx on public.intelligence_feedback (tenant_id, created_at desc);

alter table public.intelligence_feedback enable row level security;

create policy "intelligence feedback readable by tenant"
  on public.intelligence_feedback for select
  using (tenant_id is null or public.restaurant_can_read(tenant_id));

-- Any tenant member may leave feedback on their own interactions —
-- feedback never carries authority, so no elevated role is required.
create policy "intelligence feedback writable by tenant member"
  on public.intelligence_feedback for insert
  with check (tenant_id is null or public.restaurant_can_read(tenant_id));
