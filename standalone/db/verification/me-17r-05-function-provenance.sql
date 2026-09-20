-- ME-17R-05 — function provenance verification
-- Read-only. Safe to run against the live Supabase database.
-- Purpose: prove that the 18 historically production-only financial-control
-- functions plus restaurant_day_is_locked have explicit migration provenance.

with expected(name, expected_version, expected_migration) as (
  values
    ('restaurant_apply_giveaway', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_cash_payout_control', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_cash_payout_events_immutable', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_cash_payout_no_delete', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_cash_payout_total', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_cash_payout_trail', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_daily_close_control', '20260918051808', 'me04_daily_close_double_close_race'),
    ('restaurant_daily_close_payout_sync', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_day_is_locked', '20260915084951', 'me01_me02_me03_corrective_day_is_locked_reconstruction'),
    ('restaurant_decide_giveaway', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_declaration_revisions_immutable', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_expected_tender', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_giveaway_guard', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_giveaway_no_delete', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_giveaway_period_lock', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_request_giveaway', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_reverse_giveaway', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_tender_declaration_archive', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction'),
    ('restaurant_tender_declaration_control', '20260915084602', 'me01_me02_me03_corrective_financial_functions_reconstruction')
),
live_functions as (
  select
    p.proname as name,
    p.oid::regprocedure::text as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
),
latest_create as (
  select distinct on (e.name)
    e.name,
    m.version,
    m.name as migration_name
  from expected e
  join supabase_migrations.schema_migrations m on true
  cross join lateral unnest(m.statements) s(statement)
  where s.statement ~* (
    'create[[:space:]]+or[[:space:]]+replace[[:space:]]+function[[:space:]]+public[.]'
    || e.name
    || '([[:space:]]|\\()'
  )
  order by e.name, m.version desc
)
select
  e.name,
  lf.signature,
  e.expected_version,
  e.expected_migration,
  lc.version as live_latest_create_version,
  lc.migration_name as live_latest_create_migration,
  case
    when lf.name is null then 'FAIL: live function missing'
    when lc.version is null then 'FAIL: no migration CREATE source'
    when lc.version <> e.expected_version
      or lc.migration_name <> e.expected_migration
      then 'FAIL: provenance mismatch'
    else 'PASS'
  end as status
from expected e
left join live_functions lf on lf.name = e.name
left join latest_create lc on lc.name = e.name
order by e.name;

-- Certification summary:
-- Expected: 19 rows, all status = PASS.
