-- ME-10 import/migration certification: Import Studio's four staging/
-- orchestration tables were never granted table-level privileges to
-- `authenticated` or `service_role`, in violation of this codebase's own
-- otherwise-universal convention (every other table created in this schema
-- — see e.g. 0001_fnb_core.sql's restaurant_inventory_batches,
-- restaurant_stocktakes, etc. — pairs its RLS policies with
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO authenticated;` and
-- `GRANT ALL ON <table> TO service_role;` immediately alongside them).
--
-- 0013_import_studio.sql created restaurant_import_workspaces,
-- restaurant_import_sources and restaurant_import_field_mappings — and
-- 0013/0020 together created restaurant_import_staged_records — with RLS
-- enabled and read/write policies scoped `TO authenticated`, but with no
-- GRANT statement at all for any of the four tables, on any role, anywhere
-- in the migration history (verified by searching the full migrations tree:
-- zero matches for a GRANT naming any of these tables before this one).
--
-- Effect, proven by direct reproduction against a from-scratch replay of
-- this exact migration chain (PostgreSQL 16, product roles, RLS-derived
-- policies as authored): a real `authenticated` Postgres role — i.e. every
-- real signed-in user, through PostgREST/Supabase exactly as
-- import.server.ts's server functions reach the database — gets
-- `permission denied for table restaurant_import_workspaces` (and likewise
-- for the other three) on every operation, including a plain SELECT of a
-- workspace's own tenant, and including a same-property INSERT by a caller
-- who holds every capability/role check the application layer requires.
-- GRANT is evaluated before RLS; an owner with full "import.manage" rights
-- at their own property cannot create, read, upload to, stage, review or
-- commit a single import workspace. This is not a narrow authorization gap
-- (contrast 0063, which narrows an already-working write from tenant-wide
-- to property-scoped) — it is a missing prerequisite that makes the entire
-- Import Studio surface (Advanced Import and the LexiBite Template path
-- alike, since template-import.server.ts rides the same tables end to end)
-- unusable for any authenticated caller, in both the standalone appliance
-- and a hosted Supabase project alike (Supabase does not implicitly grant
-- table privileges either; every other table in this schema grants them
-- explicitly, which is exactly why this one omission is a defect and not a
-- platform default this repo can rely on).
--
-- This was invisible to the existing unit test suite because
-- import.server.test.ts runs the same orchestration logic against an
-- in-memory fake Supabase client that has no Postgres GRANT/RLS layer at
-- all — those tests correctly verify what import.server.ts *decides*, but
-- nothing in the existing suite exercises the real database's privilege
-- model, so a missing GRANT (or a missing/wrong RLS policy) is invisible to
-- them by construction. Confirmed live via a genuine cross-role adversarial
-- probe: `SET ROLE authenticated` + a simulated JWT for a
-- restaurant_manager scoped to one property, run against a from-scratch
-- replay of this migration chain.
--
-- Fix: grant the same privileges to the same roles this schema grants
-- every comparable table, and nothing more — RLS (0013's own policies,
-- narrowed by 0063/0072) remains the only thing deciding which specific
-- rows an authenticated caller may see or touch; this migration only
-- restores their ability to reach that check at all.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_import_workspaces TO authenticated;
GRANT ALL ON public.restaurant_import_workspaces TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_import_sources TO authenticated;
GRANT ALL ON public.restaurant_import_sources TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_import_field_mappings TO authenticated;
GRANT ALL ON public.restaurant_import_field_mappings TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_import_staged_records TO authenticated;
GRANT ALL ON public.restaurant_import_staged_records TO service_role;
