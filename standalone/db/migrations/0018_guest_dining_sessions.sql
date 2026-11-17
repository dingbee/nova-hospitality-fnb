-- O12 — guest dining sessions.
--
-- A table's QR encodes nothing but its (permanent, printed) restaurant_tables
-- id — confirmed by audit to be the sole guest-authorization input anywhere
-- in the self-order surface. That is fine for *identifying a table*, but it
-- must not double as a permanent bearer credential for *creating new
-- orders*: today, submitGuestOrder accepts any table id, at any time,
-- forever, with no concept of "is this table currently hosting a guest".
--
-- This table is that missing concept, and nothing more. It does not gate
-- reading the menu (harmless, no state change) or acting on an order a
-- guest already knows the id of (already safely scoped by
-- tenant_id+id+table_id in every selfpay/selfbill/selfstaff/selftrack/
-- selffeedback lookup — recovery must never require re-proving a session,
-- per the existing selforder-recovery.ts model). It only gates *starting or
-- continuing to place new orders* at a table.
--
-- Closure reuses the existing canonical terminal event — bill.server.ts's
-- releaseTable (order closed AND table handed back) and
-- cancellation.server.ts's table release on order cancellation — rather
-- than inventing a second checkout state.
create table public.restaurant_guest_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  -- Server-generated (32 bytes of crypto randomness, hex-encoded — the same
  -- generation shape receipts/delivery.server.ts's token() already uses).
  -- Never derived from, or predictable from, the table id.
  token text not null,
  status text not null default 'active' check (status in ('active', 'expired', 'closed')),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now()
);

create unique index restaurant_guest_sessions_token_key on public.restaurant_guest_sessions (token);

-- At most one *active* dining session per table at a time — the database
-- itself enforces "old session != new session" and closes the race between
-- two guests starting a session on the same table simultaneously, not just
-- application code.
create unique index restaurant_guest_sessions_one_active_idx
  on public.restaurant_guest_sessions (table_id)
  where status = 'active';

create index restaurant_guest_sessions_table_idx
  on public.restaurant_guest_sessions (tenant_id, table_id, started_at desc);

grant select, insert, update on public.restaurant_guest_sessions to authenticated;
grant all on public.restaurant_guest_sessions to service_role;

alter table public.restaurant_guest_sessions enable row level security;

-- Guest writes go through the service-role client (see selforder.server.ts),
-- exactly like every other guest write in this schema (restaurant_orders,
-- restaurant_service_requests, restaurant_guest_feedback) — RLS below
-- governs the staff/authenticated path only.
create policy "guest sessions readable by tenant"
  on public.restaurant_guest_sessions for select to authenticated
  using (public.restaurant_can_read(tenant_id));

create policy "guest sessions managed by tenant"
  on public.restaurant_guest_sessions for all to authenticated
  using (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'bartender', 'chef', 'kitchen_manager'
  ]::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'bartender', 'chef', 'kitchen_manager'
  ]::restaurant_role[]));
