-- Historical cleanup recovered from the production migration ledger.
-- Applied: 2026-09-26 (version 20260926144758).
-- Removes the temporary bootstrap helper after the owner recovery path was retired.
drop function if exists public.restaurant_bootstrap_owner_pos_pin(uuid, uuid, text);
notify pgrst, 'reload schema';
