-- LexiBite POS staff PIN/session production migration.
-- Canonicalized after initial 0088/0089 implementation; production applied as 0091.

create extension if not exists pgcrypto;

alter table public.restaurant_members
  add column if not exists pos_pin_hash text,
  add column if not exists pos_pin_enabled boolean not null default false;

create index if not exists restaurant_members_pos_pin_idx
  on public.restaurant_members (tenant_id, property_id)
  where pos_pin_enabled = true;

create table if not exists public.restaurant_pos_sessions (
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

create index if not exists restaurant_pos_sessions_lookup_idx
  on public.restaurant_pos_sessions (tenant_id, property_id, staff_user_id, active, expires_at);

alter table public.restaurant_pos_sessions enable row level security;

drop policy if exists restaurant_pos_sessions_creator_select on public.restaurant_pos_sessions;
create policy restaurant_pos_sessions_creator_select
on public.restaurant_pos_sessions
for select to authenticated
using (created_by = auth.uid());

drop policy if exists restaurant_pos_sessions_creator_update on public.restaurant_pos_sessions;
create policy restaurant_pos_sessions_creator_update
on public.restaurant_pos_sessions
for update to authenticated
using (created_by = auth.uid())
with check (created_by = auth.uid());

create or replace function public.restaurant_set_pos_pin(
  p_tenant_id uuid, p_member_id uuid, p_pin text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare target public.restaurant_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN must contain 4 to 6 digits'; end if;
  select * into target from public.restaurant_members where id = p_member_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Staff member not found'; end if;
  if not exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role in ('owner','general_manager','restaurant_manager')
      and (m.property_id is null or m.property_id = target.property_id)
  ) then raise exception 'Not authorized to manage POS PINs'; end if;
  if exists (
    select 1 from public.restaurant_members m
    where m.id <> p_member_id and m.tenant_id = p_tenant_id
      and (m.property_id = target.property_id or (m.property_id is null and target.property_id is null))
      and m.pos_pin_enabled = true and m.pos_pin_hash is not null
      and crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash
  ) then raise exception 'That PIN is already assigned to another staff member in this scope'; end if;
  update public.restaurant_members
  set pos_pin_hash = crypt(p_pin, gen_salt('bf', 10)), pos_pin_enabled = true
  where id = p_member_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.restaurant_clear_pos_pin(
  p_tenant_id uuid, p_member_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare target public.restaurant_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into target from public.restaurant_members where id = p_member_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Staff member not found'; end if;
  if not exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role in ('owner','general_manager','restaurant_manager')
      and (m.property_id is null or m.property_id = target.property_id)
  ) then raise exception 'Not authorized to manage POS PINs'; end if;
  update public.restaurant_members
  set pos_pin_hash = null, pos_pin_enabled = false
  where id = p_member_id;
  update public.restaurant_pos_sessions
  set active = false, ended_at = now()
  where tenant_id = p_tenant_id and staff_user_id = target.user_id and active = true;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.restaurant_start_pos_session_by_pin(
  p_tenant_id uuid, p_property_id uuid, p_pin text, p_terminal_id text default 'pos-web'
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  member public.restaurant_members%rowtype;
  match_count integer;
  session_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'Invalid staff PIN'; end if;
  select count(*) into match_count
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true
    and m.pos_pin_hash is not null
    and crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash;
  if match_count <> 1 then raise exception 'Invalid staff PIN'; end if;
  select * into member
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true
    and m.pos_pin_hash is not null
    and crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash
  limit 1;
  if not exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role in ('owner','general_manager','restaurant_manager')
      and (m.property_id is null or m.property_id = p_property_id)
  ) then raise exception 'Not authorized to open a POS staff session'; end if;
  update public.restaurant_pos_sessions
  set active = false, ended_at = now()
  where tenant_id = p_tenant_id and property_id = p_property_id
    and terminal_id = coalesce(nullif(p_terminal_id,''),'pos-web') and active = true;
  insert into public.restaurant_pos_sessions
    (tenant_id, property_id, staff_user_id, created_by, terminal_id, expires_at)
  values
    (p_tenant_id, p_property_id, member.user_id, auth.uid(),
     coalesce(nullif(p_terminal_id,''),'pos-web'), now() + interval '12 hours')
  returning id into session_id;
  return jsonb_build_object(
    'sessionId', session_id, 'staffUserId', member.user_id,
    'role', member.role, 'propertyId', member.property_id
  );
end;
$$;

create or replace function public.restaurant_end_pos_session(
  p_session_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.restaurant_pos_sessions
  set active = false, ended_at = now()
  where id = p_session_id and created_by = auth.uid();
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.restaurant_set_pos_pin(uuid,uuid,text) from public;
revoke all on function public.restaurant_clear_pos_pin(uuid,uuid) from public;
revoke all on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) from public;
revoke all on function public.restaurant_end_pos_session(uuid) from public;

grant execute on function public.restaurant_set_pos_pin(uuid,uuid,text) to authenticated;
grant execute on function public.restaurant_clear_pos_pin(uuid,uuid) to authenticated;
grant execute on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) to authenticated;
grant execute on function public.restaurant_end_pos_session(uuid) to authenticated;

notify pgrst, 'reload schema';
