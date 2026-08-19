-- Restaurant & Bar OS — standalone core schema.
-- Statement order below is machine-verified: applied top-to-bottom against an
-- empty PostgreSQL 17 database with zero errors.

set search_path = public;

-- 0001_fnb_core.sql — Restaurant & Bar OS standalone schema.
-- Generated mechanically from the product schema. Hotel (bookings/guests/rooms)
-- foreign keys are neutralised: those columns survive as free-form external refs.
-- No NOVA table, row, credential or property identifier is present.
set search_path = public;

set check_function_bodies = off;

-- ==== enums & functions ====
-- =========================================================
-- Restaurant & Bar OS — Phase 1 commercial foundation
-- =========================================================

CREATE TYPE public.restaurant_role AS ENUM (
  'owner','general_manager','restaurant_manager','chef','kitchen_manager',
  'bartender','inventory_manager','purchasing_officer','accountant','viewer'
);

CREATE TYPE public.restaurant_menu_status AS ENUM ('draft','published','archived');

CREATE TYPE public.restaurant_po_status AS ENUM ('draft','submitted','approved','partially_received','received','cancelled');

-- ---------- Access helpers ----------
CREATE OR REPLACE FUNCTION public.restaurant_is_platform_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, ARRAY['owner','admin','manager']::public.app_role[]);
$$;

-- ============ ENUMS ============
create type public.restaurant_order_status as enum ('open','sent','served','closed','cancelled','voided');

create type public.restaurant_order_type as enum ('dine_in','bar','takeaway','room_service','delivery','banquet');

create type public.restaurant_payment_state as enum ('unpaid','partially_paid','paid','refunded','comped','room_charged');

create type public.restaurant_table_status as enum ('available','occupied','reserved','cleaning','out_of_service');

create type public.restaurant_ticket_status as enum ('queued','preparing','ready','served','cancelled');

create type public.restaurant_stock_movement_type as enum ('opening_balance','purchase_receipt','consumption','wastage','transfer_in','transfer_out','adjustment','return_to_supplier');

-- Movements are the single source of truth for stock levels.
create or replace function public.restaurant_apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qty numeric;
  v_cost numeric;
  v_new_qty numeric;
begin
  select current_quantity, average_cost into v_qty, v_cost
  from public.restaurant_inventory_items
  where id = new.inventory_item_id and tenant_id = new.tenant_id
  for update;

  if v_qty is null then
    return new;
  end if;

  v_new_qty := v_qty + new.quantity;

  -- Weighted-average cost only moves on inbound movements with a stated cost.
  if new.quantity > 0 and new.unit_cost > 0 and v_new_qty > 0 then
    v_cost := ((greatest(v_qty, 0) * coalesce(v_cost, 0)) + (new.quantity * new.unit_cost)) / (greatest(v_qty, 0) + new.quantity);
  end if;

  update public.restaurant_inventory_items
     set current_quantity = v_new_qty,
         average_cost = coalesce(v_cost, average_cost),
         updated_at = now()
   where id = new.inventory_item_id and tenant_id = new.tenant_id;

  new.balance_after := v_new_qty;
  if new.total_cost = 0 and new.unit_cost <> 0 then
    new.total_cost := abs(new.quantity) * new.unit_cost;
  end if;
  return new;
end;
$$;

-- ============ ENUMS ============
create type public.restaurant_pr_status as enum ('draft','submitted','approved','rejected','converted_to_po','cancelled');

create type public.restaurant_pr_priority as enum ('low','normal','high','urgent');

create type public.restaurant_confirmation_status as enum ('pending','confirmed','partially_confirmed','declined');

create type public.restaurant_receipt_status as enum ('draft','posted','cancelled');

create type public.restaurant_invoice_status as enum ('draft','recorded','matched','disputed','cancelled');

create type public.restaurant_procurement_payment_status as enum ('unpaid','partially_paid','paid','disputed');

create type public.restaurant_variance_type as enum ('quantity','price','quality','delivery','tax','invoice');

create type public.restaurant_variance_status as enum ('open','accepted','resolved','escalated');

create or replace function public.restaurant_next_document_number(_tenant uuid, _doc_type text, _prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare _n bigint; _p text;
begin
  if not public.restaurant_can_read(_tenant) then
    raise exception 'Forbidden — not a member of this restaurant tenant.';
  end if;
  insert into public.restaurant_document_sequences (tenant_id, doc_type, prefix, next_number)
  values (_tenant, _doc_type, coalesce(nullif(_prefix,''), upper(left(_doc_type, 3))), 1)
  on conflict (tenant_id, doc_type)
  do update set next_number = public.restaurant_document_sequences.next_number + 1, updated_at = now()
  returning next_number, prefix into _n, _p;
  return _p || '-' || to_char(now(), 'YYYY') || '-' || lpad(_n::text, 5, '0');
end;
$$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_stocktake_status AS ENUM
    ('draft','counting','review','approved','posted','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_reservation_status AS ENUM
    ('active','released','consumed','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_stocktake_scope AS ENUM
    ('full','location','category','selected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Sprint 5.3 — Product, Recipe & Production Architecture */

DO $$ BEGIN
  CREATE TYPE public.restaurant_recipe_status AS ENUM ('draft','active','inactive','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_recipe_kind AS ENUM ('menu','sub_recipe','production');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_recipe_component_kind AS ENUM ('inventory_item','sub_recipe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_production_status AS ENUM ('draft','in_progress','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_product_type AS ENUM ('standard','retail','variant_parent','bundle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.restaurant_modifier_effect AS ENUM ('none','inventory','recipe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ Sprint 5.4 — Pricing, Tax & Commercial Rules Foundation ============

CREATE TYPE public.restaurant_price_scope AS ENUM ('tenant', 'property', 'location');

CREATE TYPE public.restaurant_price_status AS ENUM ('draft', 'pending_approval', 'active', 'superseded', 'expired', 'rejected');

CREATE TYPE public.restaurant_charge_basis AS ENUM ('percent', 'fixed');

CREATE TYPE public.restaurant_discount_scope AS ENUM ('order', 'product', 'category');

CREATE TYPE public.restaurant_promotion_status AS ENUM ('draft', 'scheduled', 'active', 'ended', 'cancelled');

CREATE TYPE public.restaurant_promotion_action AS ENUM ('percent_discount', 'fixed_discount', 'price_override', 'percent_uplift');

DO $$ BEGIN
  CREATE TYPE public.restaurant_requisition_status AS ENUM ('draft','submitted','approved','partially_issued','fulfilled','rejected','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.restaurant_apply_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_qty numeric;
  v_cost numeric;
  v_new_qty numeric;
  v_allow_negative boolean;
  v_name text;
begin
  select current_quantity, average_cost, allow_negative, name
    into v_qty, v_cost, v_allow_negative, v_name
  from public.restaurant_inventory_items
  where id = new.inventory_item_id and tenant_id = new.tenant_id
  for update;

  if v_qty is null then
    return new;
  end if;

  v_new_qty := v_qty + new.quantity;

  -- Negative stock policy, enforced for every path. Corrections (reversal,
  -- adjustment) and inbound movements are always allowed; an outbound movement
  -- is refused when it would break the balance, unless the item permits
  -- negative stock or a supervisor approved this specific movement.
  if v_new_qty < 0
     and new.quantity < 0
     and new.movement_type not in ('reversal', 'adjustment')
     and coalesce(v_allow_negative, false) = false
     and new.approved_by is null then
    raise exception 'negative_stock: % would go to % on this movement (%). Receive stock, correct the count, or allow negative stock for this item.',
      coalesce(v_name, 'Stock item'), v_new_qty, new.movement_type
      using errcode = 'check_violation';
  end if;

  -- Weighted-average cost only moves on inbound movements with a stated cost.
  if new.quantity > 0 and new.unit_cost > 0 and v_new_qty > 0 then
    v_cost := ((greatest(v_qty, 0) * coalesce(v_cost, 0)) + (new.quantity * new.unit_cost)) / (greatest(v_qty, 0) + new.quantity);
  end if;

  update public.restaurant_inventory_items
     set current_quantity = v_new_qty,
         average_cost = coalesce(v_cost, average_cost),
         updated_at = now()
   where id = new.inventory_item_id and tenant_id = new.tenant_id;

  new.balance_after := v_new_qty;
  if new.total_cost = 0 and new.unit_cost <> 0 then
    new.total_cost := abs(new.quantity) * new.unit_cost;
  end if;
  return new;
end;
$function$;

-- ==== tables, policies, indexes, grants, triggers ====
-- ---------- Tenancy ----------
CREATE TABLE public.restaurant_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.restaurant_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
  currency text NOT NULL DEFAULT 'TZS',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE public.restaurant_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  location_type text NOT NULL DEFAULT 'restaurant',
  status text NOT NULL DEFAULT 'active',
  service_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, slug)
);

CREATE TABLE public.restaurant_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.restaurant_role NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role)
);

CREATE INDEX idx_restaurant_members_user ON public.restaurant_members(user_id);

CREATE TABLE public.restaurant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'trial',
  status text NOT NULL DEFAULT 'active',
  seats integer NOT NULL DEFAULT 5,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Menu ----------
CREATE TABLE public.restaurant_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.restaurant_categories(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'menu',
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, slug)
);

CREATE TABLE public.restaurant_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status public.restaurant_menu_status NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'TZS',
  valid_from date,
  valid_to date,
  description text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug, version)
);

CREATE TABLE public.restaurant_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  menu_id uuid NOT NULL REFERENCES public.restaurant_menus(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.restaurant_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  cost_price numeric(12,2),
  available boolean NOT NULL DEFAULT true,
  availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  allergens text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  image_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_id, slug)
);

-- ---------- Inventory ----------
CREATE TABLE public.restaurant_inventory_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  dimension text NOT NULL DEFAULT 'count',
  base_unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  factor numeric(16,6) NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_restaurant_units_code
  ON public.restaurant_inventory_units (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

CREATE TABLE public.restaurant_inventory_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.restaurant_inventory_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL,
  kind text NOT NULL DEFAULT 'ingredient',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE public.restaurant_inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.restaurant_inventory_categories(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  sku text,
  name text NOT NULL,
  item_type text NOT NULL DEFAULT 'ingredient',
  current_quantity numeric(16,4) NOT NULL DEFAULT 0,
  par_level numeric(16,4),
  reorder_point numeric(16,4),
  average_cost numeric(14,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX idx_restaurant_inv_items_tenant ON public.restaurant_inventory_items(tenant_id, property_id);

-- ---------- Suppliers ----------
CREATE TABLE public.restaurant_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  code text,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  address text,
  payment_terms text,
  lead_time_days integer,
  reliability_score numeric(5,2),
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE public.restaurant_supplier_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.restaurant_suppliers(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  supplier_sku text,
  name text NOT NULL,
  pack_size numeric(16,4) NOT NULL DEFAULT 1,
  unit_price numeric(14,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  min_order_quantity numeric(16,4),
  lead_time_days integer,
  last_price_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurant_supplier_products ON public.restaurant_supplier_products(tenant_id, supplier_id);

-- ---------- Purchasing ----------
CREATE TABLE public.restaurant_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  supplier_id uuid REFERENCES public.restaurant_suppliers(id) ON DELETE SET NULL,
  reference text NOT NULL,
  status public.restaurant_po_status NOT NULL DEFAULT 'draft',
  order_date date NOT NULL DEFAULT current_date,
  expected_at date,
  received_at timestamptz,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  notes text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);

CREATE TABLE public.restaurant_purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.restaurant_purchase_orders(id) ON DELETE CASCADE,
  supplier_product_id uuid REFERENCES public.restaurant_supplier_products(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(16,4) NOT NULL DEFAULT 1,
  received_quantity numeric(16,4) NOT NULL DEFAULT 0,
  unit_price numeric(14,4) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurant_po_items ON public.restaurant_purchase_order_items(purchase_order_id);

-- ---------- Costing ----------
CREATE TABLE public.restaurant_recipe_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.restaurant_menu_items(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  component_menu_item_id uuid REFERENCES public.restaurant_menu_items(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  quantity numeric(16,4) NOT NULL DEFAULT 0,
  yield_percent numeric(6,2) NOT NULL DEFAULT 100,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurant_recipe_components ON public.restaurant_recipe_components(menu_item_id);

CREATE TABLE public.restaurant_recipe_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.restaurant_menu_items(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  ingredient_cost numeric(14,4) NOT NULL DEFAULT 0,
  overhead_cost numeric(14,4) NOT NULL DEFAULT 0,
  total_cost numeric(14,4) NOT NULL DEFAULT 0,
  target_margin numeric(6,2),
  suggested_price numeric(14,2),
  food_cost_percent numeric(6,2),
  currency text NOT NULL DEFAULT 'TZS',
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurant_recipe_costs ON public.restaurant_recipe_costs(menu_item_id, computed_at DESC);

-- ---------- Grants ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.restaurant_tenants, public.restaurant_properties, public.restaurant_locations,
  public.restaurant_members, public.restaurant_subscriptions, public.restaurant_categories,
  public.restaurant_menus, public.restaurant_menu_items, public.restaurant_inventory_units,
  public.restaurant_inventory_categories, public.restaurant_inventory_items,
  public.restaurant_suppliers, public.restaurant_supplier_products,
  public.restaurant_purchase_orders, public.restaurant_purchase_order_items,
  public.restaurant_recipe_components, public.restaurant_recipe_costs
TO authenticated;

GRANT ALL ON
  public.restaurant_tenants, public.restaurant_properties, public.restaurant_locations,
  public.restaurant_members, public.restaurant_subscriptions, public.restaurant_categories,
  public.restaurant_menus, public.restaurant_menu_items, public.restaurant_inventory_units,
  public.restaurant_inventory_categories, public.restaurant_inventory_items,
  public.restaurant_suppliers, public.restaurant_supplier_products,
  public.restaurant_purchase_orders, public.restaurant_purchase_order_items,
  public.restaurant_recipe_components, public.restaurant_recipe_costs
TO service_role;

-- ---------- RLS ----------
ALTER TABLE public.restaurant_tenants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_properties ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_locations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_menus ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_menu_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_inventory_units ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_inventory_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_inventory_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_suppliers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_supplier_products ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_purchase_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_purchase_order_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_recipe_components ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_recipe_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions write" ON public.restaurant_subscriptions FOR ALL TO authenticated
  USING (public.restaurant_is_platform_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_platform_admin(auth.uid()));

REVOKE EXECUTE ON FUNCTION public.restaurant_is_platform_admin(uuid) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.restaurant_is_platform_admin(uuid) TO authenticated, service_role;

-- ============ 2.1 SALES & POS ============
create table public.restaurant_service_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  code text not null,
  name text not null,
  start_time time not null default '00:00',
  end_time time not null default '23:59',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, location_id, code)
);

grant select, insert, update, delete on public.restaurant_service_periods to authenticated;

grant all on public.restaurant_service_periods to service_role;

alter table public.restaurant_service_periods enable row level security;

create table public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  code text not null,
  name text not null,
  zone text,
  seats integer not null default 2,
  status public.restaurant_table_status not null default 'available',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, location_id, code)
);

grant select, insert, update, delete on public.restaurant_tables to authenticated;

grant all on public.restaurant_tables to service_role;

alter table public.restaurant_tables enable row level security;

create table public.restaurant_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  table_id uuid references public.restaurant_tables(id) on delete set null,
  service_period_id uuid references public.restaurant_service_periods(id) on delete set null,
  order_number text not null,
  order_type public.restaurant_order_type not null default 'dine_in',
  status public.restaurant_order_status not null default 'open',
  payment_state public.restaurant_payment_state not null default 'unpaid',
  guest_count integer not null default 1,
  booking_id uuid /* [standalone] external system ref */,
  guest_name text,
  server_user_id uuid references auth.users(id) on delete set null,
  source text not null default 'manual',
  external_ref text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  service_charge numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  paid_total numeric(14,2) not null default 0,
  cost_total numeric(14,4) not null default 0,
  currency text not null default 'TZS',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_number)
);

create index restaurant_orders_tenant_opened_idx on public.restaurant_orders (tenant_id, opened_at desc);

create index restaurant_orders_location_status_idx on public.restaurant_orders (location_id, status);

grant select, insert, update, delete on public.restaurant_orders to authenticated;

grant all on public.restaurant_orders to service_role;

alter table public.restaurant_orders enable row level security;

create table public.restaurant_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  menu_item_id uuid references public.restaurant_menu_items(id) on delete set null,
  station_id uuid,
  description text not null,
  quantity numeric(12,3) not null default 1,
  unit_price numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null default 0,
  unit_cost numeric(14,4) not null default 0,
  line_cost numeric(14,4) not null default 0,
  status text not null default 'ordered',
  course text,
  notes text,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index restaurant_order_items_order_idx on public.restaurant_order_items (order_id);

create index restaurant_order_items_menu_item_idx on public.restaurant_order_items (tenant_id, menu_item_id);

grant select, insert, update, delete on public.restaurant_order_items to authenticated;

grant all on public.restaurant_order_items to service_role;

alter table public.restaurant_order_items enable row level security;

create table public.restaurant_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  method text not null default 'cash',
  state public.restaurant_payment_state not null default 'paid',
  amount numeric(14,2) not null default 0,
  tendered numeric(14,2),
  change_due numeric(14,2) not null default 0,
  currency text not null default 'TZS',
  reference text,
  booking_id uuid /* [standalone] external system ref */,
  captured_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index restaurant_payments_order_idx on public.restaurant_payments (order_id);

grant select, insert, update, delete on public.restaurant_payments to authenticated;

grant all on public.restaurant_payments to service_role;

alter table public.restaurant_payments enable row level security;

-- ============ 2.2 KITCHEN OPERATIONS ============
create table public.restaurant_stations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  code text not null,
  name text not null,
  station_type text not null default 'kitchen',
  target_prep_minutes integer not null default 15,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, location_id, code)
);

grant select, insert, update, delete on public.restaurant_stations to authenticated;

grant all on public.restaurant_stations to service_role;

alter table public.restaurant_stations enable row level security;

alter table public.restaurant_order_items
  add constraint restaurant_order_items_station_fk foreign key (station_id) references public.restaurant_stations(id) on delete set null;

create table public.restaurant_kitchen_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  station_id uuid references public.restaurant_stations(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  ticket_number text not null,
  status public.restaurant_ticket_status not null default 'queued',
  priority integer not null default 0,
  course text,
  target_minutes integer not null default 15,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  prep_seconds integer,
  delay_seconds integer not null default 0,
  is_delayed boolean not null default false,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ticket_number)
);

create index restaurant_kitchen_tickets_status_idx on public.restaurant_kitchen_tickets (tenant_id, status, queued_at);

grant select, insert, update, delete on public.restaurant_kitchen_tickets to authenticated;

grant all on public.restaurant_kitchen_tickets to service_role;

alter table public.restaurant_kitchen_tickets enable row level security;

create table public.restaurant_kitchen_ticket_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  ticket_id uuid not null references public.restaurant_kitchen_tickets(id) on delete cascade,
  order_item_id uuid references public.restaurant_order_items(id) on delete set null,
  menu_item_id uuid references public.restaurant_menu_items(id) on delete set null,
  description text not null,
  quantity numeric(12,3) not null default 1,
  status public.restaurant_ticket_status not null default 'queued',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index restaurant_kitchen_ticket_items_ticket_idx on public.restaurant_kitchen_ticket_items (ticket_id);

grant select, insert, update, delete on public.restaurant_kitchen_ticket_items to authenticated;

grant all on public.restaurant_kitchen_ticket_items to service_role;

alter table public.restaurant_kitchen_ticket_items enable row level security;

-- ============ 2.3 INVENTORY MOVEMENT ENGINE ============
create table public.restaurant_stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  destination_location_id uuid references public.restaurant_locations(id) on delete set null,
  inventory_item_id uuid not null references public.restaurant_inventory_items(id) on delete cascade,
  unit_id uuid references public.restaurant_inventory_units(id) on delete set null,
  movement_type public.restaurant_stock_movement_type not null,
  quantity numeric(14,4) not null,
  unit_cost numeric(14,4) not null default 0,
  total_cost numeric(14,4) not null default 0,
  currency text not null default 'TZS',
  balance_after numeric(14,4),
  reference_type text,
  reference_id uuid,
  order_item_id uuid references public.restaurant_order_items(id) on delete set null,
  reason text,
  notes text,
  dedupe_key text,
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create index restaurant_stock_movements_item_idx on public.restaurant_stock_movements (tenant_id, inventory_item_id, occurred_at desc);

create index restaurant_stock_movements_type_idx on public.restaurant_stock_movements (tenant_id, movement_type, occurred_at desc);

grant select, insert, update, delete on public.restaurant_stock_movements to authenticated;

grant all on public.restaurant_stock_movements to service_role;

alter table public.restaurant_stock_movements enable row level security;

create trigger restaurant_stock_movement_apply
before insert on public.restaurant_stock_movements
for each row execute function public.restaurant_apply_stock_movement();

-- ============ 2.4 COST INTELLIGENCE ============
create table public.restaurant_profitability_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  menu_item_id uuid references public.restaurant_menu_items(id) on delete set null,
  menu_item_name text not null,
  period_start date not null,
  period_end date not null,
  quantity_sold numeric(14,3) not null default 0,
  revenue numeric(14,2) not null default 0,
  theoretical_cost numeric(14,4) not null default 0,
  actual_cost numeric(14,4) not null default 0,
  variance numeric(14,4) not null default 0,
  gross_profit numeric(14,4) not null default 0,
  margin_percent numeric(6,2),
  food_cost_percent numeric(6,2),
  currency text not null default 'TZS',
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index restaurant_profitability_idx on public.restaurant_profitability_snapshots (tenant_id, period_start desc);

grant select, insert, update, delete on public.restaurant_profitability_snapshots to authenticated;

grant all on public.restaurant_profitability_snapshots to service_role;

alter table public.restaurant_profitability_snapshots enable row level security;

-- ============ updated_at triggers ============
create trigger set_updated_at_restaurant_service_periods before update on public.restaurant_service_periods for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_tables before update on public.restaurant_tables for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_orders before update on public.restaurant_orders for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_order_items before update on public.restaurant_order_items for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_payments before update on public.restaurant_payments for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_stations before update on public.restaurant_stations for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_kitchen_tickets before update on public.restaurant_kitchen_tickets for each row execute function public.set_updated_at();

create trigger set_updated_at_restaurant_kitchen_ticket_items before update on public.restaurant_kitchen_ticket_items for each row execute function public.set_updated_at();

-- ============ DOCUMENT NUMBERING ============
create table public.restaurant_document_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  doc_type text not null,
  prefix text not null,
  next_number bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, doc_type)
);

grant select, insert, update, delete on public.restaurant_document_sequences to authenticated;

grant all on public.restaurant_document_sequences to service_role;

alter table public.restaurant_document_sequences enable row level security;

-- ============ PURCHASE REQUESTS ============
create table public.restaurant_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  document_number text not null,
  status public.restaurant_pr_status not null default 'draft',
  priority public.restaurant_pr_priority not null default 'normal',
  category text,
  reason text,
  notes text,
  currency text not null default 'TZS',
  estimated_total numeric(14,2) not null default 0,
  requested_by uuid not null,
  requested_date date not null default current_date,
  required_by_date date,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  rejected_at timestamptz,
  rejected_by uuid,
  rejection_reason text,
  cancelled_at timestamptz,
  converted_purchase_order_id uuid references public.restaurant_purchase_orders(id) on delete set null,
  converted_at timestamptz,
  version integer not null default 1,
  correlation_id uuid not null default gen_random_uuid(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, document_number)
);

grant select, insert, update, delete on public.restaurant_purchase_requests to authenticated;

grant all on public.restaurant_purchase_requests to service_role;

alter table public.restaurant_purchase_requests enable row level security;

create index idx_rest_pr_tenant_status on public.restaurant_purchase_requests (tenant_id, status, created_at desc);

create table public.restaurant_purchase_request_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  purchase_request_id uuid not null references public.restaurant_purchase_requests(id) on delete cascade,
  inventory_item_id uuid references public.restaurant_inventory_items(id) on delete set null,
  unit_id uuid references public.restaurant_inventory_units(id) on delete set null,
  preferred_supplier_id uuid references public.restaurant_suppliers(id) on delete set null,
  description text not null,
  quantity numeric(14,3) not null default 0,
  approved_quantity numeric(14,3),
  estimated_unit_cost numeric(14,4) not null default 0,
  estimated_total numeric(14,2) not null default 0,
  justification text,
  recommendation_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.restaurant_purchase_request_items to authenticated;

grant all on public.restaurant_purchase_request_items to service_role;

alter table public.restaurant_purchase_request_items enable row level security;

create index idx_rest_pr_items_request on public.restaurant_purchase_request_items (purchase_request_id);

-- ============ APPROVAL RULES ============
create table public.restaurant_approval_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete cascade,
  location_id uuid references public.restaurant_locations(id) on delete cascade,
  document_type text not null default 'purchase_request',
  category text,
  currency text not null default 'TZS',
  min_amount numeric(14,2) not null default 0,
  max_amount numeric(14,2),
  approver_roles public.restaurant_role[] not null default array['owner','general_manager','restaurant_manager']::restaurant_role[],
  require_separation_of_duties boolean not null default true,
  priority integer not null default 100,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.restaurant_approval_rules to authenticated;

grant all on public.restaurant_approval_rules to service_role;

alter table public.restaurant_approval_rules enable row level security;

-- ============ PURCHASE ORDER EXTENSIONS ============
alter table public.restaurant_purchase_orders
  add column if not exists document_number text,
  add column if not exists purchase_request_id uuid references public.restaurant_purchase_requests(id) on delete set null,
  add column if not exists buyer_id uuid,
  add column if not exists requested_delivery_date date,
  add column if not exists payment_terms text,
  add column if not exists discount_total numeric(14,2) not null default 0,
  add column if not exists supplier_reference text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_status public.restaurant_confirmation_status not null default 'pending',
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists version integer not null default 1;

alter table public.restaurant_purchase_order_items
  add column if not exists tax_rate numeric(6,3) not null default 0,
  add column if not exists tax_amount numeric(14,2) not null default 0,
  add column if not exists discount_amount numeric(14,2) not null default 0,
  add column if not exists accepted_quantity numeric(14,3) not null default 0,
  add column if not exists rejected_quantity numeric(14,3) not null default 0,
  add column if not exists confirmed_quantity numeric(14,3),
  add column if not exists confirmed_unit_price numeric(14,4);

-- ============ SUPPLIER CONFIRMATION ============
create table public.restaurant_supplier_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  purchase_order_id uuid not null references public.restaurant_purchase_orders(id) on delete cascade,
  document_number text not null,
  supplier_reference text,
  status public.restaurant_confirmation_status not null default 'confirmed',
  confirmed_delivery_date date,
  confirmed_at timestamptz not null default now(),
  notes text,
  recorded_by uuid not null,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, document_number)
);

grant select, insert, update, delete on public.restaurant_supplier_confirmations to authenticated;

grant all on public.restaurant_supplier_confirmations to service_role;

alter table public.restaurant_supplier_confirmations enable row level security;

create table public.restaurant_supplier_confirmation_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  confirmation_id uuid not null references public.restaurant_supplier_confirmations(id) on delete cascade,
  purchase_order_item_id uuid not null references public.restaurant_purchase_order_items(id) on delete cascade,
  ordered_quantity numeric(14,3) not null default 0,
  confirmed_quantity numeric(14,3) not null default 0,
  ordered_unit_price numeric(14,4) not null default 0,
  confirmed_unit_price numeric(14,4) not null default 0,
  confirmed_delivery_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.restaurant_supplier_confirmation_items to authenticated;

grant all on public.restaurant_supplier_confirmation_items to service_role;

alter table public.restaurant_supplier_confirmation_items enable row level security;

-- ============ GOODS RECEIVING ============
create table public.restaurant_goods_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  purchase_order_id uuid references public.restaurant_purchase_orders(id) on delete set null,
  supplier_id uuid references public.restaurant_suppliers(id) on delete set null,
  document_number text not null,
  status public.restaurant_receipt_status not null default 'draft',
  delivery_note_ref text,
  received_at timestamptz not null default now(),
  expected_at date,
  received_by uuid not null,
  posted_at timestamptz,
  posted_by uuid,
  currency text not null default 'TZS',
  subtotal numeric(14,2) not null default 0,
  accepted_value numeric(14,2) not null default 0,
  notes text,
  version integer not null default 1,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, document_number)
);

grant select, insert, update, delete on public.restaurant_goods_receipts to authenticated;

grant all on public.restaurant_goods_receipts to service_role;

alter table public.restaurant_goods_receipts enable row level security;

create index idx_rest_receipts_po on public.restaurant_goods_receipts (purchase_order_id);

create table public.restaurant_goods_receipt_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  receipt_id uuid not null references public.restaurant_goods_receipts(id) on delete cascade,
  purchase_order_item_id uuid references public.restaurant_purchase_order_items(id) on delete set null,
  inventory_item_id uuid references public.restaurant_inventory_items(id) on delete set null,
  unit_id uuid references public.restaurant_inventory_units(id) on delete set null,
  storage_location_id uuid references public.restaurant_locations(id) on delete set null,
  description text not null,
  ordered_quantity numeric(14,3) not null default 0,
  received_quantity numeric(14,3) not null default 0,
  accepted_quantity numeric(14,3) not null default 0,
  rejected_quantity numeric(14,3) not null default 0,
  damaged_quantity numeric(14,3) not null default 0,
  ordered_unit_cost numeric(14,4) not null default 0,
  unit_cost numeric(14,4) not null default 0,
  currency text not null default 'TZS',
  batch_code text,
  expiry_date date,
  rejection_reason text,
  notes text,
  stock_movement_id uuid references public.restaurant_stock_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.restaurant_goods_receipt_items to authenticated;

grant all on public.restaurant_goods_receipt_items to service_role;

alter table public.restaurant_goods_receipt_items enable row level security;

create index idx_rest_receipt_items_receipt on public.restaurant_goods_receipt_items (receipt_id);

-- ============ VARIANCES ============
create table public.restaurant_procurement_variances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  variance_type public.restaurant_variance_type not null,
  severity text not null default 'medium',
  status public.restaurant_variance_status not null default 'open',
  purchase_order_id uuid references public.restaurant_purchase_orders(id) on delete cascade,
  receipt_id uuid references public.restaurant_goods_receipts(id) on delete cascade,
  receipt_item_id uuid references public.restaurant_goods_receipt_items(id) on delete cascade,
  invoice_id uuid,
  supplier_id uuid references public.restaurant_suppliers(id) on delete set null,
  label text not null,
  expected_value numeric(14,4),
  actual_value numeric(14,4),
  variance_value numeric(14,4),
  variance_pct numeric(10,4),
  unit text,
  currency text,
  detail jsonb not null default '{}'::jsonb,
  dedupe_key text,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

grant select, insert, update, delete on public.restaurant_procurement_variances to authenticated;

grant all on public.restaurant_procurement_variances to service_role;

alter table public.restaurant_procurement_variances enable row level security;

create index idx_rest_variance_open on public.restaurant_procurement_variances (tenant_id, status, detected_at desc);

-- ============ SUPPLIER PRICE HISTORY ============
create table public.restaurant_supplier_price_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  supplier_id uuid not null references public.restaurant_suppliers(id) on delete cascade,
  inventory_item_id uuid references public.restaurant_inventory_items(id) on delete set null,
  supplier_product_id uuid references public.restaurant_supplier_products(id) on delete set null,
  unit_id uuid references public.restaurant_inventory_units(id) on delete set null,
  price_type text not null,
  price numeric(14,4) not null,
  quantity numeric(14,3),
  currency text not null default 'TZS',
  effective_date date not null default current_date,
  source_type text,
  source_id uuid,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

grant select, insert, update, delete on public.restaurant_supplier_price_history to authenticated;

grant all on public.restaurant_supplier_price_history to service_role;

alter table public.restaurant_supplier_price_history enable row level security;

create index idx_rest_price_history_lookup on public.restaurant_supplier_price_history (tenant_id, supplier_id, inventory_item_id, effective_date desc);

-- ============ SUPPLIER INVOICES ============
create table public.restaurant_supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  supplier_id uuid references public.restaurant_suppliers(id) on delete set null,
  purchase_order_id uuid references public.restaurant_purchase_orders(id) on delete set null,
  document_number text not null,
  supplier_invoice_number text not null,
  status public.restaurant_invoice_status not null default 'recorded',
  payment_status public.restaurant_procurement_payment_status not null default 'unpaid',
  match_status text not null default 'unmatched',
  matched_at timestamptz,
  invoice_date date not null default current_date,
  due_date date,
  currency text not null default 'TZS',
  subtotal numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  attachment_url text,
  notes text,
  recorded_by uuid not null,
  version integer not null default 1,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, document_number),
  unique (tenant_id, supplier_id, supplier_invoice_number)
);

grant select, insert, update, delete on public.restaurant_supplier_invoices to authenticated;

grant all on public.restaurant_supplier_invoices to service_role;

alter table public.restaurant_supplier_invoices enable row level security;

create table public.restaurant_supplier_invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  invoice_id uuid not null references public.restaurant_supplier_invoices(id) on delete cascade,
  purchase_order_item_id uuid references public.restaurant_purchase_order_items(id) on delete set null,
  receipt_item_id uuid references public.restaurant_goods_receipt_items(id) on delete set null,
  inventory_item_id uuid references public.restaurant_inventory_items(id) on delete set null,
  description text not null,
  quantity numeric(14,3) not null default 0,
  unit_price numeric(14,4) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.restaurant_supplier_invoice_items to authenticated;

grant all on public.restaurant_supplier_invoice_items to service_role;

alter table public.restaurant_supplier_invoice_items enable row level security;

alter table public.restaurant_procurement_variances
  add constraint restaurant_variance_invoice_fk foreign key (invoice_id) references public.restaurant_supplier_invoices(id) on delete cascade;

-- ============ PROCUREMENT AUDIT TRAIL ============
create table public.restaurant_procurement_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  document_type text not null,
  document_id uuid not null,
  document_number text,
  action text not null,
  previous_state text,
  new_state text,
  reason text,
  actor_id uuid,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

grant select, insert on public.restaurant_procurement_audit to authenticated;

grant all on public.restaurant_procurement_audit to service_role;

alter table public.restaurant_procurement_audit enable row level security;

create index idx_rest_proc_audit_doc on public.restaurant_procurement_audit (tenant_id, document_type, document_id, created_at desc);

-- ============ TIMESTAMP TRIGGERS ============
create trigger set_updated_at before update on public.restaurant_document_sequences for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_purchase_requests for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_purchase_request_items for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_approval_rules for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_supplier_confirmations for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_supplier_confirmation_items for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_goods_receipts for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_goods_receipt_items for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_procurement_variances for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_supplier_price_history for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_supplier_invoices for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.restaurant_supplier_invoice_items for each row execute function public.set_updated_at();

revoke execute on function public.restaurant_next_document_number(uuid, text, text) from anon, public;

grant execute on function public.restaurant_next_document_number(uuid, text, text) to authenticated, service_role;

-- =========================================================
-- Sprint 5.2 — Inventory Control & Multi-Location
-- The ledger (restaurant_stock_movements) remains the single
-- source of truth for balances. Everything added here either
-- feeds the ledger or is derived from it.
-- =========================================================

/* ---------- 1. Locations become a configurable storage tree ---------- */

ALTER TABLE public.restaurant_locations
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_storage boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_locations_tenant_code_key
  ON public.restaurant_locations (tenant_id, lower(code)) WHERE code IS NOT NULL;

/* ---------- 2. Item-level configuration (commercial, not hard-coded) ---------- */

ALTER TABLE public.restaurant_inventory_items
  ADD COLUMN IF NOT EXISTS track_batches boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_negative boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS purchase_unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consumption_unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pack_size numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shelf_life_days integer;

/* ---------- 3. Movement types ---------- */

ALTER TYPE public.restaurant_stock_movement_type ADD VALUE IF NOT EXISTS 'adjustment_in';

ALTER TYPE public.restaurant_stock_movement_type ADD VALUE IF NOT EXISTS 'adjustment_out';

ALTER TYPE public.restaurant_stock_movement_type ADD VALUE IF NOT EXISTS 'production';

ALTER TYPE public.restaurant_stock_movement_type ADD VALUE IF NOT EXISTS 'reversal';

/* ---------- 4. New lifecycle enums ---------- */

DO $$ BEGIN
  CREATE TYPE public.restaurant_transfer_status AS ENUM
    ('draft','requested','approved','rejected','dispatched','partially_received','received','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* ---------- 5. Configurable reason catalogue (waste / adjustment) ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_inventory_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('waste','adjustment','transfer','stocktake')),
  code text NOT NULL,
  label text NOT NULL,
  requires_approval boolean NOT NULL DEFAULT false,
  requires_note boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_inventory_reasons TO authenticated;

GRANT ALL ON public.restaurant_inventory_reasons TO service_role;

ALTER TABLE public.restaurant_inventory_reasons ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_inventory_reasons_updated_at BEFORE UPDATE ON public.restaurant_inventory_reasons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 6. Batches / lots ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES public.restaurant_suppliers(id) ON DELETE SET NULL,
  batch_number text NOT NULL,
  received_date date,
  expiry_date date,
  quantity numeric NOT NULL DEFAULT 0,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  unit_cost numeric NOT NULL DEFAULT 0,
  reference_type text,
  reference_id uuid,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inventory_item_id, batch_number)
);

CREATE INDEX IF NOT EXISTS restaurant_batches_expiry_idx
  ON public.restaurant_inventory_batches (tenant_id, expiry_date) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_inventory_batches TO authenticated;

GRANT ALL ON public.restaurant_inventory_batches TO service_role;

ALTER TABLE public.restaurant_inventory_batches ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_inventory_batches_updated_at BEFORE UPDATE ON public.restaurant_inventory_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 7. Transfers ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  transfer_number text NOT NULL,
  source_location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT,
  destination_location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT,
  status public.restaurant_transfer_status NOT NULL DEFAULT 'draft',
  requires_approval boolean NOT NULL DEFAULT false,
  requested_by uuid,
  approved_by uuid,
  dispatched_by uuid,
  received_by uuid,
  requested_at timestamptz,
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  completed_at timestamptz,
  rejection_reason text,
  notes text,
  total_value numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, transfer_number),
  CHECK (source_location_id <> destination_location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_stock_transfers TO authenticated;

GRANT ALL ON public.restaurant_stock_transfers TO service_role;

ALTER TABLE public.restaurant_stock_transfers ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_stock_transfers_updated_at BEFORE UPDATE ON public.restaurant_stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES public.restaurant_stock_transfers(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE RESTRICT,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES public.restaurant_inventory_batches(id) ON DELETE SET NULL,
  requested_quantity numeric NOT NULL DEFAULT 0,
  dispatched_quantity numeric NOT NULL DEFAULT 0,
  received_quantity numeric NOT NULL DEFAULT 0,
  rejected_quantity numeric NOT NULL DEFAULT 0,
  damaged_quantity numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  variance_quantity numeric GENERATED ALWAYS AS (dispatched_quantity - received_quantity - rejected_quantity - damaged_quantity) STORED,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_transfer_lines_transfer_idx
  ON public.restaurant_stock_transfer_lines (transfer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_stock_transfer_lines TO authenticated;

GRANT ALL ON public.restaurant_stock_transfer_lines TO service_role;

ALTER TABLE public.restaurant_stock_transfer_lines ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_stock_transfer_lines_updated_at BEFORE UPDATE ON public.restaurant_stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 8. Reservations (committed, not yet consumed) ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  status public.restaurant_reservation_status NOT NULL DEFAULT 'active',
  purpose text NOT NULL DEFAULT 'operational',
  reference_type text,
  reference_id uuid,
  needed_at timestamptz,
  expires_at timestamptz,
  released_at timestamptz,
  notes text,
  dedupe_key text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS restaurant_reservations_active_idx
  ON public.restaurant_stock_reservations (tenant_id, inventory_item_id, location_id) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_stock_reservations TO authenticated;

GRANT ALL ON public.restaurant_stock_reservations TO service_role;

ALTER TABLE public.restaurant_stock_reservations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_stock_reservations_updated_at BEFORE UPDATE ON public.restaurant_stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 9. Stocktake ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.restaurant_inventory_categories(id) ON DELETE SET NULL,
  stocktake_number text NOT NULL,
  scope public.restaurant_stocktake_scope NOT NULL DEFAULT 'location',
  status public.restaurant_stocktake_status NOT NULL DEFAULT 'draft',
  counted_by uuid,
  reviewed_by uuid,
  approved_by uuid,
  started_at timestamptz,
  counted_at timestamptz,
  approved_at timestamptz,
  posted_at timestamptz,
  variance_value numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stocktake_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_stocktakes TO authenticated;

GRANT ALL ON public.restaurant_stocktakes TO service_role;

ALTER TABLE public.restaurant_stocktakes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_stocktakes_updated_at BEFORE UPDATE ON public.restaurant_stocktakes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_stocktake_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  stocktake_id uuid NOT NULL REFERENCES public.restaurant_stocktakes(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES public.restaurant_inventory_batches(id) ON DELETE SET NULL,
  expected_quantity numeric NOT NULL DEFAULT 0,
  counted_quantity numeric,
  variance_quantity numeric GENERATED ALWAYS AS (coalesce(counted_quantity, 0) - expected_quantity) STORED,
  unit_cost numeric NOT NULL DEFAULT 0,
  reason_code text,
  notes text,
  counted_at timestamptz,
  posted_movement_id uuid REFERENCES public.restaurant_stock_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stocktake_id, inventory_item_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_stocktake_lines TO authenticated;

GRANT ALL ON public.restaurant_stocktake_lines TO service_role;

ALTER TABLE public.restaurant_stocktake_lines ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_stocktake_lines_updated_at BEFORE UPDATE ON public.restaurant_stocktake_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 10. Ledger enrichment (still the only source of truth) ---------- */

ALTER TABLE public.restaurant_stock_movements
  ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES public.restaurant_stock_transfers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transfer_line_id uuid REFERENCES public.restaurant_stock_transfer_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stocktake_id uuid REFERENCES public.restaurant_stocktakes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.restaurant_inventory_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid REFERENCES public.restaurant_stock_movements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE INDEX IF NOT EXISTS restaurant_movements_item_location_idx
  ON public.restaurant_stock_movements (tenant_id, inventory_item_id, location_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS restaurant_movements_transfer_idx
  ON public.restaurant_stock_movements (transfer_id) WHERE transfer_id IS NOT NULL;

/* ---------- 11. Derived read models (never a second source of truth) ---------- */

CREATE OR REPLACE VIEW public.restaurant_stock_positions_v
WITH (security_invoker = true) AS
SELECT
  m.tenant_id,
  m.inventory_item_id,
  m.location_id,
  sum(m.quantity)                                   AS on_hand,
  sum(m.quantity) FILTER (WHERE m.quantity > 0)     AS total_in,
  sum(-m.quantity) FILTER (WHERE m.quantity < 0)    AS total_out,
  max(m.occurred_at)                                AS last_movement_at,
  count(*)                                          AS movement_count
FROM public.restaurant_stock_movements m
GROUP BY m.tenant_id, m.inventory_item_id, m.location_id;

GRANT SELECT ON public.restaurant_stock_positions_v TO authenticated;

GRANT SELECT ON public.restaurant_stock_positions_v TO service_role;

CREATE OR REPLACE VIEW public.restaurant_stock_reconciliation_v
WITH (security_invoker = true) AS
WITH ledger AS (
  SELECT tenant_id, inventory_item_id, sum(quantity) AS ledger_quantity, count(*) AS movement_count
  FROM public.restaurant_stock_movements
  GROUP BY tenant_id, inventory_item_id
),
orphan AS (
  SELECT tenant_id, inventory_item_id, count(*) AS orphan_transfer_movements
  FROM public.restaurant_stock_movements
  WHERE movement_type IN ('transfer_in','transfer_out') AND transfer_id IS NULL
  GROUP BY tenant_id, inventory_item_id
)
SELECT
  i.tenant_id,
  i.id                                        AS inventory_item_id,
  i.name,
  i.current_quantity                          AS item_quantity,
  coalesce(l.ledger_quantity, 0)              AS ledger_quantity,
  i.current_quantity - coalesce(l.ledger_quantity, 0) AS drift,
  coalesce(l.movement_count, 0)               AS movement_count,
  coalesce(o.orphan_transfer_movements, 0)    AS orphan_transfer_movements,
  (i.current_quantity < 0 AND NOT i.allow_negative) AS illegal_negative
FROM public.restaurant_inventory_items i
LEFT JOIN ledger l ON l.tenant_id = i.tenant_id AND l.inventory_item_id = i.id
LEFT JOIN orphan o ON o.tenant_id = i.tenant_id AND o.inventory_item_id = i.id;

GRANT SELECT ON public.restaurant_stock_reconciliation_v TO authenticated;

GRANT SELECT ON public.restaurant_stock_reconciliation_v TO service_role;

/* ---------- 1. Recipes ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  kind public.restaurant_recipe_kind NOT NULL DEFAULT 'menu',
  status public.restaurant_recipe_status NOT NULL DEFAULT 'draft',
  category_id uuid REFERENCES public.restaurant_categories(id) ON DELETE SET NULL,
  lineage_id uuid,
  supersedes_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE SET NULL,
  yield_quantity numeric NOT NULL DEFAULT 1,
  yield_unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  produces_inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  instructions text,
  notes text,
  target_cost numeric,
  computed_cost numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  effective_from date,
  effective_to date,
  last_reviewed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

CREATE INDEX IF NOT EXISTS restaurant_recipes_tenant_idx ON public.restaurant_recipes (tenant_id, status);

CREATE INDEX IF NOT EXISTS restaurant_recipes_lineage_idx ON public.restaurant_recipes (lineage_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_recipes TO authenticated;

GRANT ALL ON public.restaurant_recipes TO service_role;

ALTER TABLE public.restaurant_recipes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_recipes_updated_at BEFORE UPDATE ON public.restaurant_recipes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_recipe_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES public.restaurant_recipes(id) ON DELETE CASCADE,
  component_kind public.restaurant_recipe_component_kind NOT NULL DEFAULT 'inventory_item',
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE RESTRICT,
  sub_recipe_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL DEFAULT 0,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  yield_percent numeric NOT NULL DEFAULT 100,
  is_optional boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (component_kind = 'inventory_item' AND inventory_item_id IS NOT NULL AND sub_recipe_id IS NULL)
    OR (component_kind = 'sub_recipe' AND sub_recipe_id IS NOT NULL AND inventory_item_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS restaurant_recipe_lines_recipe_idx ON public.restaurant_recipe_lines (recipe_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_recipe_lines TO authenticated;

GRANT ALL ON public.restaurant_recipe_lines TO service_role;

ALTER TABLE public.restaurant_recipe_lines ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_recipe_lines_updated_at BEFORE UPDATE ON public.restaurant_recipe_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_recipe_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES public.restaurant_recipes(id) ON DELETE CASCADE,
  recipe_version integer NOT NULL DEFAULT 1,
  ingredient_cost numeric NOT NULL DEFAULT 0,
  sub_recipe_cost numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  cost_per_yield_unit numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_by uuid,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_recipe_cost_history_idx
  ON public.restaurant_recipe_cost_history (tenant_id, recipe_id, computed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_recipe_cost_history TO authenticated;

GRANT ALL ON public.restaurant_recipe_cost_history TO service_role;

ALTER TABLE public.restaurant_recipe_cost_history ENABLE ROW LEVEL SECURITY;

/* ---------- 2. Products ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  sku text NOT NULL,
  name text NOT NULL,
  description text,
  product_type public.restaurant_product_type NOT NULL DEFAULT 'standard',
  category_id uuid REFERENCES public.restaurant_categories(id) ON DELETE SET NULL,
  recipe_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE SET NULL,
  menu_item_id uuid REFERENCES public.restaurant_menu_items(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  station_id uuid REFERENCES public.restaurant_stations(id) ON DELETE SET NULL,
  price numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  tax_rate numeric NOT NULL DEFAULT 0,
  tax_code text,
  prep_time_target_minutes integer,
  service_period_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS restaurant_products_tenant_idx ON public.restaurant_products (tenant_id, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_products TO authenticated;

GRANT ALL ON public.restaurant_products TO service_role;

ALTER TABLE public.restaurant_products ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_products_updated_at BEFORE UPDATE ON public.restaurant_products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.restaurant_products(id) ON DELETE CASCADE,
  sku text,
  name text NOT NULL,
  price numeric NOT NULL DEFAULT 0,
  price_is_delta boolean NOT NULL DEFAULT false,
  recipe_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE SET NULL,
  yield_factor numeric NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_product_variants TO authenticated;

GRANT ALL ON public.restaurant_product_variants TO service_role;

ALTER TABLE public.restaurant_product_variants ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_product_variants_updated_at BEFORE UPDATE ON public.restaurant_product_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 3. Modifiers ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer NOT NULL DEFAULT 1,
  required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_modifier_groups TO authenticated;

GRANT ALL ON public.restaurant_modifier_groups TO service_role;

ALTER TABLE public.restaurant_modifier_groups ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_modifier_groups_updated_at BEFORE UPDATE ON public.restaurant_modifier_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.restaurant_modifier_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_delta numeric NOT NULL DEFAULT 0,
  effect public.restaurant_modifier_effect NOT NULL DEFAULT 'none',
  inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  recipe_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE SET NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_modifiers_group_idx ON public.restaurant_modifiers (group_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_modifiers TO authenticated;

GRANT ALL ON public.restaurant_modifiers TO service_role;

ALTER TABLE public.restaurant_modifiers ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_modifiers_updated_at BEFORE UPDATE ON public.restaurant_modifiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_product_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.restaurant_products(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.restaurant_modifier_groups(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, group_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_product_modifier_groups TO authenticated;

GRANT ALL ON public.restaurant_product_modifier_groups TO service_role;

ALTER TABLE public.restaurant_product_modifier_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.restaurant_bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  bundle_product_id uuid NOT NULL REFERENCES public.restaurant_products(id) ON DELETE CASCADE,
  component_product_id uuid NOT NULL REFERENCES public.restaurant_products(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL DEFAULT 1,
  price_allocation numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle_product_id, component_product_id),
  CHECK (bundle_product_id <> component_product_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_bundle_components TO authenticated;

GRANT ALL ON public.restaurant_bundle_components TO service_role;

ALTER TABLE public.restaurant_bundle_components ENABLE ROW LEVEL SECURITY;

/* ---------- 4. Production ---------- */

CREATE TABLE IF NOT EXISTS public.restaurant_productions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  production_number text NOT NULL,
  recipe_id uuid NOT NULL REFERENCES public.restaurant_recipes(id) ON DELETE RESTRICT,
  recipe_version integer NOT NULL DEFAULT 1,
  status public.restaurant_production_status NOT NULL DEFAULT 'draft',
  production_location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  output_location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  output_inventory_item_id uuid REFERENCES public.restaurant_inventory_items(id) ON DELETE SET NULL,
  batches numeric NOT NULL DEFAULT 1,
  planned_quantity numeric NOT NULL DEFAULT 0,
  actual_quantity numeric,
  yield_variance_quantity numeric,
  yield_variance_percent numeric,
  input_cost numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  output_movement_id uuid REFERENCES public.restaurant_stock_movements(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  started_by uuid,
  completed_by uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, production_number)
);

CREATE INDEX IF NOT EXISTS restaurant_productions_tenant_idx ON public.restaurant_productions (tenant_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_productions TO authenticated;

GRANT ALL ON public.restaurant_productions TO service_role;

ALTER TABLE public.restaurant_productions ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_productions_updated_at BEFORE UPDATE ON public.restaurant_productions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.restaurant_production_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  production_id uuid NOT NULL REFERENCES public.restaurant_productions(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE RESTRICT,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  planned_quantity numeric NOT NULL DEFAULT 0,
  actual_quantity numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  movement_id uuid REFERENCES public.restaurant_stock_movements(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_production_inputs_idx ON public.restaurant_production_inputs (production_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_production_inputs TO authenticated;

GRANT ALL ON public.restaurant_production_inputs TO service_role;

ALTER TABLE public.restaurant_production_inputs ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_production_inputs_updated_at BEFORE UPDATE ON public.restaurant_production_inputs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

/* ---------- 5. Links into existing operational tables ---------- */

ALTER TABLE public.restaurant_stock_movements
  ADD COLUMN IF NOT EXISTS production_id uuid REFERENCES public.restaurant_productions(id) ON DELETE SET NULL;

ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS recipe_id uuid REFERENCES public.restaurant_recipes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipe_version integer,
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.restaurant_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS theoretical_cost numeric NOT NULL DEFAULT 0;

-- ---------- Currencies ----------
CREATE TABLE public.restaurant_currencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  symbol text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  decimals smallint NOT NULL DEFAULT 2,
  rounding numeric(10,4) NOT NULL DEFAULT 0.01,
  is_base boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_currencies TO authenticated;

GRANT ALL ON public.restaurant_currencies TO service_role;

ALTER TABLE public.restaurant_currencies ENABLE ROW LEVEL SECURITY;

-- ---------- Exchange rates ----------
CREATE TABLE public.restaurant_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  base_currency text NOT NULL,
  target_currency text NOT NULL,
  rate numeric(18,8) NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  manual_override boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rest_fx_lookup ON public.restaurant_exchange_rates (tenant_id, base_currency, target_currency, effective_from DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_exchange_rates TO authenticated;

GRANT ALL ON public.restaurant_exchange_rates TO service_role;

ALTER TABLE public.restaurant_exchange_rates ENABLE ROW LEVEL SECURITY;

-- ---------- Versioned prices ----------
CREATE TABLE public.restaurant_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.restaurant_products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.restaurant_product_variants(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES public.restaurant_menu_items(id) ON DELETE CASCADE,
  scope restaurant_price_scope NOT NULL DEFAULT 'tenant',
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD',
  amount numeric(14,4) NOT NULL,
  tax_inclusive boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  status restaurant_price_status NOT NULL DEFAULT 'draft',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  reason text,
  supersedes_id uuid REFERENCES public.restaurant_prices(id) ON DELETE SET NULL,
  requires_approval boolean NOT NULL DEFAULT false,
  approved_by uuid,
  approved_at timestamptz,
  rejected_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rest_prices_resolution ON public.restaurant_prices (tenant_id, product_id, status, effective_from DESC);

CREATE INDEX idx_rest_prices_menu_item ON public.restaurant_prices (tenant_id, menu_item_id, status, effective_from DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_prices TO authenticated;

GRANT ALL ON public.restaurant_prices TO service_role;

ALTER TABLE public.restaurant_prices ENABLE ROW LEVEL SECURITY;

-- ---------- Tax rules ----------
CREATE TABLE public.restaurant_tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  basis restaurant_charge_basis NOT NULL DEFAULT 'percent',
  rate numeric(9,4) NOT NULL DEFAULT 0,
  fixed_amount numeric(14,4) NOT NULL DEFAULT 0,
  inclusive boolean NOT NULL DEFAULT false,
  applies_to_categories uuid[] NOT NULL DEFAULT '{}',
  applies_to_products uuid[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 100,
  compound boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, effective_from)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_tax_rules TO authenticated;

GRANT ALL ON public.restaurant_tax_rules TO service_role;

ALTER TABLE public.restaurant_tax_rules ENABLE ROW LEVEL SECURITY;

-- ---------- Service charges ----------
CREATE TABLE public.restaurant_service_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  basis restaurant_charge_basis NOT NULL DEFAULT 'percent',
  rate numeric(9,4) NOT NULL DEFAULT 0,
  fixed_amount numeric(14,4) NOT NULL DEFAULT 0,
  applies_to_categories uuid[] NOT NULL DEFAULT '{}',
  applies_to_products uuid[] NOT NULL DEFAULT '{}',
  applies_to_order_types text[] NOT NULL DEFAULT '{}',
  taxable boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, effective_from)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_service_charges TO authenticated;

GRANT ALL ON public.restaurant_service_charges TO service_role;

ALTER TABLE public.restaurant_service_charges ENABLE ROW LEVEL SECURITY;

-- ---------- Discount rules ----------
CREATE TABLE public.restaurant_discount_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  scope restaurant_discount_scope NOT NULL DEFAULT 'order',
  basis restaurant_charge_basis NOT NULL DEFAULT 'percent',
  value numeric(14,4) NOT NULL DEFAULT 0,
  max_percent numeric(6,2) NOT NULL DEFAULT 100,
  applies_to_categories uuid[] NOT NULL DEFAULT '{}',
  applies_to_products uuid[] NOT NULL DEFAULT '{}',
  requires_reason boolean NOT NULL DEFAULT true,
  approval_threshold_percent numeric(6,2),
  role_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_discount_rules TO authenticated;

GRANT ALL ON public.restaurant_discount_rules TO service_role;

ALTER TABLE public.restaurant_discount_rules ENABLE ROW LEVEL SECURITY;

-- ---------- Discount applications (append-only audit) ----------
CREATE TABLE public.restaurant_discount_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  discount_rule_id uuid REFERENCES public.restaurant_discount_rules(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.restaurant_orders(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.restaurant_order_items(id) ON DELETE CASCADE,
  scope restaurant_discount_scope NOT NULL DEFAULT 'order',
  basis restaurant_charge_basis NOT NULL DEFAULT 'percent',
  value numeric(14,4) NOT NULL DEFAULT 0,
  amount numeric(14,4) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  reason text,
  actor_id uuid,
  actor_role text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rest_discount_app_order ON public.restaurant_discount_applications (tenant_id, order_id);

GRANT SELECT, INSERT ON public.restaurant_discount_applications TO authenticated;

GRANT ALL ON public.restaurant_discount_applications TO service_role;

ALTER TABLE public.restaurant_discount_applications ENABLE ROW LEVEL SECURITY;

-- ---------- Promotions ----------
CREATE TABLE public.restaurant_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  action restaurant_promotion_action NOT NULL DEFAULT 'percent_discount',
  value numeric(14,4) NOT NULL DEFAULT 0,
  currency text,
  applies_to_categories uuid[] NOT NULL DEFAULT '{}',
  applies_to_products uuid[] NOT NULL DEFAULT '{}',
  days_of_week smallint[] NOT NULL DEFAULT '{}',
  start_time time,
  end_time time,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  priority integer NOT NULL DEFAULT 100,
  stackable boolean NOT NULL DEFAULT false,
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  status restaurant_promotion_status NOT NULL DEFAULT 'draft',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_promotions TO authenticated;

GRANT ALL ON public.restaurant_promotions TO service_role;

ALTER TABLE public.restaurant_promotions ENABLE ROW LEVEL SECURITY;

-- ---------- Pricing audit (append-only) ----------
CREATE TABLE public.restaurant_pricing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  actor_id uuid,
  correlation_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rest_pricing_audit ON public.restaurant_pricing_audit (tenant_id, entity_type, created_at DESC);

GRANT SELECT, INSERT ON public.restaurant_pricing_audit TO authenticated;

GRANT ALL ON public.restaurant_pricing_audit TO service_role;

ALTER TABLE public.restaurant_pricing_audit ENABLE ROW LEVEL SECURITY;

-- ---------- Transaction snapshots ----------
ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS price_id uuid REFERENCES public.restaurant_prices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_source text,
  ADD COLUMN IF NOT EXISTS base_unit_price numeric(14,4),
  ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES public.restaurant_promotions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_rule_id uuid REFERENCES public.restaurant_discount_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_reason text,
  ADD COLUMN IF NOT EXISTS tax_rule_id uuid REFERENCES public.restaurant_tax_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_charge_amount numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_charge_id uuid REFERENCES public.restaurant_service_charges(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_trace jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.restaurant_orders
  ADD COLUMN IF NOT EXISTS base_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8) NOT NULL DEFAULT 1;

-- ---------- updated_at triggers ----------
CREATE TRIGGER trg_rest_currencies_updated BEFORE UPDATE ON public.restaurant_currencies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_fx_updated BEFORE UPDATE ON public.restaurant_exchange_rates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_prices_updated BEFORE UPDATE ON public.restaurant_prices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_tax_updated BEFORE UPDATE ON public.restaurant_tax_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_svc_updated BEFORE UPDATE ON public.restaurant_service_charges FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_disc_updated BEFORE UPDATE ON public.restaurant_discount_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_rest_promo_updated BEFORE UPDATE ON public.restaurant_promotions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ Order items: seat, variant, modifiers, void audit ============
ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS seat_number smallint,
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.restaurant_product_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS modifier_total numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guest_notes text,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE INDEX IF NOT EXISTS restaurant_order_items_variant_idx
  ON public.restaurant_order_items (variant_id) WHERE variant_id IS NOT NULL;

-- ============ Orders: terminal, idempotency, reopen audit ============
ALTER TABLE public.restaurant_orders
  ADD COLUMN IF NOT EXISTS terminal_id text,
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by uuid,
  ADD COLUMN IF NOT EXISTS reopen_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_orders_client_request_idx
  ON public.restaurant_orders (tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ============ Payments: idempotency + refund linkage ============
ALTER TABLE public.restaurant_payments
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS refund_of uuid REFERENCES public.restaurant_payments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_payments_client_request_idx
  ON public.restaurant_payments (tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ============ Receipts: immutable evidence of a closed bill ============
CREATE TABLE IF NOT EXISTS public.restaurant_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  location_id uuid,
  order_id uuid NOT NULL REFERENCES public.restaurant_orders(id) ON DELETE CASCADE,
  receipt_number text NOT NULL,
  currency text NOT NULL DEFAULT 'TZS',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  service_charge numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  paid_total numeric(14,2) NOT NULL DEFAULT 0,
  cost_total numeric(14,4) NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reprint_count integer NOT NULL DEFAULT 0,
  issued_by uuid,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_receipts_order_idx
  ON public.restaurant_receipts (order_id);

GRANT SELECT, INSERT, UPDATE ON public.restaurant_receipts TO authenticated;

GRANT ALL ON public.restaurant_receipts TO service_role;

ALTER TABLE public.restaurant_receipts ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_receipts_set_updated_at
  BEFORE UPDATE ON public.restaurant_receipts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.restaurant_requisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  reference text NOT NULL,
  kind text NOT NULL DEFAULT 'kitchen',
  department text,
  source_location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT,
  destination_location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE RESTRICT,
  status public.restaurant_requisition_status NOT NULL DEFAULT 'draft',
  required_date date,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid,
  requested_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  issued_by uuid,
  issued_at timestamptz,
  rejected_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);

CREATE TABLE public.restaurant_requisition_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  requisition_id uuid NOT NULL REFERENCES public.restaurant_requisitions(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.restaurant_inventory_items(id) ON DELETE RESTRICT,
  unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL,
  description text,
  requested_quantity numeric NOT NULL DEFAULT 0,
  approved_quantity numeric,
  issued_quantity numeric NOT NULL DEFAULT 0,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurant_requisitions_tenant_status ON public.restaurant_requisitions (tenant_id, status, created_at DESC);

CREATE INDEX idx_restaurant_requisition_lines_req ON public.restaurant_requisition_lines (requisition_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_requisitions TO authenticated;

GRANT ALL ON public.restaurant_requisitions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_requisition_lines TO authenticated;

GRANT ALL ON public.restaurant_requisition_lines TO service_role;

ALTER TABLE public.restaurant_requisitions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.restaurant_requisition_lines ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER set_restaurant_requisitions_updated_at BEFORE UPDATE ON public.restaurant_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_restaurant_requisition_lines_updated_at BEFORE UPDATE ON public.restaurant_requisition_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.restaurant_inventory_items
  ADD COLUMN IF NOT EXISTS is_beverage boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS serving_size numeric(14,4),
  ADD COLUMN IF NOT EXISTS serving_unit_id uuid REFERENCES public.restaurant_inventory_units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS restaurant_inventory_items_beverage_idx
  ON public.restaurant_inventory_items (tenant_id, is_beverage);

ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS is_comp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comp_reason text,
  ADD COLUMN IF NOT EXISTS comp_by uuid,
  ADD COLUMN IF NOT EXISTS comp_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS restaurant_order_items_comp_idx
  ON public.restaurant_order_items (tenant_id, is_comp) WHERE is_comp;

-- ---------- Price lists ----------
CREATE TABLE IF NOT EXISTS public.restaurant_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  currency text NOT NULL DEFAULT 'TZS',
  channel text,
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'draft',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_default boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_rest_price_lists_tenant ON public.restaurant_price_lists (tenant_id, status, priority);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_price_lists TO authenticated;

GRANT ALL ON public.restaurant_price_lists TO service_role;

ALTER TABLE public.restaurant_price_lists ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_rest_price_lists_updated_at
  BEFORE UPDATE ON public.restaurant_price_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- Rounding policies ----------
CREATE TABLE IF NOT EXISTS public.restaurant_rounding_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  target text NOT NULL DEFAULT 'total',
  mode text NOT NULL DEFAULT 'nearest',
  increment numeric(14,4) NOT NULL DEFAULT 0.01,
  decimals smallint NOT NULL DEFAULT 2,
  currency text,
  channel text,
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT restaurant_rounding_target_chk CHECK (target IN ('line','total','payment')),
  CONSTRAINT restaurant_rounding_mode_chk CHECK (mode IN ('none','nearest','up','down'))
);

CREATE INDEX IF NOT EXISTS idx_rest_rounding_tenant ON public.restaurant_rounding_rules (tenant_id, target, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_rounding_rules TO authenticated;

GRANT ALL ON public.restaurant_rounding_rules TO service_role;

ALTER TABLE public.restaurant_rounding_rules ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_rest_rounding_updated_at
  BEFORE UPDATE ON public.restaurant_rounding_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- Channel + price-list scope on existing commercial rules ----------
ALTER TABLE public.restaurant_prices
  ADD COLUMN IF NOT EXISTS price_list_id uuid REFERENCES public.restaurant_price_lists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel text;

ALTER TABLE public.restaurant_promotions
  ADD COLUMN IF NOT EXISTS applies_to_channels text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.restaurant_tax_rules
  ADD COLUMN IF NOT EXISTS applies_to_channels text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.restaurant_service_charges
  ADD COLUMN IF NOT EXISTS applies_to_channels text[] NOT NULL DEFAULT '{}';

-- ---------- Historical explainability on sold lines ----------
ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS price_list_id uuid REFERENCES public.restaurant_price_lists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel text;

CREATE TABLE public.restaurant_document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  location_id uuid,
  document_type text NOT NULL,
  document_id uuid,
  document_number text,
  action text NOT NULL,
  format text,
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.restaurant_document_events TO authenticated;

GRANT ALL ON public.restaurant_document_events TO service_role;

ALTER TABLE public.restaurant_document_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX restaurant_document_events_tenant_idx
  ON public.restaurant_document_events (tenant_id, created_at DESC);

CREATE INDEX restaurant_document_events_doc_idx
  ON public.restaurant_document_events (tenant_id, document_type, document_id);

CREATE INDEX restaurant_document_events_number_idx
  ON public.restaurant_document_events (tenant_id, document_number);

ALTER TABLE public.restaurant_orders
  ADD COLUMN IF NOT EXISTS bill_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS bill_requested_by uuid,
  ADD COLUMN IF NOT EXISTS bill_presented_at timestamptz;

ALTER TABLE public.restaurant_receipts
  ADD COLUMN IF NOT EXISTS delivery_channel text,
  ADD COLUMN IF NOT EXISTS delivered_to text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reprint_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reprint_by uuid;

ALTER TABLE public.restaurant_payments
  ADD COLUMN IF NOT EXISTS refund_reason text;

CREATE INDEX IF NOT EXISTS restaurant_receipts_number_idx
  ON public.restaurant_receipts (tenant_id, receipt_number);

CREATE INDEX IF NOT EXISTS restaurant_receipts_issued_idx
  ON public.restaurant_receipts (tenant_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS restaurant_orders_bill_requested_idx
  ON public.restaurant_orders (tenant_id, bill_requested_at DESC);

-- Sprint 5.11: menu lifecycle, allergen model, guest dietary context

alter table public.restaurant_menu_items
  add column if not exists lifecycle_status text not null default 'draft',
  add column if not exists lifecycle_changed_at timestamptz not null default now(),
  add column if not exists lifecycle_changed_by uuid,
  add column if not exists discontinued_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists unavailable_reason text,
  add column if not exists allergen_status text not null default 'unknown',
  add column if not exists allergen_reviewed_at timestamptz,
  add column if not exists allergen_reviewed_by uuid;

create index if not exists restaurant_menu_items_lifecycle_idx
  on public.restaurant_menu_items (tenant_id, lifecycle_status);

alter table public.restaurant_inventory_items
  add column if not exists allergens text[] not null default '{}'::text[],
  add column if not exists allergen_status text not null default 'unknown',
  add column if not exists allergen_reviewed_at timestamptz,
  add column if not exists allergen_reviewed_by uuid;

CREATE TABLE public.restaurant_daily_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'TZS',
  opening_float numeric(14,2) NOT NULL DEFAULT 0,
  service_periods jsonb NOT NULL DEFAULT '[]'::jsonb,
  system_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  declared_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  declared_variance numeric(14,2) NOT NULL DEFAULT 0,
  exceptions_open integer NOT NULL DEFAULT 0,
  notes text,
  declared_by uuid,
  declared_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  reopened_by uuid,
  reopened_at timestamptz,
  reopen_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX restaurant_daily_closes_unique
  ON public.restaurant_daily_closes (tenant_id, business_date, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX restaurant_daily_closes_date_idx ON public.restaurant_daily_closes (tenant_id, business_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_daily_closes TO authenticated;

GRANT ALL ON public.restaurant_daily_closes TO service_role;

ALTER TABLE public.restaurant_daily_closes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_daily_closes_updated_at BEFORE UPDATE ON public.restaurant_daily_closes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.restaurant_tender_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  close_id uuid NOT NULL REFERENCES public.restaurant_daily_closes(id) ON DELETE CASCADE,
  method text NOT NULL,
  system_amount numeric(14,2) NOT NULL DEFAULT 0,
  declared_amount numeric(14,2) NOT NULL DEFAULT 0,
  variance numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  notes text,
  declared_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (close_id, method)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_tender_declarations TO authenticated;

GRANT ALL ON public.restaurant_tender_declarations TO service_role;

ALTER TABLE public.restaurant_tender_declarations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_tender_declarations_updated_at BEFORE UPDATE ON public.restaurant_tender_declarations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.restaurant_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  business_date date NOT NULL,
  scope text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  exceptions_opened integer NOT NULL DEFAULT 0,
  exceptions_existing integer NOT NULL DEFAULT 0,
  run_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX restaurant_reconciliation_runs_idx ON public.restaurant_reconciliation_runs (tenant_id, business_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_reconciliation_runs TO authenticated;

GRANT ALL ON public.restaurant_reconciliation_runs TO service_role;

ALTER TABLE public.restaurant_reconciliation_runs ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_reconciliation_runs_updated_at BEFORE UPDATE ON public.restaurant_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.restaurant_reconciliation_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  run_id uuid REFERENCES public.restaurant_reconciliation_runs(id) ON DELETE SET NULL,
  close_id uuid REFERENCES public.restaurant_daily_closes(id) ON DELETE SET NULL,
  business_date date NOT NULL,
  domain text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  title text NOT NULL,
  what_happened text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  impact_value numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  required_action text NOT NULL,
  entity_type text,
  entity_id uuid,
  dedupe_key text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolution text,
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX restaurant_reconciliation_exceptions_open_idx
  ON public.restaurant_reconciliation_exceptions (tenant_id, status, business_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_reconciliation_exceptions TO authenticated;

GRANT ALL ON public.restaurant_reconciliation_exceptions TO service_role;

ALTER TABLE public.restaurant_reconciliation_exceptions ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER restaurant_reconciliation_exceptions_updated_at BEFORE UPDATE ON public.restaurant_reconciliation_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.restaurant_reconciliation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  business_date date,
  action text NOT NULL,
  previous_state text,
  new_state text,
  reason text,
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX restaurant_reconciliation_audit_idx ON public.restaurant_reconciliation_audit (tenant_id, subject_id, created_at DESC);

GRANT SELECT, INSERT ON public.restaurant_reconciliation_audit TO authenticated;

GRANT ALL ON public.restaurant_reconciliation_audit TO service_role;

ALTER TABLE public.restaurant_reconciliation_audit ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.restaurant_receipt_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  property_id uuid,
  location_id uuid,
  receipt_id uuid NOT NULL REFERENCES public.restaurant_receipts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  receipt_number text,
  method text NOT NULL CHECK (method IN ('print','email','whatsapp','secure_link')),
  recipient text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','delivered','failed','shared')),
  provider text,
  provider_reference text,
  failure_code text,
  failure_reason text,
  attempt integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  share_token text,
  share_expires_at timestamptz,
  correlation_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX restaurant_receipt_deliveries_idem_key
  ON public.restaurant_receipt_deliveries (tenant_id, idempotency_key);

CREATE UNIQUE INDEX restaurant_receipt_deliveries_share_token
  ON public.restaurant_receipt_deliveries (share_token) WHERE share_token IS NOT NULL;

CREATE INDEX restaurant_receipt_deliveries_receipt_idx
  ON public.restaurant_receipt_deliveries (tenant_id, receipt_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.restaurant_receipt_deliveries TO authenticated;

GRANT ALL ON public.restaurant_receipt_deliveries TO service_role;

ALTER TABLE public.restaurant_receipt_deliveries ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.pms_folio_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL /* [standalone] external system ref */,
  guest_id uuid /* [standalone] external system ref */,
  room_id uuid /* [standalone] external system ref */,
  unit_label text,
  source_system text NOT NULL DEFAULT 'restaurant_pos',
  source_tenant_id uuid,
  source_property_id uuid,
  source_location_id uuid,
  source_order_id uuid,
  source_payment_id uuid,
  idempotency_key text NOT NULL,
  correlation_id text,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  description text NOT NULL DEFAULT 'Outlet charge',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed','unknown','reversed')),
  folio_reference text,
  posting_reference text,
  failure_code text,
  failure_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  created_by uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.restaurant_orders
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE public.restaurant_goods_receipt_items
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.restaurant_inventory_batches(id) ON DELETE SET NULL;

-- One logical reversal per original movement, enforced by the database and not
-- by the UI: a retried void, a replayed request and a double tap collapse into
-- the same single correction.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_stock_movements_reversal_once_idx
  ON public.restaurant_stock_movements (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

DROP TRIGGER IF EXISTS enforce_purchase_order_transition ON public.restaurant_purchase_orders;

CREATE TRIGGER enforce_purchase_order_transition
BEFORE UPDATE OF status ON public.restaurant_purchase_orders
FOR EACH ROW
EXECUTE FUNCTION public.enforce_purchase_order_transition();

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurant_tenants','restaurant_properties','restaurant_locations','restaurant_members',
    'restaurant_subscriptions','restaurant_categories','restaurant_menus','restaurant_menu_items',
    'restaurant_inventory_units','restaurant_inventory_categories','restaurant_inventory_items',
    'restaurant_suppliers','restaurant_supplier_products','restaurant_purchase_orders',
    'restaurant_purchase_order_items','restaurant_recipe_components','restaurant_recipe_costs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.restaurant_can_read(_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.restaurant_members m
                WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.restaurant_can_write(_tenant_id uuid, _roles public.restaurant_role[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.restaurant_members m
                WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
                  AND m.role = ANY(_roles))
  );
$$;

do $$ begin
  alter table public.restaurant_menu_items
    add constraint restaurant_menu_items_lifecycle_chk
    check (lifecycle_status in ('draft','active','paused','discontinued','archived'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.restaurant_menu_items
    add constraint restaurant_menu_items_allergen_status_chk
    check (allergen_status in ('unknown','declared','none'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.restaurant_inventory_items
    add constraint restaurant_inventory_items_allergen_status_chk
    check (allergen_status in ('unknown','declared','none'));
exception when duplicate_object then null; end $$;

-- tenants
CREATE POLICY "tenant read" ON public.restaurant_tenants FOR SELECT TO authenticated
  USING (public.restaurant_can_read(id));

CREATE POLICY "tenant write" ON public.restaurant_tenants FOR ALL TO authenticated
  USING (public.restaurant_can_write(id, ARRAY['owner','general_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(id, ARRAY['owner','general_manager']::public.restaurant_role[]));

CREATE POLICY "members read" ON public.restaurant_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.restaurant_can_read(tenant_id));

CREATE POLICY "members write" ON public.restaurant_members FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[]));

CREATE POLICY "subscriptions read" ON public.restaurant_subscriptions FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

-- properties / locations
CREATE POLICY "properties read" ON public.restaurant_properties FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "properties write" ON public.restaurant_properties FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[]));

CREATE POLICY "locations read" ON public.restaurant_locations FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "locations write" ON public.restaurant_locations FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[]));

-- menu domain
CREATE POLICY "categories read" ON public.restaurant_categories FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "categories write" ON public.restaurant_categories FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]));

CREATE POLICY "menus read" ON public.restaurant_menus FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "menus write" ON public.restaurant_menus FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]));

CREATE POLICY "menu items read" ON public.restaurant_menu_items FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "menu items write" ON public.restaurant_menu_items FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[]));

-- inventory domain
CREATE POLICY "units read" ON public.restaurant_inventory_units FOR SELECT TO authenticated
  USING (tenant_id IS NULL OR public.restaurant_can_read(tenant_id));

CREATE POLICY "units write" ON public.restaurant_inventory_units FOR ALL TO authenticated
  USING (tenant_id IS NOT NULL AND public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager']::public.restaurant_role[]))
  WITH CHECK (tenant_id IS NOT NULL AND public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager']::public.restaurant_role[]));

CREATE POLICY "inv categories read" ON public.restaurant_inventory_categories FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "inv categories write" ON public.restaurant_inventory_categories FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef']::public.restaurant_role[]));

CREATE POLICY "inv items read" ON public.restaurant_inventory_items FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "inv items write" ON public.restaurant_inventory_items FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[]));

-- suppliers & purchasing
CREATE POLICY "suppliers read" ON public.restaurant_suppliers FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "suppliers write" ON public.restaurant_suppliers FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager']::public.restaurant_role[]));

CREATE POLICY "supplier products read" ON public.restaurant_supplier_products FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "supplier products write" ON public.restaurant_supplier_products FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager']::public.restaurant_role[]));

CREATE POLICY "po read" ON public.restaurant_purchase_orders FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "po write" ON public.restaurant_purchase_orders FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[]));

CREATE POLICY "po items read" ON public.restaurant_purchase_order_items FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "po items write" ON public.restaurant_purchase_order_items FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::public.restaurant_role[]));

-- costing
CREATE POLICY "recipe components read" ON public.restaurant_recipe_components FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "recipe components write" ON public.restaurant_recipe_components FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[]));

CREATE POLICY "recipe costs read" ON public.restaurant_recipe_costs FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "recipe costs write" ON public.restaurant_recipe_costs FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::public.restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::public.restaurant_role[]));

REVOKE EXECUTE ON FUNCTION public.restaurant_can_read(uuid) FROM anon, public;

REVOKE EXECUTE ON FUNCTION public.restaurant_can_write(uuid, public.restaurant_role[]) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.restaurant_can_read(uuid) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.restaurant_can_write(uuid, public.restaurant_role[]) TO authenticated, service_role;

create policy "service periods readable by tenant" on public.restaurant_service_periods for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "service periods managed by tenant" on public.restaurant_service_periods for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]));

create policy "tables readable by tenant" on public.restaurant_tables for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "tables managed by tenant" on public.restaurant_tables for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender']::restaurant_role[]));

create policy "orders readable by tenant" on public.restaurant_orders for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "orders managed by tenant" on public.restaurant_orders for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));

create policy "order items readable by tenant" on public.restaurant_order_items for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "order items managed by tenant" on public.restaurant_order_items for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager']::restaurant_role[]));

create policy "payments readable by tenant" on public.restaurant_payments for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "payments managed by tenant" on public.restaurant_payments for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]));

create policy "stations readable by tenant" on public.restaurant_stations for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "stations managed by tenant" on public.restaurant_stations for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

create policy "tickets readable by tenant" on public.restaurant_kitchen_tickets for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "tickets managed by tenant" on public.restaurant_kitchen_tickets for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[]));

create policy "ticket items readable by tenant" on public.restaurant_kitchen_ticket_items for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "ticket items managed by tenant" on public.restaurant_kitchen_ticket_items for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::restaurant_role[]));

create policy "movements readable by tenant" on public.restaurant_stock_movements for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "movements managed by tenant" on public.restaurant_stock_movements for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender','purchasing_officer']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender','purchasing_officer']::restaurant_role[]));

create policy "profitability readable by tenant" on public.restaurant_profitability_snapshots for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "profitability managed by tenant" on public.restaurant_profitability_snapshots for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[]));

create policy "doc seq read" on public.restaurant_document_sequences for select using (public.restaurant_can_read(tenant_id));

create policy "doc seq write" on public.restaurant_document_sequences for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]));

create policy "pr read" on public.restaurant_purchase_requests for select using (public.restaurant_can_read(tenant_id));

create policy "pr write" on public.restaurant_purchase_requests for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[]));

create policy "pr items read" on public.restaurant_purchase_request_items for select using (public.restaurant_can_read(tenant_id));

create policy "pr items write" on public.restaurant_purchase_request_items for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager','bartender']::restaurant_role[]));

create policy "approval rules read" on public.restaurant_approval_rules for select using (public.restaurant_can_read(tenant_id));

create policy "approval rules write" on public.restaurant_approval_rules for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager']::restaurant_role[]));

create policy "confirmation read" on public.restaurant_supplier_confirmations for select using (public.restaurant_can_read(tenant_id));

create policy "confirmation write" on public.restaurant_supplier_confirmations for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]));

create policy "confirmation items read" on public.restaurant_supplier_confirmation_items for select using (public.restaurant_can_read(tenant_id));

create policy "confirmation items write" on public.restaurant_supplier_confirmation_items for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]));

create policy "receipt read" on public.restaurant_goods_receipts for select using (public.restaurant_can_read(tenant_id));

create policy "receipt write" on public.restaurant_goods_receipts for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]));

create policy "receipt items read" on public.restaurant_goods_receipt_items for select using (public.restaurant_can_read(tenant_id));

create policy "receipt items write" on public.restaurant_goods_receipt_items for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]));

create policy "variance read" on public.restaurant_procurement_variances for select using (public.restaurant_can_read(tenant_id));

create policy "variance write" on public.restaurant_procurement_variances for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant','chef','kitchen_manager']::restaurant_role[]));

create policy "price history read" on public.restaurant_supplier_price_history for select using (public.restaurant_can_read(tenant_id));

create policy "price history write" on public.restaurant_supplier_price_history for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[]));

create policy "invoice read" on public.restaurant_supplier_invoices for select using (public.restaurant_can_read(tenant_id));

create policy "invoice write" on public.restaurant_supplier_invoices for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','accountant']::restaurant_role[]));

create policy "invoice items read" on public.restaurant_supplier_invoice_items for select using (public.restaurant_can_read(tenant_id));

create policy "invoice items write" on public.restaurant_supplier_invoice_items for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','purchasing_officer','accountant']::restaurant_role[]));

create policy "procurement audit read" on public.restaurant_procurement_audit for select using (public.restaurant_can_read(tenant_id));

create policy "procurement audit append" on public.restaurant_procurement_audit for insert
  with check (public.restaurant_can_read(tenant_id) and actor_id = auth.uid());

CREATE POLICY "inventory reasons read" ON public.restaurant_inventory_reasons
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "inventory reasons write" ON public.restaurant_inventory_reasons
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager']::restaurant_role[]));

CREATE POLICY "inventory batches read" ON public.restaurant_inventory_batches
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "inventory batches write" ON public.restaurant_inventory_batches
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','purchasing_officer']::restaurant_role[]));

CREATE POLICY "stock transfers read" ON public.restaurant_stock_transfers
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "stock transfers write" ON public.restaurant_stock_transfers
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "stock transfer lines read" ON public.restaurant_stock_transfer_lines
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "stock transfer lines write" ON public.restaurant_stock_transfer_lines
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "stock reservations read" ON public.restaurant_stock_reservations
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "stock reservations write" ON public.restaurant_stock_reservations
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "stocktakes read" ON public.restaurant_stocktakes
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "stocktakes write" ON public.restaurant_stocktakes
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "stocktake lines read" ON public.restaurant_stocktake_lines
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "stocktake lines write" ON public.restaurant_stocktake_lines
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "recipes read" ON public.restaurant_recipes
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "recipes write" ON public.restaurant_recipes
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "recipe lines read" ON public.restaurant_recipe_lines
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "recipe lines write" ON public.restaurant_recipe_lines
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "recipe cost history read" ON public.restaurant_recipe_cost_history
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "recipe cost history write" ON public.restaurant_recipe_cost_history
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[]));

CREATE POLICY "products read" ON public.restaurant_products
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "products write" ON public.restaurant_products
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "product variants read" ON public.restaurant_product_variants
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "product variants write" ON public.restaurant_product_variants
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "modifier groups read" ON public.restaurant_modifier_groups
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "modifier groups write" ON public.restaurant_modifier_groups
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "modifiers read" ON public.restaurant_modifiers
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "modifiers write" ON public.restaurant_modifiers
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "product modifier groups read" ON public.restaurant_product_modifier_groups
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "product modifier groups write" ON public.restaurant_product_modifier_groups
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "bundle components read" ON public.restaurant_bundle_components
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "bundle components write" ON public.restaurant_bundle_components
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::restaurant_role[]));

CREATE POLICY "productions read" ON public.restaurant_productions
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "productions write" ON public.restaurant_productions
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[]));

CREATE POLICY "production inputs read" ON public.restaurant_production_inputs
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "production inputs write" ON public.restaurant_production_inputs
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','inventory_manager']::restaurant_role[]));

CREATE POLICY "currencies read" ON public.restaurant_currencies FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "currencies write" ON public.restaurant_currencies FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "fx read" ON public.restaurant_exchange_rates FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "fx write" ON public.restaurant_exchange_rates FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "prices read" ON public.restaurant_prices FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "prices write" ON public.restaurant_prices FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "tax read" ON public.restaurant_tax_rules FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "tax write" ON public.restaurant_tax_rules FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "service charge read" ON public.restaurant_service_charges FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "service charge write" ON public.restaurant_service_charges FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "discount rule read" ON public.restaurant_discount_rules FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "discount rule write" ON public.restaurant_discount_rules FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]));

CREATE POLICY "discount app read" ON public.restaurant_discount_applications FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "discount app insert" ON public.restaurant_discount_applications FOR INSERT TO authenticated WITH CHECK (public.restaurant_can_read(tenant_id));

CREATE POLICY "promotions read" ON public.restaurant_promotions FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "promotions write" ON public.restaurant_promotions FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]));

CREATE POLICY "pricing audit read" ON public.restaurant_pricing_audit FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "pricing audit insert" ON public.restaurant_pricing_audit FOR INSERT TO authenticated WITH CHECK (public.restaurant_can_read(tenant_id));

CREATE POLICY "restaurant_receipts_read"
  ON public.restaurant_receipts FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "restaurant_receipts_write"
  ON public.restaurant_receipts FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]));

CREATE POLICY "requisitions read" ON public.restaurant_requisitions
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "requisitions write" ON public.restaurant_requisitions
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "requisition lines read" ON public.restaurant_requisition_lines
  FOR SELECT TO authenticated USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "requisition lines write" ON public.restaurant_requisition_lines
  FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::restaurant_role[]));

CREATE POLICY "price lists read" ON public.restaurant_price_lists FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "price lists write" ON public.restaurant_price_lists FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]));

CREATE POLICY "rounding rules read" ON public.restaurant_rounding_rules FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "rounding rules write" ON public.restaurant_rounding_rules FOR ALL TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]));

CREATE POLICY "Restaurant members read document events"
  ON public.restaurant_document_events FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "Restaurant members append document events"
  ON public.restaurant_document_events FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_read(tenant_id) AND actor_id = auth.uid());

CREATE POLICY "daily closes read" ON public.restaurant_daily_closes FOR SELECT TO authenticated
  USING (restaurant_can_read(tenant_id));

CREATE POLICY "daily closes write" ON public.restaurant_daily_closes FOR ALL TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "tender declarations read" ON public.restaurant_tender_declarations FOR SELECT TO authenticated
  USING (restaurant_can_read(tenant_id));

CREATE POLICY "tender declarations write" ON public.restaurant_tender_declarations FOR ALL TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));

CREATE POLICY "reconciliation runs read" ON public.restaurant_reconciliation_runs FOR SELECT TO authenticated
  USING (restaurant_can_read(tenant_id));

CREATE POLICY "reconciliation runs write" ON public.restaurant_reconciliation_runs FOR ALL TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager']::restaurant_role[]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager']::restaurant_role[]));

CREATE POLICY "reconciliation exceptions read" ON public.restaurant_reconciliation_exceptions FOR SELECT TO authenticated
  USING (restaurant_can_read(tenant_id));

CREATE POLICY "reconciliation exceptions write" ON public.restaurant_reconciliation_exceptions FOR ALL TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager','purchasing_officer']::restaurant_role[]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant','inventory_manager','purchasing_officer']::restaurant_role[]));

CREATE POLICY "reconciliation audit read" ON public.restaurant_reconciliation_audit FOR SELECT TO authenticated
  USING (restaurant_can_read(tenant_id));

CREATE POLICY "reconciliation audit append" ON public.restaurant_reconciliation_audit FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_read(tenant_id));

CREATE POLICY "receipt deliveries readable by tenant"
  ON public.restaurant_receipt_deliveries FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "receipt deliveries writable by tenant staff"
  ON public.restaurant_receipt_deliveries FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]));

CREATE POLICY "receipt deliveries updatable by tenant staff"
  ON public.restaurant_receipt_deliveries FOR UPDATE TO authenticated
  USING (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]))
  WITH CHECK (public.restaurant_can_write(tenant_id, ARRAY['owner','general_manager','restaurant_manager','bartender','accountant']::restaurant_role[]));

-- 1. Scope restaurant procurement policies to authenticated role
ALTER POLICY "variance read" ON public.restaurant_procurement_variances TO authenticated;

ALTER POLICY "variance write" ON public.restaurant_procurement_variances TO authenticated;

ALTER POLICY "confirmation read" ON public.restaurant_supplier_confirmations TO authenticated;

ALTER POLICY "confirmation write" ON public.restaurant_supplier_confirmations TO authenticated;

ALTER POLICY "confirmation items read" ON public.restaurant_supplier_confirmation_items TO authenticated;

ALTER POLICY "confirmation items write" ON public.restaurant_supplier_confirmation_items TO authenticated;

ALTER POLICY "procurement audit read" ON public.restaurant_procurement_audit TO authenticated;

ALTER POLICY "procurement audit append" ON public.restaurant_procurement_audit TO authenticated;

ALTER POLICY "pr read" ON public.restaurant_purchase_requests TO authenticated;

ALTER POLICY "pr write" ON public.restaurant_purchase_requests TO authenticated;

ALTER POLICY "pr items read" ON public.restaurant_purchase_request_items TO authenticated;

ALTER POLICY "pr items write" ON public.restaurant_purchase_request_items TO authenticated;

ALTER POLICY "receipt read" ON public.restaurant_goods_receipts TO authenticated;

ALTER POLICY "receipt write" ON public.restaurant_goods_receipts TO authenticated;

ALTER POLICY "receipt items read" ON public.restaurant_goods_receipt_items TO authenticated;

ALTER POLICY "receipt items write" ON public.restaurant_goods_receipt_items TO authenticated;

ALTER POLICY "invoice read" ON public.restaurant_supplier_invoices TO authenticated;

ALTER POLICY "invoice write" ON public.restaurant_supplier_invoices TO authenticated;

ALTER POLICY "invoice items read" ON public.restaurant_supplier_invoice_items TO authenticated;

ALTER POLICY "invoice items write" ON public.restaurant_supplier_invoice_items TO authenticated;

ALTER POLICY "price history read" ON public.restaurant_supplier_price_history TO authenticated;

ALTER POLICY "price history write" ON public.restaurant_supplier_price_history TO authenticated;

ALTER POLICY "approval rules read" ON public.restaurant_approval_rules TO authenticated;

ALTER POLICY "approval rules write" ON public.restaurant_approval_rules TO authenticated;

ALTER POLICY "doc seq read" ON public.restaurant_document_sequences TO authenticated;

ALTER POLICY "doc seq write" ON public.restaurant_document_sequences TO authenticated;
