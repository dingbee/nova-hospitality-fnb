-- 0099 — Commercial customer provisioning + owner invitation activation
--
-- Commercial Centre is the authority for customer creation.
-- Customer owner access is issued by invitation and becomes tenant membership
-- only after the invited user accepts the invitation.

create table if not exists public.commercial_owner_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  email text not null,
  full_name text,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked')),
  auth_user_id uuid references auth.users(id) on delete set null,
  invited_by uuid not null references auth.users(id),
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commercial_owner_invitations_pending_tenant_uq
  on public.commercial_owner_invitations (tenant_id)
  where status = 'pending';

create index if not exists commercial_owner_invitations_tenant_idx
  on public.commercial_owner_invitations (tenant_id, created_at desc);

create index if not exists commercial_owner_invitations_auth_user_idx
  on public.commercial_owner_invitations (auth_user_id)
  where auth_user_id is not null;

alter table public.commercial_owner_invitations enable row level security;
revoke all on public.commercial_owner_invitations from anon, authenticated;
grant all on public.commercial_owner_invitations to service_role;

-- Commercial Centre creates the customer shell and a trial subscription.
-- The customer owner is not made a member here; ownership is established
-- only by the invitation activation RPC below.
create or replace function public.commercial_provision_customer(
  _name text,
  _slug text,
  _plan_id uuid,
  _programme_id uuid default null,
  _billing_interval text default 'monthly',
  _trial_days integer default 14
)
returns table (
  tenant_id uuid,
  subscription_id uuid,
  slug text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_tenant_id uuid;
  v_subscription_id uuid;
  v_status text;
begin
  if v_user is null or not public.restaurant_is_commercial_admin(v_user) then
    raise exception 'Commercial administration access is required.' using errcode = '42501';
  end if;

  if length(trim(_name)) < 2 then
    raise exception 'Customer name is required.' using errcode = '22023';
  end if;

  if _slug !~ '^[a-z0-9][a-z0-9-]{1,79}$' then
    raise exception 'Customer slug is invalid.' using errcode = '22023';
  end if;

  if _billing_interval not in ('monthly', 'annual', 'custom') then
    raise exception 'Unsupported billing interval.' using errcode = '22023';
  end if;

  if _trial_days < 0 or _trial_days > 90 then
    raise exception 'Trial period must be between 0 and 90 days.' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.commercial_plans p
    where p.id = _plan_id
      and p.status = 'active'
  ) then
    raise exception 'Selected commercial plan is not active.' using errcode = '22023';
  end if;

  if _programme_id is not null and not exists (
    select 1
    from public.commercial_programmes p
    where p.id = _programme_id
      and p.status = 'active'
  ) then
    raise exception 'Selected commercial programme is not active.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.restaurant_tenants t where t.slug = _slug
  ) then
    raise exception 'Customer slug is already taken.' using errcode = '23505';
  end if;

  insert into public.restaurant_tenants (slug, name, status, settings)
  values (
    _slug,
    trim(_name),
    'active',
    jsonb_build_object(
      'onboarding', jsonb_build_object(
        'businessType', null,
        'provisionedByCommercialCentre', true
      )
    )
  )
  returning id into v_tenant_id;

  insert into public.commercial_billing_accounts (
    tenant_id,
    currency,
    billing_contact_name,
    commercial_status
  )
  values (
    v_tenant_id,
    'TZS',
    trim(_name),
    'active'
  );

  v_status := case when _trial_days > 0 then 'trial' else 'active' end;

  insert into public.restaurant_subscriptions (
    tenant_id,
    plan,
    status,
    seats,
    plan_id,
    programme_id,
    billing_interval,
    trial_ends_at,
    current_period_end,
    renewal_date,
    renewal_status,
    activated_at
  )
  values (
    v_tenant_id,
    'managed',
    v_status,
    5,
    _plan_id,
    _programme_id,
    _billing_interval,
    case when _trial_days > 0 then now() + make_interval(days => _trial_days) else null end,
    now() + make_interval(days => greatest(_trial_days, 1)),
    current_date + greatest(_trial_days, 1),
    'not_due',
    now()
  )
  returning id into v_subscription_id;

  return query select v_tenant_id, v_subscription_id, _slug;
end;
$$;

revoke execute on function public.commercial_provision_customer(text, text, uuid, uuid, text, integer) from public, anon;
grant execute on function public.commercial_provision_customer(text, text, uuid, uuid, text, integer) to authenticated;

-- Activation is intentionally tenant-bound to the exact Auth user created by
-- the commercial invitation. No client-supplied tenant or role is accepted.
create or replace function public.restaurant_activate_invited_owner(
  _invitation_id uuid
)
returns table (
  tenant_id uuid,
  member_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_invitation public.commercial_owner_invitations%rowtype;
  v_member_id uuid;
  v_auth_email text;
  v_tenant_status text;
  v_billing_status text;
  v_subscription_status text;
begin
  if v_user is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select *
  into v_invitation
  from public.commercial_owner_invitations
  where id = _invitation_id
  for update;

  if not found then
    raise exception 'Invitation not found.' using errcode = 'P0002';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'This invitation is no longer active.' using errcode = 'P0001';
  end if;

  if v_invitation.auth_user_id is distinct from v_user then
    raise exception 'This invitation belongs to a different account.' using errcode = '42501';
  end if;

  select lower(u.email)
  into v_auth_email
  from auth.users u
  where u.id = v_user;

  if v_auth_email is null or v_auth_email <> lower(v_invitation.email) then
    raise exception 'Invitation email does not match the authenticated account.' using errcode = '42501';
  end if;

  select t.status
  into v_tenant_status
  from public.restaurant_tenants t
  where t.id = v_invitation.tenant_id;

  if v_tenant_status is null or v_tenant_status in ('suspended', 'cancelled', 'disabled') then
    raise exception 'This customer workspace is not currently available.' using errcode = '42501';
  end if;

  select b.commercial_status
  into v_billing_status
  from public.commercial_billing_accounts b
  where b.tenant_id = v_invitation.tenant_id;

  select s.status
  into v_subscription_status
  from public.restaurant_subscriptions s
  where s.tenant_id = v_invitation.tenant_id
  order by s.created_at desc
  limit 1;

  if v_billing_status <> 'active'
     or v_subscription_status not in ('active', 'trial') then
    raise exception 'This customer subscription is not currently active.' using errcode = '42501';
  end if;

  select id
  into v_member_id
  from public.restaurant_members
  where tenant_id = v_invitation.tenant_id
    and user_id = v_user
    and property_id is null
  limit 1;

  if v_member_id is null then
    insert into public.restaurant_members (
      tenant_id,
      user_id,
      role,
      property_id
    )
    values (
      v_invitation.tenant_id,
      v_user,
      'owner',
      null
    )
    returning id into v_member_id;
  end if;

  insert into public.app_users (
    user_id,
    tenant_id,
    email,
    full_name,
    status
  )
  values (
    v_user,
    v_invitation.tenant_id,
    lower(v_invitation.email),
    coalesce(v_invitation.full_name, ''),
    'active'
  )
  on conflict (user_id)
  do update set
    tenant_id = excluded.tenant_id,
    email = excluded.email,
    full_name = excluded.full_name,
    status = 'active',
    updated_at = now();

  update public.commercial_owner_invitations
  set
    status = 'accepted',
    accepted_at = now(),
    updated_at = now()
  where id = v_invitation.id;

  return query select v_invitation.tenant_id, v_member_id;
end;
$$;

revoke execute on function public.restaurant_activate_invited_owner(uuid) from public, anon;
grant execute on function public.restaurant_activate_invited_owner(uuid) to authenticated;
