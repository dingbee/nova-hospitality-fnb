-- Commercial owner activation: invite-only customer access.
--
-- Commercial Center owns who may enter LexiBite. Supabase Auth remains the
-- identity provider, but tenant membership is created only after a valid
-- commercial owner invitation is redeemed.
--
-- This migration is intentionally additive. It also closes the old P12
-- self-serve bootstrap RPC so an arbitrary authenticated user cannot create
-- a new tenant.

create table if not exists public.commercial_owner_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  email text not null,
  full_name text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  auth_user_id uuid,
  invited_by uuid not null,
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commercial_owner_invitations_tenant_idx
  on public.commercial_owner_invitations (tenant_id, status, created_at desc);

create index if not exists commercial_owner_invitations_email_idx
  on public.commercial_owner_invitations (lower(email), status, created_at desc);

create unique index if not exists commercial_owner_invitations_one_pending_tenant_idx
  on public.commercial_owner_invitations (tenant_id)
  where status = 'pending';

alter table public.commercial_owner_invitations enable row level security;

revoke all on table public.commercial_owner_invitations from anon, authenticated;

create or replace function public.restaurant_activate_invited_owner(
  _invitation_id uuid
)
returns table (tenant_id uuid, member_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text;
  v_tenant uuid;
  v_member uuid;
  v_invitation public.commercial_owner_invitations%rowtype;
begin
  if v_user is null then
    raise exception 'Invitation activation requires authentication' using errcode = '42501';
  end if;

  select lower(u.email)
    into v_email
  from auth.users u
  where u.id = v_user;

  if v_email is null then
    raise exception 'Authenticated account has no email' using errcode = '42501';
  end if;

  select *
    into v_invitation
  from public.commercial_owner_invitations i
  where i.id = _invitation_id
    and i.status = 'pending'
    and lower(i.email) = v_email
  for update;

  if not found then
    raise exception 'This LexiBite invitation is invalid, expired, already used, or belongs to another email'
      using errcode = '42501';
  end if;

  select i.tenant_id
    into v_tenant
  from public.commercial_owner_invitations i
  join public.commercial_billing_accounts b on b.tenant_id = i.tenant_id
  join public.restaurant_subscriptions s on s.tenant_id = i.tenant_id
  where i.id = _invitation_id
    and b.commercial_status = 'active'
    and s.status in ('active', 'trial');

  if v_tenant is null then
    raise exception 'Customer access is not commercially active'
      using errcode = '42501';
  end if;

  insert into public.restaurant_members (tenant_id, user_id, role, property_id)
  values (v_tenant, v_user, 'owner', null)
  on conflict (tenant_id, user_id, property_id) do update
    set role = 'owner';

  select rm.id
    into v_member
  from public.restaurant_members rm
  where rm.tenant_id = v_tenant
    and rm.user_id = v_user
    and rm.property_id is null
    and rm.role = 'owner'
  order by rm.created_at asc
  limit 1;

  insert into public.app_users (user_id, tenant_id, email, full_name, status)
  values (
    v_user,
    v_tenant,
    v_email,
    v_invitation.full_name,
    'active'
  )
  on conflict (user_id) do update
    set tenant_id = excluded.tenant_id,
        email = excluded.email,
        full_name = coalesce(excluded.full_name, public.app_users.full_name),
        status = 'active',
        updated_at = now();

  update public.commercial_owner_invitations
  set status = 'accepted',
      auth_user_id = v_user,
      accepted_at = now(),
      updated_at = now()
  where id = _invitation_id;

  return query select v_tenant, v_member;
end;
$$;

revoke all on function public.restaurant_activate_invited_owner(uuid) from public;
revoke all on function public.restaurant_activate_invited_owner(uuid) from anon;
grant execute on function public.restaurant_activate_invited_owner(uuid) to authenticated;

-- The old self-serve bootstrap must no longer be callable by ordinary users.
revoke all on function public.restaurant_bootstrap_tenant(text, text, text, text, text, text)
  from public, anon, authenticated;

-- Keep the old function for backwards-compatible database history, but make
-- the production application incapable of using it as an elevation path.
