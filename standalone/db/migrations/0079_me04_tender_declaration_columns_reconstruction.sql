-- ME-04: restaurant_tender_declarations is missing three columns in Git
-- that already exist live in production (lusiqcmxfxhnehxmwihs), captured
-- verbatim via information_schema introspection, 2026-09-18:
--
--   revision            integer NOT NULL DEFAULT 1
--   revision_reason     text
--   client_request_id   text
--
-- Root cause: 0076 (the ME-01/02/03 corrective integration) reconstructed
-- the 19 missing cash-payout/daily-close/tender-declaration/giveaway
-- functions and 3 missing tables verbatim from production, but its own
-- "missing columns on existing tables" section covered only
-- restaurant_daily_closes and restaurant_discount_applications --
-- restaurant_tender_declarations was missed even though the very trigger
-- functions 0076 reconstructs (restaurant_tender_declaration_control,
-- restaurant_tender_declaration_archive) reference NEW.revision,
-- OLD.revision and NEW.revision_reason. Proven by replaying migrations
-- 0000-0078 against a genuinely fresh local Postgres 16 instance: the
-- first INSERT into restaurant_tender_declarations after 0076 applies
-- fails with "column \"revision\" does not exist", because the trigger
-- body (correct, taken verbatim from production) assumes a column no Git
-- migration ever created.
--
-- Idempotent (IF NOT EXISTS), so this is a no-op against production
-- (already has these columns) and only affects a fresh install.

ALTER TABLE public.restaurant_tender_declarations
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS revision_reason text,
  ADD COLUMN IF NOT EXISTS client_request_id text;
