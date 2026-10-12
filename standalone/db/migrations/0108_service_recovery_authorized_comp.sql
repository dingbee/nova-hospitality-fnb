-- Service recovery comp closure: expose the existing role-checked giveaway RPCs
-- to authenticated callers. Both functions enforce owner/GM/restaurant-manager
-- authority internally; no table trigger or RLS policy is weakened.
GRANT EXECUTE ON FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text) TO authenticated;
