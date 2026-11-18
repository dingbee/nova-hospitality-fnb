-- Historical POS owner recovery helper, recovered from the production ledger.
-- Applied: 2026-09-26 (version 20260926140534).
-- This helper is intentionally followed by 0096_remove_owner_pos_pin_recovery.sql.
create or replace function public.restaurant_bootstrap_owner_pos_pin(
  p_tenant_id uuid, p_property_id uuid, p_pin text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target public.restaurant_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must contain 4 to 6 digits';
  end if;

  select *
  into target
  from public.restaurant_members m
  where m.tenant_id = p_tenant_id
    and m.user_id = auth.uid()
    and m.role in ('owner','general_manager','restaurant_manager')
    and (m.property_id is null or m.property_id = p_property_id)
  order by (m.property_id is null) desc
  limit 1;

  if not found then
    raise exception 'Not authorized to recover POS access';
  end if;

  if target.pos_pin_enabled = true and target.pos_pin_hash is not null then
    raise exception 'A POS PIN is already configured. Use the existing PIN or change it from Staff settings.';
  end if;

  update public.restaurant_members
  set pos_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
      pos_pin_enabled = true
  where id = target.id;

  return jsonb_build_object('ok', true, 'memberId', target.id);
end;
$$;

revoke all on function public.restaurant_bootstrap_owner_pos_pin(uuid,uuid,text) from public, anon;
grant execute on function public.restaurant_bootstrap_owner_pos_pin(uuid,uuid,text) to authenticated;

notify pgrst, 'reload schema';
