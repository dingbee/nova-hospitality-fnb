-- P01 FOLLOW-UP FIX — live adversarial verification caught a real gap.
--
-- restaurant_subscriptions has carried a write policy since 0001_fnb_core.sql
-- gated on restaurant_is_platform_admin(auth.uid()) — a placeholder from when
-- this table had no real commercial semantics and zero write path existed.
-- restaurant_is_platform_admin delegates to has_any_role(_user_id,
-- ARRAY['owner','admin','manager']), which is vacuously true for tenant
-- scope whenever the caller holds ANY owner/admin/manager role anywhere
-- (the same pre-existing, deliberately-untouched conflation documented in
-- migration 0034's header comment). Left in place, that policy let a
-- tenant OWNER write directly to their own restaurant_subscriptions row —
-- reassigning their own plan_id/programme_id (e.g. to ENTERPRISE or
-- FOUNDING_10) with no commercial admin involvement at all, defeating the
-- entire point of P01's commercial admin gate for this one table.
--
-- Verified live: as a real UAT Tenant A owner (not a commercial admin),
-- `INSERT INTO restaurant_subscriptions (...)` succeeded before this fix.
--
-- Fix: restaurant_subscriptions now has exactly one write policy —
-- commercial-admin-only — and exactly one read policy — the tenant's own
-- members, or a commercial admin. No other application code writes to
-- this table (confirmed: it held zero rows before P01, and
-- catalog.server.ts#upsertSubscription is the only writer introduced).
-- This does not touch restaurant_is_platform_admin/has_any_role
-- themselves, or any other table's use of them — only this table's now-
-- redundant, over-broad policy is removed.

DROP POLICY IF EXISTS "subscriptions write" ON public.restaurant_subscriptions;
DROP POLICY IF EXISTS "subscriptions read" ON public.restaurant_subscriptions;
