-- P11 — Production & Security Hardening.
--
-- Three confirmed defects found via the live Supabase security advisor and
-- fixed at the authoritative (database) layer, never by patching a frontend
-- caller:
--
-- 1. `nova_user_roles_view` was SECURITY DEFINER, bypassing the correct RLS
--    already enforced on the underlying `rbac_user_roles` table (self row
--    OR STAFF:READ permission). That RLS is the authoritative access rule;
--    SECURITY DEFINER on the view unnecessarily overrode it, exposing every
--    user's role/tenant/property/outlet assignment platform-wide to any
--    authenticated (and previously even anon) caller via PostgREST
--    (`/rest/v1/nova_user_roles_view` with no filter). Fix: switch the view
--    to invoker semantics so the querying user's own RLS applies, exactly
--    as it already does for direct table access. Verified against every
--    real caller in the app (`staff.functions.ts`, `rbac.functions.ts`,
--    `access.server.ts`) -- all three query it through the user's own
--    session-scoped client, so this changes nothing for them.
--
-- 2. `migration_transfer_audit` (a one-time internal migration bookkeeping
--    table, 5 historical rows, zero application-code references) had RLS
--    disabled and direct INSERT/SELECT/UPDATE/DELETE/TRUNCATE grants to
--    `anon` and `authenticated` -- readable and writable by anyone with
--    just the public anon key. Fix: enable RLS (default-deny, no policies)
--    and revoke the grants that should never have been public.
--
-- 3. 26 SECURITY DEFINER functions were directly callable by `anon` via
--    PostgREST RPC (`/rest/v1/rpc/<function>`), none of them guest-facing
--    (LexiBite's guest ordering path uses its own session/table mechanism,
--    not this staff RBAC/financial surface -- cross-checked against every
--    `.rpc(...)` call in the app and every RLS policy qual/with_check
--    referencing these functions). anon EXECUTE is revoked across the
--    board. Of those, 17 are zero-argument (or action-only) trigger/control
--    functions (cash payout, daily close, tender declaration, giveaway
--    workflow) with zero direct `.rpc()` callers anywhere in the
--    application and zero RLS references -- Postgres trigger firing does
--    not require the triggering role to hold EXECUTE on the trigger
--    function, only direct RPC invocation does, so `authenticated` EXECUTE
--    is also revoked on these without affecting any trigger's normal
--    firing. Postgres grants EXECUTE on new functions to the PUBLIC
--    pseudo-role by default, which every real role inherits -- a per-role
--    REVOKE alone does not close that; PUBLIC is revoked explicitly, and
--    the six functions still legitimately needed by `authenticated`
--    (used in RLS policies or called via `.rpc()` from app code) have
--    EXECUTE re-granted to `authenticated` explicitly so their access no
--    longer depends on the PUBLIC default.

alter view public.nova_user_roles_view set (security_invoker = true);
revoke all on public.nova_user_roles_view from anon;
revoke all on public.nova_user_roles_view from authenticated;
grant select on public.nova_user_roles_view to authenticated;

alter table public.migration_transfer_audit enable row level security;
revoke all on public.migration_transfer_audit from anon;
revoke all on public.migration_transfer_audit from authenticated;

revoke execute on function public.has_any_role(uuid, public.app_role[], uuid, uuid, uuid) from anon;
revoke execute on function public.has_role(uuid, public.app_role) from anon;
revoke execute on function public.is_any_staff(uuid) from anon;
revoke execute on function public.nova_has_permission(uuid, text, uuid, uuid, uuid) from anon;
revoke execute on function public.nova_permissions_for(uuid) from anon;
revoke execute on function public.restaurant_apply_giveaway(uuid) from anon;
revoke execute on function public.restaurant_apply_stock_movement() from anon;
revoke execute on function public.restaurant_can_read(uuid) from anon;
revoke execute on function public.restaurant_can_write(uuid, public.restaurant_role[]) from anon;
revoke execute on function public.restaurant_cash_payout_control() from anon;
revoke execute on function public.restaurant_cash_payout_events_immutable() from anon;
revoke execute on function public.restaurant_cash_payout_no_delete() from anon;
revoke execute on function public.restaurant_cash_payout_total(uuid, uuid, date) from anon;
revoke execute on function public.restaurant_cash_payout_trail() from anon;
revoke execute on function public.restaurant_daily_close_control() from anon;
revoke execute on function public.restaurant_daily_close_payout_sync() from anon;
revoke execute on function public.restaurant_day_is_locked(uuid, uuid, date) from anon;
revoke execute on function public.restaurant_decide_giveaway(uuid, uuid, boolean, text) from anon;
revoke execute on function public.restaurant_declaration_revisions_immutable() from anon;
revoke execute on function public.restaurant_giveaway_guard() from anon;
revoke execute on function public.restaurant_giveaway_no_delete() from anon;
revoke execute on function public.restaurant_giveaway_period_lock() from anon;
revoke execute on function public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) from anon;
revoke execute on function public.restaurant_reverse_giveaway(uuid, uuid, text, text) from anon;
revoke execute on function public.restaurant_tender_declaration_archive() from anon;
revoke execute on function public.restaurant_tender_declaration_control() from anon;

revoke execute on function public.restaurant_apply_giveaway(uuid) from authenticated;
revoke execute on function public.restaurant_apply_stock_movement() from authenticated;
revoke execute on function public.restaurant_cash_payout_control() from authenticated;
revoke execute on function public.restaurant_cash_payout_events_immutable() from authenticated;
revoke execute on function public.restaurant_cash_payout_no_delete() from authenticated;
revoke execute on function public.restaurant_cash_payout_trail() from authenticated;
revoke execute on function public.restaurant_daily_close_control() from authenticated;
revoke execute on function public.restaurant_daily_close_payout_sync() from authenticated;
revoke execute on function public.restaurant_decide_giveaway(uuid, uuid, boolean, text) from authenticated;
revoke execute on function public.restaurant_declaration_revisions_immutable() from authenticated;
revoke execute on function public.restaurant_giveaway_guard() from authenticated;
revoke execute on function public.restaurant_giveaway_no_delete() from authenticated;
revoke execute on function public.restaurant_giveaway_period_lock() from authenticated;
revoke execute on function public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) from authenticated;
revoke execute on function public.restaurant_reverse_giveaway(uuid, uuid, text, text) from authenticated;
revoke execute on function public.restaurant_tender_declaration_archive() from authenticated;
revoke execute on function public.restaurant_tender_declaration_control() from authenticated;

revoke execute on function public.has_any_role(uuid, public.app_role[], uuid, uuid, uuid) from public;
grant execute on function public.has_any_role(uuid, public.app_role[], uuid, uuid, uuid) to authenticated;

revoke execute on function public.has_role(uuid, public.app_role) from public;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;

revoke execute on function public.is_any_staff(uuid) from public;
grant execute on function public.is_any_staff(uuid) to authenticated;

revoke execute on function public.nova_has_permission(uuid, text, uuid, uuid, uuid) from public;
grant execute on function public.nova_has_permission(uuid, text, uuid, uuid, uuid) to authenticated;

revoke execute on function public.nova_permissions_for(uuid) from public;
grant execute on function public.nova_permissions_for(uuid) to authenticated;

revoke execute on function public.restaurant_cash_payout_total(uuid, uuid, date) from public;
grant execute on function public.restaurant_cash_payout_total(uuid, uuid, date) to authenticated;

revoke execute on function public.restaurant_apply_giveaway(uuid) from public;
revoke execute on function public.restaurant_apply_stock_movement() from public;
revoke execute on function public.restaurant_cash_payout_control() from public;
revoke execute on function public.restaurant_cash_payout_events_immutable() from public;
revoke execute on function public.restaurant_cash_payout_no_delete() from public;
revoke execute on function public.restaurant_cash_payout_trail() from public;
revoke execute on function public.restaurant_daily_close_control() from public;
revoke execute on function public.restaurant_daily_close_payout_sync() from public;
revoke execute on function public.restaurant_decide_giveaway(uuid, uuid, boolean, text) from public;
revoke execute on function public.restaurant_declaration_revisions_immutable() from public;
revoke execute on function public.restaurant_giveaway_guard() from public;
revoke execute on function public.restaurant_giveaway_no_delete() from public;
revoke execute on function public.restaurant_giveaway_period_lock() from public;
revoke execute on function public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text) from public;
revoke execute on function public.restaurant_reverse_giveaway(uuid, uuid, text, text) from public;
revoke execute on function public.restaurant_tender_declaration_archive() from public;
revoke execute on function public.restaurant_tender_declaration_control() from public;
