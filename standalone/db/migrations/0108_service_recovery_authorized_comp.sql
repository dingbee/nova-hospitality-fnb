-- Service recovery comp closure: expose the existing role-checked giveaway RPCs
-- to authenticated callers, without inheriting PostgreSQL's default PUBLIC
-- EXECUTE privilege. Both functions enforce owner/GM/restaurant-manager
-- authority internally; no table trigger or RLS policy is weakened.
REVOKE EXECUTE ON FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) TO authenticated;
