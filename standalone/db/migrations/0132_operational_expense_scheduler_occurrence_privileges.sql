-- Ensure the trusted scheduler can read/create idempotent occurrence ledger rows.
GRANT SELECT,INSERT ON public.restaurant_operational_expense_schedule_occurrences TO authenticated,service_role;
