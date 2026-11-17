-- P02.2-P02.4 — LexiBite Demo Access (registration, verification, session, authorization).
--
-- Context (see docs/p02/README-nolmark-integration.md for the full contract):
-- Nolmark/Lovable, an untrusted external website, needs to hand a prospect a
-- controlled, individual, least-privilege demo session against the real
-- product rather than a shared admin/password. This migration adds exactly
-- two new tables plus one SECURITY DEFINER grant function — it does not
-- touch restaurant_tenants/properties/locations, does not add a new
-- role/permission system, and does not introduce a parallel tenancy model.
--
-- The canonical demo tenant already exists (migration 0039 — "LexiBite Demo
-- Restaurant" / "Kilimanjaro Grill" / "Kilimanjaro Grill West"); this
-- migration only adds the machinery to grant a verified visitor a
-- `restaurant_members` row on that *existing* tenant with the existing,
-- already-zero-write-capability 'viewer' role (see
-- src/modules/restaurant/core/permissions.ts — CAPABILITY_ROLES lists no
-- capability for 'viewer' at all, so this is genuinely least-privilege: a
-- demo visitor can read anything any tenant member can read via
-- restaurant_can_read/restaurant_can_read_scoped, and can write nothing
-- through the admin app). The one write surface a demo visitor can reach is
-- the pre-existing, already-public, already-safe guest self-order flow
-- (src/modules/restaurant/selforder/*), scoped by an unguessable table
-- session id exactly as it is for a real walk-in guest today.
--
-- The demo tenant/property/location ids are hardcoded literals inside the
-- grant function below, never a parameter — a caller can never redirect
-- this mechanism at an arbitrary tenant, and the role is always exactly
-- 'viewer', never client-supplied.

/* ---------------- Registration ---------------- */

create table public.lexibite_demo_registrations (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  work_email text not null,
  -- lower(trim(work_email)) — the uniqueness/lookup key. Kept as a separate
  -- column (rather than a functional unique index) so the normalization
  -- rule is visible in the schema and reusable from application code.
  work_email_normalized text not null,
  company text not null,
  job_role text not null,
  country text not null,
  phone text,
  source text not null default 'LEXIBITE_DEMO',
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'verified', 'session_active', 'error')),
  -- Set once the Supabase Auth user for this prospect exists. Nullable only
  -- for the brief window between insert and the admin.createUser/generateLink
  -- call in the same request.
  auth_user_id uuid references auth.users(id) on delete set null,
  ip_hash text,
  verification_sent_at timestamptz,
  verification_resend_count integer not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_email_normalized)
);

create index idx_lexibite_demo_registrations_auth_user
  on public.lexibite_demo_registrations(auth_user_id);

-- No anon/authenticated table access at all: registration is written by the
-- public HTTP endpoint using the service-role client (never RLS-bound,
-- never trusts a client-supplied user id), exactly like every other
-- pre-auth write in this codebase (there are none that go through RLS —
-- restaurant_bootstrap_tenant is post-auth). The one exception is a
-- visitor reading their own registration's status once they're
-- authenticated, which is genuinely useful for a "check your email" screen.
alter table public.lexibite_demo_registrations enable row level security;

create policy "lexibite_demo_registrations self read"
  on public.lexibite_demo_registrations for select
  to authenticated
  using (auth.uid() = auth_user_id);

revoke all on public.lexibite_demo_registrations from anon;
revoke all on public.lexibite_demo_registrations from authenticated;
grant select on public.lexibite_demo_registrations to authenticated;
grant all on public.lexibite_demo_registrations to service_role;

/* ---------------- Session ---------------- */

create table public.lexibite_demo_sessions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.lexibite_demo_registrations(id) on delete cascade,
  user_id uuid not null,
  tenant_id uuid not null,
  property_id uuid,
  location_id uuid,
  role text not null default 'viewer',
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- One live demo session per visitor. Re-activating (e.g. clicking an old
  -- verification email again) refreshes this same row rather than
  -- accumulating a new one per click.
  unique (user_id)
);

create index idx_lexibite_demo_sessions_tenant on public.lexibite_demo_sessions(tenant_id);

alter table public.lexibite_demo_sessions enable row level security;

create policy "lexibite_demo_sessions self read"
  on public.lexibite_demo_sessions for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.lexibite_demo_sessions from anon;
revoke all on public.lexibite_demo_sessions from authenticated;
grant select on public.lexibite_demo_sessions to authenticated;
grant all on public.lexibite_demo_sessions to service_role;

/* ---------------- Reset bookkeeping ---------------- */

-- Single-row marker: "demo transactional data created after this instant
-- has not yet been through a reset." Reset (below) sweeps everything after
-- this timestamp in the curated table list and then advances it to now().
create table public.lexibite_demo_reset_state (
  id boolean primary key default true,
  last_reset_at timestamptz not null default now(),
  constraint lexibite_demo_reset_state_singleton check (id)
);

insert into public.lexibite_demo_reset_state (id, last_reset_at) values (true, now())
  on conflict (id) do nothing;

alter table public.lexibite_demo_reset_state enable row level security;
revoke all on public.lexibite_demo_reset_state from anon;
revoke all on public.lexibite_demo_reset_state from authenticated;
grant all on public.lexibite_demo_reset_state to service_role;

/* ---------------- Grant function ---------------- */

-- The single, narrow, server-authoritative bridge from "verified demo
-- registration" to "least-privilege membership on the real demo tenant".
-- Mirrors restaurant_bootstrap_tenant's own pattern (migration 0049):
-- SECURITY DEFINER, the caller is always auth.uid(), never a parameter, and
-- every value that matters for authorization (tenant, property, location,
-- role) is a hardcoded literal below, not an argument — a caller has no way
-- to ask this function for a different tenant or a different role.
-- Output columns are prefixed (out_...) rather than named tenant_id/role/etc:
-- plpgsql substitutes bare identifiers matching an OUT parameter name
-- anywhere in the function's embedded SQL, including inside an ON CONFLICT
-- target list — "tenant_id"/"role" below would otherwise collide with the
-- real restaurant_members/lexibite_demo_sessions columns of the same name
-- and raise "ambiguous column reference" (caught by live validation against
-- a real Postgres instance, not guessed).
create or replace function public.restaurant_grant_demo_session()
returns table (
  out_session_id uuid,
  out_tenant_id uuid,
  out_property_id uuid,
  out_location_id uuid,
  out_role text,
  out_expires_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_reg_id uuid;
  v_reg_status text;
  v_session_id uuid;
  v_expires_at timestamptz := now() + interval '4 hours';
  -- Hardcoded canonical demo environment (migration 0039). Never a parameter.
  c_tenant_id constant uuid := 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  c_property_id constant uuid := 'd6674bdc-ebe2-4bb7-801a-54b1b8dfc218';
  c_location_id constant uuid := 'fb15e245-b2bf-4d07-abb6-213bbeafa584';
  -- Typed as the real enum, not text: a plain text variable does not
  -- implicitly cast into an enum column on insert under plpgsql's stricter
  -- type checking (only an untyped string literal does) — this was caught
  -- by live validation against a real Postgres instance, not guessed.
  c_role constant public.restaurant_role := 'viewer';
begin
  if v_user is null then
    raise exception 'restaurant_grant_demo_session: no authenticated caller' using errcode = '42501';
  end if;

  select id, status into v_reg_id, v_reg_status
  from public.lexibite_demo_registrations
  where auth_user_id = v_user
  order by created_at desc
  limit 1;

  if v_reg_id is null then
    raise exception 'restaurant_grant_demo_session: no demo registration for this account' using errcode = '42501';
  end if;

  if v_reg_status not in ('verified', 'session_active') then
    raise exception 'restaurant_grant_demo_session: demo registration is not verified' using errcode = '42501';
  end if;

  -- Idempotent: a visitor who already holds the demo viewer grant (e.g.
  -- re-verifying) is not granted a duplicate row. This grant always sets a
  -- property_id, so the applicable unique index is the property-scoped one
  -- from migration 0027 (restaurant_members_property_scoped_uq), not the
  -- tenant-wide one — the conflict target must match it exactly, partial
  -- WHERE clause included, or Postgres refuses the ON CONFLICT clause
  -- outright (caught by live validation against a real Postgres instance).
  insert into public.restaurant_members (tenant_id, property_id, user_id, role)
  values (c_tenant_id, c_property_id, v_user, c_role)
  on conflict (tenant_id, user_id, role, property_id) where property_id is not null do nothing;

  insert into public.lexibite_demo_sessions
    (registration_id, user_id, tenant_id, property_id, location_id, role, status, started_at, expires_at)
  values
    (v_reg_id, v_user, c_tenant_id, c_property_id, c_location_id, c_role, 'active', now(), v_expires_at)
  on conflict (user_id) do update set
    status = 'active',
    started_at = now(),
    expires_at = v_expires_at,
    revoked_at = null
  returning id into v_session_id;

  update public.lexibite_demo_registrations
  set status = 'session_active', updated_at = now()
  where id = v_reg_id;

  return query select v_session_id, c_tenant_id, c_property_id, c_location_id, c_role::text, v_expires_at;
end;
$$;

revoke all on function public.restaurant_grant_demo_session() from public;
revoke all on function public.restaurant_grant_demo_session() from anon;
grant execute on function public.restaurant_grant_demo_session() to authenticated;

/* ---------------- Reset function (admin-gated, never public) ---------------- */

-- Purges only what a demo visitor could actually have created (the guest
-- self-order write surface — see the module header comment above for why
-- that is the only write surface a 'viewer' can reach) inside the demo
-- tenant since the last reset, then revokes the demo 'viewer' membership
-- for any visitor whose session has expired. Never touches the tenant/
-- property/location rows themselves, never touches the two real UAT
-- members already on this tenant (their user ids are never present in
-- lexibite_demo_sessions), and never touches inventory stock movements —
-- ledger reversal is out of scope for this pass (see the Nolmark
-- integration doc's "known limitations" section).
create or replace function public.restaurant_reset_demo_environment(_dry_run boolean default true)
returns table (
  orders_deleted integer,
  order_items_deleted integer,
  payments_deleted integer,
  kitchen_tickets_deleted integer,
  memberships_revoked integer,
  dry_run boolean
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  c_tenant_id constant uuid := 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  v_since timestamptz;
  v_orders integer := 0;
  v_order_items integer := 0;
  v_payments integer := 0;
  v_tickets integer := 0;
  v_memberships integer := 0;
begin
  if v_user is null or not public.restaurant_is_commercial_admin(v_user) then
    raise exception 'restaurant_reset_demo_environment: commercial administration required' using errcode = '42501';
  end if;

  select last_reset_at into v_since from public.lexibite_demo_reset_state where id = true;

  select count(*) into v_orders from public.restaurant_orders
    where tenant_id = c_tenant_id and created_at > v_since;
  select count(*) into v_order_items from public.restaurant_order_items oi
    join public.restaurant_orders o on o.id = oi.order_id
    where o.tenant_id = c_tenant_id and o.created_at > v_since;
  select count(*) into v_payments from public.restaurant_payments
    where tenant_id = c_tenant_id and created_at > v_since;
  select count(*) into v_tickets from public.restaurant_kitchen_tickets kt
    join public.restaurant_orders o on o.id = kt.order_id
    where o.tenant_id = c_tenant_id and o.created_at > v_since;
  select count(*) into v_memberships from public.restaurant_members m
    join public.lexibite_demo_sessions s on s.user_id = m.user_id
    where m.tenant_id = c_tenant_id and m.role = 'viewer' and s.expires_at < now();

  if not _dry_run then
    delete from public.restaurant_order_items oi
      using public.restaurant_orders o
      where oi.order_id = o.id and o.tenant_id = c_tenant_id and o.created_at > v_since;
    delete from public.restaurant_kitchen_tickets kt
      using public.restaurant_orders o
      where kt.order_id = o.id and o.tenant_id = c_tenant_id and o.created_at > v_since;
    delete from public.restaurant_payments
      where tenant_id = c_tenant_id and created_at > v_since;
    delete from public.restaurant_orders
      where tenant_id = c_tenant_id and created_at > v_since;
    delete from public.restaurant_members m
      using public.lexibite_demo_sessions s
      where m.user_id = s.user_id and m.tenant_id = c_tenant_id and m.role = 'viewer' and s.expires_at < now();
    update public.lexibite_demo_sessions set status = 'expired'
      where tenant_id = c_tenant_id and expires_at < now() and status = 'active';
    update public.lexibite_demo_reset_state set last_reset_at = now() where id = true;
  end if;

  return query select v_orders, v_order_items, v_payments, v_tickets, v_memberships, _dry_run;
end;
$$;

revoke all on function public.restaurant_reset_demo_environment(boolean) from public;
revoke all on function public.restaurant_reset_demo_environment(boolean) from anon;
grant execute on function public.restaurant_reset_demo_environment(boolean) to authenticated;
