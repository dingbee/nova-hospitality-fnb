-- 0107_lexibite_staff_access_gateway.sql
-- Manager-authorised shared-terminal access across POS, Inventory, Finance and
-- other restaurant workspaces. Owner/platform-admin direct access is preserved.
-- Existing sessions have no staff_member_id and intentionally require a fresh PIN.

begin;

alter table public.restaurant_pos_sessions
  add column if not exists staff_member_id uuid
    references public.restaurant_members(id) on delete cascade;
alter table public.restaurant_pos_sessions
  add column if not exists session_token_hash text;

create index if not exists restaurant_pos_sessions_actor_lookup_idx
  on public.restaurant_pos_sessions (created_by, tenant_id, active, expires_at, started_at desc);

-- Any supplied terminal proof opts the request into staff mode, even when forged or expired.
-- That suppresses direct owner/admin/API bypasses and makes invalid proof fail closed.
create or replace function public.restaurant_staff_mode_requested()
returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-lexibite-staff-session'), '') <> ''
      or coalesce((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-client-info'), '') like '%lexibite-staff-session=%';
$$;
revoke all on function public.restaurant_staff_mode_requested() from public, anon;
grant execute on function public.restaurant_staff_mode_requested() to authenticated, service_role;

-- Resolve the exact membership row selected by the PIN, not every role the
-- same auth user may hold. Only the manager-authenticated terminal can create
-- this session; the browser's authenticated user remains created_by.
create or replace function public.restaurant_effective_staff_member_id(_tenant_id uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.staff_member_id
  from public.restaurant_pos_sessions s
  join public.restaurant_members m
    on m.id = s.staff_member_id
   and m.tenant_id = s.tenant_id
   and m.user_id = s.staff_user_id
  where auth.uid() is not null
    and s.session_token_hash is not null
    and s.session_token_hash = encode(extensions.digest(convert_to(
      coalesce((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-lexibite-staff-session'), substring((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-client-info') from 'lexibite-staff-session=([0-9a-f]{64})'), ''), 'UTF8'
    ), 'sha256'), 'hex')
    and s.created_by = auth.uid()
    and s.tenant_id = _tenant_id
    and s.active = true
    and s.expires_at > now()
    and s.staff_member_id is not null
    and (m.property_id is null or m.property_id = s.property_id)
    and public.restaurant_member_active(m.user_id, _tenant_id)
  order by s.started_at desc
  limit 1;
$$;

revoke all on function public.restaurant_effective_staff_member_id(uuid) from public, anon;
grant execute on function public.restaurant_effective_staff_member_id(uuid) to authenticated, service_role;

-- A manager's email/password session alone is not an operational permission.
-- Direct owner/platform-admin access and machine API principals are preserved.
-- Property-scoped human sessions fail closed on legacy unscoped predicates;
-- those resources must use a property-aware predicate before staff can reach them.
create or replace function public.restaurant_can_read(_tenant_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.id = public.restaurant_effective_staff_member_id(_tenant_id)
        and m.tenant_id = _tenant_id
        and m.property_id is null
        and public.restaurant_member_active(m.user_id, _tenant_id)
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'api_service'
        and m.property_id is null
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

create or replace function public.restaurant_can_write(
  _tenant_id uuid,
  _roles public.restaurant_role[]
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and m.role = any(_roles)
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.id = public.restaurant_effective_staff_member_id(_tenant_id)
        and m.tenant_id = _tenant_id
        and m.property_id is null
        and m.role = any(_roles)
        and public.restaurant_member_active(m.user_id, _tenant_id)
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'api_service'
        and m.role = any(_roles)
        and m.property_id is null
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

create or replace function public.restaurant_can_read_scoped(
  _tenant_id uuid,
  _property_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and (_property_id is null or m.property_id is null or m.property_id = _property_id)
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1
      from public.restaurant_pos_sessions s
      join public.restaurant_members m on m.id = s.staff_member_id
      where s.created_by = auth.uid()
        and s.tenant_id = _tenant_id
        and s.active = true
        and s.expires_at > now()
        and s.staff_member_id = public.restaurant_effective_staff_member_id(_tenant_id)
        and m.tenant_id = _tenant_id
        and m.user_id = s.staff_user_id
        and public.restaurant_member_active(m.user_id, _tenant_id)
        and (
          (_property_id is null and m.property_id is null)
          or (
            _property_id is not null
            and s.property_id = _property_id
            and (m.property_id is null or m.property_id = _property_id)
          )
        )
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'api_service'
        and (_property_id is null and m.property_id is null
          or _property_id is not null and (m.property_id is null or m.property_id = _property_id))
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

create or replace function public.restaurant_can_write_scoped(
  _tenant_id uuid,
  _roles public.restaurant_role[],
  _property_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and m.role = any(_roles)
        and (_property_id is null or m.property_id is null or m.property_id = _property_id)
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1
      from public.restaurant_pos_sessions s
      join public.restaurant_members m on m.id = s.staff_member_id
      where s.created_by = auth.uid()
        and s.tenant_id = _tenant_id
        and s.active = true
        and s.expires_at > now()
        and s.staff_member_id = public.restaurant_effective_staff_member_id(_tenant_id)
        and m.tenant_id = _tenant_id
        and m.user_id = s.staff_user_id
        and m.role = any(_roles)
        and public.restaurant_member_active(m.user_id, _tenant_id)
        and (
          (_property_id is null and m.property_id is null)
          or (
            _property_id is not null
            and s.property_id = _property_id
            and (m.property_id is null or m.property_id = _property_id)
          )
        )
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'api_service'
        and m.role = any(_roles)
        and (_property_id is null and m.property_id is null
          or _property_id is not null and (m.property_id is null or m.property_id = _property_id))
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

create or replace function public.restaurant_can_read_scoped_strict(
  _tenant_id uuid,
  _property_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and (
          (_property_id is not null and (m.property_id is null or m.property_id = _property_id))
          or (_property_id is null and m.property_id is null)
        )
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1
      from public.restaurant_pos_sessions s
      join public.restaurant_members m on m.id = s.staff_member_id
      where s.created_by = auth.uid()
        and s.tenant_id = _tenant_id
        and s.active = true
        and s.expires_at > now()
        and s.staff_member_id = public.restaurant_effective_staff_member_id(_tenant_id)
        and m.tenant_id = _tenant_id
        and m.user_id = s.staff_user_id
        and public.restaurant_member_active(m.user_id, _tenant_id)
        and (
          (_property_id is not null and s.property_id = _property_id
            and (m.property_id is null or m.property_id = _property_id))
          or (_property_id is null and m.property_id is null)
        )
    )
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'api_service'
        and (
          (_property_id is not null and (m.property_id is null or m.property_id = _property_id))
          or (_property_id is null and m.property_id is null)
        )
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
  );
$$;

revoke all on function public.restaurant_can_read(uuid) from public, anon;
grant execute on function public.restaurant_can_read(uuid) to authenticated, service_role;
revoke all on function public.restaurant_can_write(uuid, public.restaurant_role[]) from public, anon;
grant execute on function public.restaurant_can_write(uuid, public.restaurant_role[]) to authenticated, service_role;
revoke all on function public.restaurant_can_read_scoped(uuid, uuid) from public, anon;
grant execute on function public.restaurant_can_read_scoped(uuid, uuid) to authenticated, service_role;
revoke all on function public.restaurant_can_write_scoped(uuid, public.restaurant_role[], uuid) from public, anon;
grant execute on function public.restaurant_can_write_scoped(uuid, public.restaurant_role[], uuid) to authenticated, service_role;
revoke all on function public.restaurant_can_read_scoped_strict(uuid, uuid) from public, anon;
grant execute on function public.restaurant_can_read_scoped_strict(uuid, uuid) to authenticated, service_role;

-- A PIN session can see its exact membership row even when the browser's
-- authenticated account is the manager who authorised the terminal.
drop policy if exists "members read active staff session self" on public.restaurant_members;
create policy "members read active staff session self"
on public.restaurant_members for select to authenticated
using (id = public.restaurant_effective_staff_member_id(tenant_id));

-- Workspace bootstrap after PIN needs only the tenant label; property and
-- operational rows remain subject to their property-aware policies.
drop policy if exists restaurant_tenants_active_staff_session_select on public.restaurant_tenants;
create policy restaurant_tenants_active_staff_session_select
on public.restaurant_tenants for select to authenticated
using (
  exists (
    select 1 from public.restaurant_pos_sessions s
    where s.tenant_id = restaurant_tenants.id
      and s.created_by = auth.uid()
      and s.active = true
      and s.expires_at > now()
      and s.staff_member_id = public.restaurant_effective_staff_member_id(restaurant_tenants.id)
  )
);

create or replace function public.restaurant_can_manage_membership(
  _tenant_id uuid, _roles public.restaurant_role[], _target_property_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    (not public.restaurant_staff_mode_requested() and public.restaurant_is_platform_admin(auth.uid()))
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = _tenant_id
        and m.user_id = auth.uid()
        and not public.restaurant_staff_mode_requested()
        and m.role = 'owner'
        and m.role = any(_roles)
        and (
          (_target_property_id is null and m.property_id is null)
          or (_target_property_id is not null and (m.property_id is null or m.property_id = _target_property_id))
        )
        and public.restaurant_member_active(auth.uid(), _tenant_id)
    )
    or exists (
      select 1 from public.restaurant_members actor
      where actor.id = public.restaurant_effective_staff_member_id(_tenant_id)
        and actor.tenant_id = _tenant_id
        and actor.role = any(_roles)
        and (
          (_target_property_id is null and actor.property_id is null)
          or (_target_property_id is not null and (actor.property_id is null or actor.property_id = _target_property_id))
        )
        and public.restaurant_member_active(actor.user_id, _tenant_id)
    )
  );
$$;

revoke all on function public.restaurant_can_manage_membership(uuid, public.restaurant_role[], uuid) from public, anon;
grant execute on function public.restaurant_can_manage_membership(uuid, public.restaurant_role[], uuid) to authenticated, service_role;

-- PIN administration requires either direct owner/platform-admin access or a
-- currently PIN-authenticated manager session. A staff session cannot manage PINs.
create or replace function public.restaurant_set_pos_pin(
  p_tenant_id uuid, p_member_id uuid, p_pin text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target public.restaurant_members%rowtype;
  actor_member_id uuid;
  actor_member public.restaurant_members%rowtype;
  owner_access boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'PIN must contain 4 to 6 digits'; end if;
  select * into target from public.restaurant_members where id = p_member_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Staff member not found'; end if;

  owner_access := not public.restaurant_staff_mode_requested() and (public.restaurant_is_platform_admin(auth.uid()) or exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role = 'owner' and public.restaurant_member_active(auth.uid(), p_tenant_id)
  ));
  actor_member_id := public.restaurant_effective_staff_member_id(p_tenant_id);
  if not owner_access then
    select * into actor_member from public.restaurant_members where id = actor_member_id;
    if actor_member.id is null or actor_member.role not in ('general_manager','restaurant_manager') then
      raise exception 'Manager PIN verification is required to manage staff PINs';
    end if;
    if actor_member.property_id is not null and target.property_id is distinct from actor_member.property_id then
      raise exception 'Manager is not authorised to manage PINs outside this property';
    end if;
  end if;

  if exists (
    select 1 from public.restaurant_members m
    where m.id <> p_member_id and m.tenant_id = p_tenant_id
      and (m.property_id is null or target.property_id is null or m.property_id = target.property_id)
      and m.pos_pin_enabled = true and m.pos_pin_hash is not null
      and extensions.crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash
  ) then raise exception 'That PIN is already assigned within an overlapping property scope'; end if;

  update public.restaurant_members
  set pos_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), pos_pin_enabled = true
  where id = p_member_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.restaurant_clear_pos_pin(
  p_tenant_id uuid, p_member_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target public.restaurant_members%rowtype;
  actor_member_id uuid;
  actor_member public.restaurant_members%rowtype;
  owner_access boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into target from public.restaurant_members where id = p_member_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Staff member not found'; end if;

  owner_access := not public.restaurant_staff_mode_requested() and (public.restaurant_is_platform_admin(auth.uid()) or exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role = 'owner' and public.restaurant_member_active(auth.uid(), p_tenant_id)
  ));
  actor_member_id := public.restaurant_effective_staff_member_id(p_tenant_id);
  if not owner_access then
    select * into actor_member from public.restaurant_members where id = actor_member_id;
    if actor_member.id is null or actor_member.role not in ('general_manager','restaurant_manager') then
      raise exception 'Manager PIN verification is required to manage staff PINs';
    end if;
    if actor_member.property_id is not null and target.property_id is distinct from actor_member.property_id then
      raise exception 'Manager is not authorised to manage PINs outside this property';
    end if;
  end if;

  update public.restaurant_members
  set pos_pin_hash = null, pos_pin_enabled = false
  where id = p_member_id;
  update public.restaurant_pos_sessions
  set active = false, ended_at = now()
  where tenant_id = p_tenant_id and staff_member_id = p_member_id and active = true;
  return jsonb_build_object('ok', true);
end;
$$;

-- Only an authenticated general/restaurant manager may activate a shared
-- operational session. Owners and platform admins remain direct-access roles.
create or replace function public.restaurant_start_pos_session_by_pin(
  p_tenant_id uuid, p_property_id uuid, p_pin text, p_terminal_id text default 'pos-web'
) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  member public.restaurant_members%rowtype;
  match_count integer;
  session_id uuid;
  session_token text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must contain 4 to 6 digits';
  end if;

  if not exists (
    select 1 from public.restaurant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
      and m.role in ('owner','general_manager','restaurant_manager')
      and (m.property_id is null or m.property_id = p_property_id)
      and public.restaurant_member_active(auth.uid(), p_tenant_id)
  ) then
    raise exception 'Only an authorised manager account can activate Staff Access';
  end if;

  if not exists (
    select 1 from public.restaurant_properties p
    where p.id = p_property_id and p.tenant_id = p_tenant_id
  ) then raise exception 'Property does not belong to this tenant'; end if;

  select count(*) into match_count
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true and m.pos_pin_hash is not null
    and public.restaurant_member_active(m.user_id, p_tenant_id)
    and extensions.crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash;

  if match_count <> 1 then raise exception 'Invalid staff PIN'; end if;

  select * into member
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true and m.pos_pin_hash is not null
    and public.restaurant_member_active(m.user_id, p_tenant_id)
    and extensions.crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash
  limit 1;

  -- Switching staff ends only this terminal's session, never sessions on other devices.
  update public.restaurant_pos_sessions
  set active = false, ended_at = now()
  where created_by = auth.uid() and tenant_id = p_tenant_id
    and property_id = p_property_id
    and terminal_id = coalesce(nullif(p_terminal_id,''),'pos-web') and active = true;

  session_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.restaurant_pos_sessions
    (tenant_id, property_id, staff_user_id, staff_member_id, created_by, terminal_id, expires_at, session_token_hash)
  values
    (p_tenant_id, p_property_id, member.user_id, member.id, auth.uid(),
     coalesce(nullif(p_terminal_id,''),'pos-web'), now() + interval '12 hours',
     encode(extensions.digest(convert_to(session_token, 'UTF8'), 'sha256'), 'hex'))
  returning id into session_id;

  return jsonb_build_object(
    'sessionId', session_id, 'sessionToken', session_token, 'staffUserId', member.user_id,
    'staffMemberId', member.id, 'role', member.role,
    'tenantId', p_tenant_id, 'propertyId', p_property_id,
    'terminalId', coalesce(nullif(p_terminal_id,''),'pos-web')
  );
end;
$$;

-- Minimal, self-scoped bootstrap metadata only. It intentionally does not expose
-- operational data before PIN verification.
create or replace function public.restaurant_staff_access_bootstrap()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  platform_admin boolean := false;
  tenant_owner boolean := false;
  has_membership boolean := false;
  can_activate boolean := false;
  selected_tenant uuid;
  selected_name text;
  session_row public.restaurant_pos_sessions%rowtype;
  session_member public.restaurant_members%rowtype;
  properties jsonb := '[]'::jsonb;
  active_session jsonb := null;
begin
  if caller is null then raise exception 'Authentication required'; end if;
  platform_admin := public.restaurant_is_platform_admin(caller);
  if platform_admin then
    return jsonb_build_object(
      'platformAdmin', true, 'owner', false, 'hasRestaurantMembership', false,
      'canActivate', false, 'tenantId', null, 'tenantName', null,
      'pinConfigured', false, 'properties', '[]'::jsonb, 'activeSession', null
    );
  end if;

  select exists (
    select 1 from public.restaurant_members m
    where m.user_id = caller and m.role = 'owner'
      and public.restaurant_member_active(caller, m.tenant_id)
  ) into tenant_owner;
  select exists (select 1 from public.restaurant_members m where m.user_id = caller)
    into has_membership;

  select s.* into session_row
  from public.restaurant_pos_sessions s
  join public.restaurant_members m on m.id = s.staff_member_id
  where s.created_by = caller and s.active = true and s.expires_at > now()
    and s.session_token_hash is not null
    and s.session_token_hash = encode(extensions.digest(convert_to(
      coalesce((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-lexibite-staff-session'), substring((nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-client-info') from 'lexibite-staff-session=([0-9a-f]{64})'), ''), 'UTF8'
    ), 'sha256'), 'hex')
    and s.staff_member_id is not null
    and m.tenant_id = s.tenant_id and m.user_id = s.staff_user_id
    and (m.property_id is null or m.property_id = s.property_id)
    and public.restaurant_member_active(m.user_id, s.tenant_id)
  order by s.started_at desc
  limit 1;

  can_activate := exists (
    select 1 from public.restaurant_members m
    where m.user_id = caller and m.role in ('owner','general_manager','restaurant_manager')
      and public.restaurant_member_active(caller, m.tenant_id)
  );

  if session_row.id is not null then
    selected_tenant := session_row.tenant_id;
    select * into session_member from public.restaurant_members m where m.id = session_row.staff_member_id;
    active_session := jsonb_build_object(
      'sessionId', session_row.id,
      'tenantId', session_row.tenant_id,
      'propertyId', session_row.property_id,
      'staffUserId', session_row.staff_user_id,
      'staffMemberId', session_row.staff_member_id,
      'role', session_member.role,
      'terminalId', session_row.terminal_id,
      'expiresAt', session_row.expires_at
    );
  else
    select m.tenant_id into selected_tenant
    from public.restaurant_members m
    where m.user_id = caller and m.role in ('owner','general_manager','restaurant_manager')
      and public.restaurant_member_active(caller, m.tenant_id)
    order by m.tenant_id
    limit 1;
  end if;

  if can_activate and selected_tenant is not null then
    select t.name into selected_name from public.restaurant_tenants t where t.id = selected_tenant;
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'pinConfigured', exists (
          select 1 from public.restaurant_members m
          where m.tenant_id = selected_tenant
            and m.pos_pin_enabled = true and m.pos_pin_hash is not null
            and (m.property_id is null or m.property_id = p.id)
            and public.restaurant_member_active(m.user_id, selected_tenant)
        )
      ) order by p.name
    ), '[]'::jsonb) into properties
    from public.restaurant_properties p
    where p.tenant_id = selected_tenant
      and exists (
        select 1 from public.restaurant_members m
        where m.user_id = caller and m.tenant_id = selected_tenant
          and m.role in ('owner','general_manager','restaurant_manager')
          and (m.property_id is null or m.property_id = p.id)
      );
  end if;

  return jsonb_build_object(
    'platformAdmin', false,
    'owner', tenant_owner,
    'hasRestaurantMembership', has_membership,
    'canActivate', can_activate,
    'tenantId', selected_tenant,
    'tenantName', selected_name,
    'pinConfigured', coalesce((select bool_or((x.value->>'pinConfigured')::boolean) from jsonb_array_elements(properties) as x(value)), false),
    'properties', properties,
    'activeSession', active_session
  );
end;
$$;

revoke all on function public.restaurant_staff_access_bootstrap() from public, anon;
grant execute on function public.restaurant_staff_access_bootstrap() to authenticated;

revoke all on function public.restaurant_set_pos_pin(uuid,uuid,text) from public, anon;
revoke all on function public.restaurant_clear_pos_pin(uuid,uuid) from public, anon;
revoke all on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) from public, anon;
revoke all on function public.restaurant_end_pos_session(uuid) from public, anon;

grant execute on function public.restaurant_set_pos_pin(uuid,uuid,text) to authenticated;
grant execute on function public.restaurant_clear_pos_pin(uuid,uuid) to authenticated;
grant execute on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) to authenticated;
grant execute on function public.restaurant_end_pos_session(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;