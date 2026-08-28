-- O11 — supplier communication & PO fulfilment.
--
-- Mirrors restaurant_receipt_deliveries exactly (same idempotency-key +
-- attempt + provider/failure-code shape), pointed at purchase orders instead
-- of receipts. No public share-token surface here: a PO's commercial content
-- is embedded directly in the outgoing email/WhatsApp message (via the
-- existing document renderer), not exposed through an unauthenticated link —
-- procurement content is more sensitive than a guest receipt.
create table public.restaurant_po_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  purchase_order_id uuid not null references public.restaurant_purchase_orders(id) on delete cascade,
  document_number text,
  method text not null check (method in ('email', 'whatsapp')),
  recipient text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed', 'shared')),
  provider text,
  provider_reference text,
  failure_code text,
  failure_reason text,
  attempt integer not null default 1,
  idempotency_key text not null,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  initiated_by uuid,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index restaurant_po_deliveries_idem_key on public.restaurant_po_deliveries (tenant_id, idempotency_key);
create index restaurant_po_deliveries_po_idx on public.restaurant_po_deliveries (tenant_id, purchase_order_id, requested_at desc);

grant select, insert, update on public.restaurant_po_deliveries to authenticated;
grant all on public.restaurant_po_deliveries to service_role;

alter table public.restaurant_po_deliveries enable row level security;

-- Same role set purchasing.manage already gates (core/permissions.ts) — this
-- is a purchasing operation, not a new authority tier.
create policy "po deliveries readable by tenant"
  on public.restaurant_po_deliveries for select to authenticated
  using (public.restaurant_can_read(tenant_id));

create policy "po deliveries writable by tenant staff"
  on public.restaurant_po_deliveries for insert to authenticated
  with check (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'purchasing_officer', 'inventory_manager', 'accountant'
  ]::restaurant_role[]));

create policy "po deliveries updatable by tenant staff"
  on public.restaurant_po_deliveries for update to authenticated
  using (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'purchasing_officer', 'inventory_manager', 'accountant'
  ]::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'purchasing_officer', 'inventory_manager', 'accountant'
  ]::restaurant_role[]));
