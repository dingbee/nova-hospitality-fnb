-- P0-04: preserve maker identity for procurement variance decisions.
-- Variances are raised from receiving, invoice reconciliation and other
-- governed procurement workflows. Without creator attribution, a resolver
-- cannot be checked against the maker. Historical rows remain NULL because
-- their original creator cannot be reconstructed reliably; new rows record
-- the authenticated actor in variances.server.ts.

ALTER TABLE public.restaurant_procurement_variances
  ADD COLUMN IF NOT EXISTS created_by uuid;

COMMENT ON COLUMN public.restaurant_procurement_variances.created_by IS
  'P0-04 maker-checker attribution: authenticated actor who raised the variance; NULL on legacy rows with no reconstructable creator.';
