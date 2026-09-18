-- P02 follow-up — make an expired/revoked demo session actually deny access.
--
-- Root cause: restaurant_grant_demo_session() (migration 0082) inserts a
-- real restaurant_members row, and every RLS policy in this product decides
-- access purely on whether such a row EXISTS
-- (restaurant_can_read/restaurant_can_write/restaurant_can_read_scoped/
-- restaurant_can_write_scoped/restaurant_can_read_scoped_strict — see their
-- original definitions in 0001/0027/0029/0032). None of them ever looked at
-- lexibite_demo_sessions.status/expires_at, so a demo grant never actually
-- stopped working — the "session expiry" and "session status" the mandate
-- asked for were bookkeeping only, not enforced. restaurant_reset_demo_
-- environment() could clean up an expired grant, but only when an admin
-- explicitly ran it; nothing denied access in the meantime.
--
-- Fix: one new predicate, restaurant_member_active(user, tenant), ANDed
-- into all five existing RLS predicate functions at their one shared
-- membership-EXISTS check. For every member who has never been through the
-- demo flow (i.e. no matching lexibite_demo_sessions row at all), this is
-- unconditionally true — zero behaviour change for every real customer.
-- This is the same "retain the existing RLS architecture" approach the
-- product has used for every prior hardening pass (0027, 0029, 0032, 0057,
-- 0059, ...): extend the shared predicate, not each table's policy.
--
-- Also adds restaurant_revoke_demo_session(), the one thing that was
-- missing to ever produce a genuinely 'revoked' session (nothing in 0082
-- could set that status) — admin-gated exactly like restaurant_reset_
-- demo_environment().

create or replace function public.restaurant_member_active(_user_id uuid, _tenant_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (
    select 1 from public.lexibite_demo_sessions ds
    where ds.user_id = _user_id
      and ds.tenant_id = _tenant_id
      and (ds.status <> 'active' or ds.expires_at <= now())
  );
$$;

revoke all on function public.restaurant_member_active(uuid, uuid) from public, anon;
grant execute on function public.restaurant_member_active(uuid, uuid) to authenticated, service_role;

-- ---------- restaurant_can_read (0001) ----------
create or replace function public.restaurant_can_read(_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or (
      exists (select 1 from public.restaurant_members m
              where m.tenant_id = _tenant_id and m.user_id = auth.uid())
      and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

-- ---------- restaurant_can_write (0001) ----------
create or replace function public.restaurant_can_write(_tenant_id uuid, _roles public.restaurant_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or (
      exists (select 1 from public.restaurant_members m
              where m.tenant_id = _tenant_id and m.user_id = auth.uid()
                and m.role = any(_roles))
      and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

-- ---------- restaurant_can_read_scoped (final definition: 0029) ----------
create or replace function public.restaurant_can_read_scoped(_tenant_id uuid, _property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or (
      exists (
        select 1 from public.restaurant_members m
        where m.tenant_id = _tenant_id and m.user_id = auth.uid()
          and (_property_id is null or m.property_id is null or m.property_id = _property_id)
      )
      and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

-- ---------- restaurant_can_write_scoped (0027) ----------
create or replace function public.restaurant_can_write_scoped(
  _tenant_id uuid, _roles public.restaurant_role[], _property_id uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or (
      exists (
        select 1 from public.restaurant_members m
        where m.tenant_id = _tenant_id and m.user_id = auth.uid()
          and m.role = any(_roles)
          and (_property_id is null or m.property_id is null or m.property_id = _property_id)
      )
      and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

-- ---------- restaurant_can_read_scoped_strict (0032) ----------
create or replace function public.restaurant_can_read_scoped_strict(_tenant_id uuid, _property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.restaurant_is_platform_admin(auth.uid())
    or (
      exists (
        select 1 from public.restaurant_members m
        where m.tenant_id = _tenant_id and m.user_id = auth.uid()
          and (
            (_property_id is not null and (m.property_id is null or m.property_id = _property_id))
            or (_property_id is null and m.property_id is null)
          )
      )
      and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

-- ---------- revocation (the missing path to a genuine 'revoked' status) ----------
create or replace function public.restaurant_revoke_demo_session(_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_updated int;
begin
  if auth.uid() is null or not public.restaurant_is_commercial_admin(auth.uid()) then
    raise exception 'restaurant_revoke_demo_session: commercial administration required' using errcode = '42501';
  end if;

  update public.lexibite_demo_sessions
  set status = 'revoked', revoked_at = now()
  where id = _session_id
    and tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
    and status = 'active';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.restaurant_revoke_demo_session(uuid) from public, anon;
grant execute on function public.restaurant_revoke_demo_session(uuid) to authenticated;
