-- Allow a staff member to open their own POS session with their PIN.
-- Keep the manager path for opening a session on behalf of another staff member.
-- This corrects the authorization mismatch without granting staff elevated roles.

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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'Invalid staff PIN'; end if;

  select count(*) into match_count
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true and m.pos_pin_hash is not null
    and extensions.crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash;

  if match_count <> 1 then raise exception 'Invalid staff PIN'; end if;

  select * into member
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and (m.property_id is null or m.property_id = p_property_id)
    and m.pos_pin_enabled = true and m.pos_pin_hash is not null
    and extensions.crypt(p_pin, m.pos_pin_hash) = m.pos_pin_hash
  limit 1;

  -- Staff may start a session only for themselves. Managers may also start
  -- sessions for staff at properties within their authorized scope.
  if not (
    member.user_id = auth.uid()
    or exists (
      select 1 from public.restaurant_members m
      where m.tenant_id = p_tenant_id and m.user_id = auth.uid()
        and m.role in ('owner','general_manager','restaurant_manager')
        and (m.property_id is null or m.property_id = p_property_id)
    )
  ) then
    raise exception 'Not authorized to open a POS staff session';
  end if;

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

notify pgrst, 'reload schema';
