# ME-17R-05 — Git ↔ Supabase Schema Reconciliation / Function Provenance

**Status:** COMPLETE — provenance reconciliation evidence captured; no production DDL required.

## Objective

Close the remaining Git ↔ Supabase schema-reconciliation risk carried from the earlier ME-03/ME-00 corrective work, with specific focus on the **18 production-only financial-control functions** originally found without a defining Git migration.

The reconciliation distinguishes:

1. the original 18-function production-only gap;
2. the additional `restaurant_day_is_locked` function discovered while reconstructing those functions;
3. later migrations that legitimately replaced/changed individual definitions.

## Live production evidence

Supabase project: `nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`).

The live migration ledger currently contains **95 applied migrations**, through:

- `20260920094122 — p13_dynamic_ai_provider_registry`

The production database currently exposes the reconstructed functions in `public`.

The authoritative production ledger was queried directly through `supabase_migrations.schema_migrations`. For each target function, the ledger was searched specifically for a `CREATE OR REPLACE FUNCTION public.<name>` statement — not merely a later GRANT/REVOKE or textual reference.

## Provenance resolution

### Original 18-function gap

The 18 functions documented by ME-03 are now represented by:

**`standalone/db/migrations/0076_me02_me03_financial_functions_reconstruction.sql`**

That migration explicitly states that its SQL was reconstructed from production `pg_get_functiondef` / trigger metadata and that the definitions were captured from the authoritative production database.

The 18-function set is:

- `restaurant_apply_giveaway`
- `restaurant_cash_payout_control`
- `restaurant_cash_payout_events_immutable`
- `restaurant_cash_payout_no_delete`
- `restaurant_cash_payout_total`
- `restaurant_cash_payout_trail`
- `restaurant_daily_close_control`
- `restaurant_daily_close_payout_sync`
- `restaurant_decide_giveaway`
- `restaurant_declaration_revisions_immutable`
- `restaurant_expected_tender`
- `restaurant_giveaway_guard`
- `restaurant_giveaway_no_delete`
- `restaurant_giveaway_period_lock`
- `restaurant_request_giveaway`
- `restaurant_reverse_giveaway`
- `restaurant_tender_declaration_archive`
- `restaurant_tender_declaration_control`

### Nineteenth function discovered during reconstruction

`restaurant_day_is_locked` was discovered as a dependency of the reconstructed financial-control functions and was separately reconstructed in the subsequent corrective migration:

**`me01_me02_me03_corrective_day_is_locked_reconstruction`**

The live ledger identifies this migration as:

`20260915084951 — me01_me02_me03_corrective_day_is_locked_reconstruction`.

## Latest-definition provenance

The reconciliation also accounts for subsequent legitimate definition changes.

| Function | Current provenance source | Interpretation |
|---|---|---|
| `restaurant_daily_close_control` | `20260918051808 — me04_daily_close_double_close_race` | Later concurrency hardening replaced the reconstructed definition. |
| `restaurant_day_is_locked` | `20260915084951 — me01_me02_me03_corrective_day_is_locked_reconstruction` | Separate corrective reconstruction. |
| Other 17 reconstructed functions | `20260915084602 — me01_me02_me03_corrective_financial_functions_reconstruction` | Original reconstructed definition remains the latest CREATE/REPLACE source in the production migration ledger. |

This is important: **provenance is not defined as “the first migration that ever mentioned a function.”** The latest migration containing an actual `CREATE OR REPLACE FUNCTION` statement is the authoritative Git migration for the live definition.

## Result

The former “production-only / unclear provenance” classification is closed for this function set:

- **18 original functions:** provenance resolved to migration `0076` / production ledger version `20260915084602`.
- **`restaurant_day_is_locked`:** provenance resolved to its dedicated corrective migration / version `20260915084951`.
- **`restaurant_daily_close_control`:** later definition change resolved to ME-04 / version `20260918051808`.
- No target function remains dependent on an undocumented, live-only definition.
- No production schema change was required for ME-17R-05.
- The reconciliation is repeatable using the verification SQL committed alongside this document.

## Scope boundary

ME-17R-05 does **not** re-audit the security correctness of all 79 public functions. That is covered by the ME-02/ME-03 security and transactional certification work.

ME-17R-05 closes the narrower question:

> **Can the live financial-control function definitions be traced to an explicit, ordered migration source in Git/production migration history?**

For the 19-function corrective set, the answer is **yes**.

## Verification

Use:

`standalone/db/verification/me-17r-05-function-provenance.sql`

Expected result:

- 19 target functions found;
- each has a live `pg_proc` definition;
- each has an authoritative migration-ledger `CREATE OR REPLACE FUNCTION` source;
- expected migration provenance matches the recorded source;
- zero unresolved provenance rows.

