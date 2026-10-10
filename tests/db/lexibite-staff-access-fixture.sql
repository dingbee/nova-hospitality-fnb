-- Minimal Supabase-compatible PostgreSQL fixture for migration 0107.
-- Runs only in the disposable CI postgres service; never points at production.
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='restaurant_role') then
    create type public.restaurant_role as enum ('owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender','inventory_manager','purchasing_officer','accountant','viewer','api_service');
  end if;
end $$;

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.restaurant_tenants (id uuid primary key, name text not null);
create table public.restaurant_properties (
  id uuid primary key, tenant_id uuid not null references public.restaurant_tenants(id), name text not null
);
create table public.restaurant_members (
  id uuid primary key,
  tenant_id uuid not null references public.restaurant_tenants(id),
  user_id uuid not null,
  role public.restaurant_role not null,
  property_id uuid references public.restaurant_properties(id),
  pos_pin_hash text,
  pos_pin_enabled boolean not null default false
);
create table public.restaurant_pos_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  staff_user_id uuid not null,
  created_by uuid not null,
  terminal_id text not null default 'pos-web',
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  active boolean not null default true,
  constraint restaurant_pos_sessions_expiry_ck check (expires_at > started_at)
);

create table public.lexibite_demo_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tenant_id uuid not null,
  status text not null default 'active',
  expires_at timestamptz not null default now() + interval '12 hours'
);
create or replace function public.restaurant_member_active(_user_id uuid, _tenant_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$ select not exists(select 1 from public.lexibite_demo_sessions ds where ds.user_id=_user_id and ds.tenant_id=_tenant_id and (ds.status <> 'active' or ds.expires_at <= now())) $$;
create or replace function public.restaurant_is_platform_admin(_user_id uuid)
returns boolean language sql stable
as $$ select false $$;
create or replace function public.restaurant_end_pos_session(p_session_id uuid)
returns jsonb language sql security definer
as $$ update public.restaurant_pos_sessions set active=false, ended_at=now() where id=p_session_id and created_by=auth.uid() returning jsonb_build_object('ok',true) $$;

alter table public.restaurant_tenants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.restaurant_pos_sessions enable row level security;
create policy restaurant_pos_sessions_creator_select on public.restaurant_pos_sessions for select to authenticated using (created_by = auth.uid());
create policy restaurant_pos_sessions_creator_update on public.restaurant_pos_sessions for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
grant usage on schema public, auth, extensions to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant execute on function public.restaurant_member_active(uuid,uuid) to authenticated, service_role;
grant execute on function public.restaurant_is_platform_admin(uuid) to authenticated, service_role;
grant select, insert, update, delete on public.restaurant_members, public.restaurant_tenants, public.restaurant_properties, public.restaurant_pos_sessions to authenticated, service_role;
