-- LexiBite POS PIN-only login refinement.
-- The PIN itself identifies the staff member; the terminal does not expose a staff picker.

create or replace function public.restaurant_set_pos_pin(
  p_tenant_id uuid,
  p_member_id uuid,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.restaurant_members%rowtype;
begin
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

create or replace function public.restaurant_start_pos_session_by_pin(
  p_tenant_id uuid,
  p_property_id uuid,
  p_pin text,
  p_terminal_id text default 'pos-web'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  member public.restaurant_members%rowtype;
  match_count integer;
  session_id uuid;
begin
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

revoke all on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) from public;
grant execute on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) to authenticated;
