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
--
-- ME-04 correction (this block only, everything else in this file
-- unchanged): this migration was written when the 18 cash-payout/daily-
-- close/tender-declaration/giveaway functions it revokes/grants EXECUTE on
-- already existed live in production (they predate this repository's
-- earliest captured baseline). They were not CREATEd by any Git migration
-- until 0076_me02_me03_financial_functions_reconstruction.sql, 28
-- migrations later. Replaying 0000-0078 against a fresh database --
-- exactly what a new install or a CI database test does -- therefore
-- failed here with "function ... does not exist", proven by a from-scratch
-- local replay. Production is unaffected (the functions already existed
-- when this ran there; re-running this migration is a no-op regardless
-- since Supabase's migration ledger never replays an applied migration),
-- so guarding these specific statements on the function already existing
-- changes no live behavior anywhere -- it only makes a from-scratch
-- replay succeed, deferring to 0076's own (identical) grant state for a
-- fresh install. The other 8 functions this migration touches
-- (nova_user_roles_view, migration_transfer_audit,
-- has_any_role/has_role/is_any_staff/nova_has_permission/
-- nova_permissions_for, restaurant_apply_stock_movement,
-- restaurant_can_read/restaurant_can_write) are all defined by migrations
-- 0001-0004, well before this one, and are left as plain statements.

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
revoke execute on function public.restaurant_apply_stock_movement() from anon;
revoke execute on function public.restaurant_can_read(uuid) from anon;
revoke execute on function public.restaurant_can_write(uuid, public.restaurant_role[]) from anon;

-- ME-04: guarded on existence -- see the correction note above this block.
-- These 18 functions are not CREATEd until 0076; on a fresh install they
-- do not exist yet when this migration runs.
do $$
declare
  sig text;
  targets text[] := array[
    'public.restaurant_apply_giveaway(uuid)',
    'public.restaurant_cash_payout_control()',
    'public.restaurant_cash_payout_events_immutable()',
    'public.restaurant_cash_payout_no_delete()',
    'public.restaurant_cash_payout_total(uuid, uuid, date)',
    'public.restaurant_cash_payout_trail()',
    'public.restaurant_daily_close_control()',
    'public.restaurant_daily_close_payout_sync()',
    'public.restaurant_day_is_locked(uuid, uuid, date)',
    'public.restaurant_decide_giveaway(uuid, uuid, boolean, text)',
    'public.restaurant_declaration_revisions_immutable()',
    'public.restaurant_giveaway_guard()',
    'public.restaurant_giveaway_no_delete()',
    'public.restaurant_giveaway_period_lock()',
    'public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text)',
    'public.restaurant_reverse_giveaway(uuid, uuid, text, text)',
    'public.restaurant_tender_declaration_archive()',
    'public.restaurant_tender_declaration_control()'
  ];
begin
  foreach sig in array targets loop
    if to_regprocedure(sig) is not null then
      execute format('revoke execute on function %s from anon', sig);
      execute format('revoke execute on function %s from authenticated', sig);
      execute format('revoke execute on function %s from public', sig);
    end if;
  end loop;
  -- restaurant_cash_payout_total is one of the six read-only lookups this
  -- migration re-grants to authenticated (see note above); the rest stay
  -- revoked from authenticated (re-granted, where still needed, only by
  -- 0076 once they exist).
  if to_regprocedure('public.restaurant_cash_payout_total(uuid, uuid, date)') is not null then
    execute 'grant execute on function public.restaurant_cash_payout_total(uuid, uuid, date) to authenticated';
  end if;
end $$;

revoke execute on function public.restaurant_apply_stock_movement() from authenticated;

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

revoke execute on function public.restaurant_apply_stock_movement() from public;
