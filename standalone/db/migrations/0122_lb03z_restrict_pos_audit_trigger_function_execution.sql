-- Recovered security hardening from the production migration ledger.
-- Applied: 2026-11-12 (version 20261112065129).
-- The audit immutability trigger calls this function internally; no API role
-- requires direct EXECUTE permission on it.
REVOKE ALL ON FUNCTION public.lb03_reject_pos_room_charge_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
