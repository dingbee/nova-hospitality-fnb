-- 0041 Operational Cost Intelligence privilege hardening.
-- Keep all Phase 3 tables inaccessible to PUBLIC/anon; authenticated access remains RLS-scoped.
revoke all on public.restaurant_operational_expense_categories,
 public.restaurant_operational_expenses,
 public.restaurant_operational_expense_payments,
 public.restaurant_operational_expense_schedules,
 public.restaurant_operational_expense_schedule_occurrences,
 public.restaurant_cost_allocation_rules,
 public.restaurant_cost_allocations,
 public.restaurant_cost_allocation_exceptions,
 public.restaurant_cost_activity_drivers
from public, anon;

grant select,insert,update,delete on public.restaurant_operational_expense_categories,
 public.restaurant_operational_expenses,
 public.restaurant_operational_expense_payments,
 public.restaurant_operational_expense_schedules,
 public.restaurant_operational_expense_schedule_occurrences,
 public.restaurant_cost_allocation_rules,
 public.restaurant_cost_allocations,
 public.restaurant_cost_allocation_exceptions,
 public.restaurant_cost_activity_drivers to authenticated;

grant all on public.restaurant_operational_expense_categories,
 public.restaurant_operational_expenses,
 public.restaurant_operational_expense_payments,
 public.restaurant_operational_expense_schedules,
 public.restaurant_cost_allocation_rules,
 public.restaurant_cost_allocations,
 public.restaurant_cost_allocation_exceptions,
 public.restaurant_cost_activity_drivers to service_role;

-- Trigger functions execute through their attached trigger, not direct RPC grants.
revoke all on function public.restaurant_sync_operational_expense_payment() from public, anon, authenticated;
