-- Harden POS PIN RPC execution grants.
-- Only authenticated callers may invoke the PIN/session RPCs.

revoke execute on function public.restaurant_set_pos_pin(uuid,uuid,text) from anon, public;
revoke execute on function public.restaurant_clear_pos_pin(uuid,uuid) from anon, public;
revoke execute on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) from anon, public;
revoke execute on function public.restaurant_end_pos_session(uuid) from anon, public;

grant execute on function public.restaurant_set_pos_pin(uuid,uuid,text) to authenticated;
grant execute on function public.restaurant_clear_pos_pin(uuid,uuid) to authenticated;
grant execute on function public.restaurant_start_pos_session_by_pin(uuid,uuid,text,text) to authenticated;
grant execute on function public.restaurant_end_pos_session(uuid) to authenticated;

notify pgrst, 'reload schema';
