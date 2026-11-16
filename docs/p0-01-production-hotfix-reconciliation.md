# P0-01 — Production hotfix and replay reconciliation

Target: Supabase project `lusiqcmxfxhnehxmwihs`  
PW-07 integration path: `integration/pw07-procurement-mainline`  
Integrated historical lineage: `feat/operational-profitability-integrated` at `5adec91aa8366fc6b3fe1a8fb70568a802c97858`

## Current production ledger and repository baselines

The production migration ledger now contains **171 records**, latest version `20261116143857`. It includes the 13 operational-expense lifecycle migrations, operational consumables Phase 1 (`20261116143842`) and profitability snapshots Phase 5 (`20261116143857`).

The current PW-07 branch contains 144 standalone migration files. The integrated historical branch contains 156, including the operational-expense lifecycle and the Phase 1/Phase 5 migrations. P0-01 CI replays both paths separately and adds the three current PW-07 reconciliation migrations (`0134`, `0135`, `0136`) to the integrated historical replay.

## Evidence-backed development correction

Migration `0136_restore_documented_production_hotfixes.sql` restores DDL verified from the production migration ledger or read-only production catalogs:

- Three cash-payout check constraints from production record `20260915084602`.
- Two discount-application checks from `restore_restaurant_check_constraints` (`20260824115808`).
- The cash-payout updated-at trigger from `restore_restaurant_trigger_parity` (`20260824114307`).
- The partial unique tender-declaration request index, verified in `pg_indexes`; no matching versioned production migration record was found.

The migration is guarded and replay-tested in both isolated chains. It has not been applied to production.

## Reconciliation dispositions

- Production currently has 70 tenant-composite FK relationships identified by migration 0134. The read-only cross-tenant data check found zero violating links. The current production catalog has 0/70 of those composite FKs and 1/18 supporting candidate indexes. Migration 0134 remains development-only.
- Migration 0135 reproduces the production member-station command-specific RLS policy state.
- The current PW-07 branch intentionally tightens document-event reads, pricing-audit read/insert, receipt-delivery access, and location-aware price reads relative to production. These policy assertions run against the PW-07 replay only; they are not imposed on the older integrated historical branch.
- Mobile-money provider credential fields and a provider index are repository-only functionality from migrations 0100/0102. Production does not yet contain those fields; this is an unapplied repository feature.
- The local `migration_transfer_audit` compatibility stub now includes the production `source_count` and `target_count` columns.
- The inspected `restore_missing_restaurant_columns`, `restore_nonunique_index_parity`, `restore_tax_channel_column`, `restore_remaining_restaurant_triggers`, and `0005b_restore_has_any_role_defaults` effects are otherwise represented in the current replay.

## Change control

All corrections are on the existing PW-07 development integration branch. PR #187 remains an unchanged dependent PW-08 draft. No production schema, data, migration ledger, RLS policy, grant, role or membership was modified. No merge, release or deployment is authorized.
