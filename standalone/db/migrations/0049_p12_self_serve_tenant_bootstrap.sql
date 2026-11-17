-- P12 — self-serve tenant bootstrap for the hosted (Supabase Auth) web path.
--
-- Every existing tenant-creation path is either raw SQL (demo seed,
-- migrations) or the offline appliance installer's
-- `nova_local.bootstrap_property` (local password-hash auth, not Supabase
-- Auth). No web-app path lets a brand-new authenticated user create their
-- own tenant: `restaurant_tenants`' RLS write policy requires
-- `restaurant_can_write(id, ARRAY['owner','general_manager'])`, which needs
-- an EXISTING `restaurant_members` row for that tenant — a genuine
-- chicken-and-egg problem for the very first row.
--
-- This function is the single, narrow, audited bypass for that one
-- bootstrapping step, mirroring the exact pattern `nova_local.bootstrap_
-- property` already uses (SECURITY DEFINER, atomic tenant+membership
-- insert) but for Supabase Auth: the owner is *always* `auth.uid()`,
-- never a parameter, so a caller can only ever make themselves the owner
-- of a brand-new tenant, never anyone else, and never of an existing one.
-- Everything after this single bootstrap call (properties, outlets,
-- members, settings) goes through the existing, already-authorized
-- application functions (upsertProperty, upsertLocation, upsertMember,
-- upsertBusinessProfile) exactly as it does for any other tenant, because
-- the caller now genuinely holds the 'owner' role those functions check.
create or replace function public.restaurant_bootstrap_tenant(
  _name text,
  _slug text,
  _timezone text default 'Africa/Dar_es_Salaam',
  _currency text default 'TZS',
  _country text default null,
  _business_type text default null
)
returns table (tenant_id uuid, member_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_tenant_id uuid;
  v_member_id uuid;
begin
  if v_user is null then
    raise exception 'restaurant_bootstrap_tenant: no authenticated caller' using errcode = '42501';
  end if;

  if _name is null or length(trim(_name)) < 2 then
    raise exception 'restaurant_bootstrap_tenant: business name is required' using errcode = '22023';
  end if;
  if _slug is null or _slug !~ '^[a-z0-9-]{2,120}$' then
    raise exception 'restaurant_bootstrap_tenant: invalid slug' using errcode = '22023';
  end if;

  -- A tenant slug is globally unique (existing restaurant_tenants.slug
  -- constraint) -- surface a clear error rather than a raw constraint
  -- violation if the caller races a duplicate name.
  if exists (select 1 from public.restaurant_tenants where slug = _slug) then
    raise exception 'restaurant_bootstrap_tenant: that business name is already taken' using errcode = '23505';
  end if;

  insert into public.restaurant_tenants (slug, name, status, settings)
  values (
    _slug,
    trim(_name),
    'active',
    jsonb_build_object(
      'onboarding',
      jsonb_build_object(
        'businessType', _business_type,
        'country', _country,
        'currency', _currency,
        'timezone', _timezone,
        'createdVia', 'self_serve_signup'
      )
    )
  )
  returning id into v_tenant_id;

  insert into public.restaurant_members (tenant_id, user_id, role, property_id)
  values (v_tenant_id, v_user, 'owner', null)
  returning id into v_member_id;

  return query select v_tenant_id, v_member_id;
end;
$$;

-- No anon access (never unauthenticated); authenticated only -- any
-- signed-in user may create a brand-new tenant and become its owner, the
-- same self-serve-org-creation pattern used by every comparable
-- multi-tenant SaaS. It can never touch an existing tenant (the slug
-- uniqueness check is the only cross-tenant read, and it leaks no data
-- beyond "taken or not").
revoke all on function public.restaurant_bootstrap_tenant(text, text, text, text, text, text) from public;
revoke all on function public.restaurant_bootstrap_tenant(text, text, text, text, text, text) from anon;
grant execute on function public.restaurant_bootstrap_tenant(text, text, text, text, text, text) to authenticated;
