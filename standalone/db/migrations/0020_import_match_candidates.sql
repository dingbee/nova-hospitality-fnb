-- Import Intelligence generalization: surface the alternative candidates a
-- staged row's own identity was actually ranked against, so a reviewer
-- resolving an ambiguous/possible-match row can pick a different existing
-- entity instead of only being able to approve or reject. Additive only —
-- empty for every row staged before this migration and for any row where
-- there is nothing to pick between (a clean new entity, or a relationship
-- reference to another domain's row).
alter table public.restaurant_import_staged_records
  add column match_candidates jsonb not null default '[]'::jsonb;
