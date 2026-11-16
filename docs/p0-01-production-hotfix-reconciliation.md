# P0-01 — Production hotfix and replay reconciliation

Target: Supabase project `lusiqcmxfxhnehxmwihs`  
Integration path: `integration/pw07-procurement-mainline`

## Evidence-backed development correction

Migration `0136_restore_documented_production_hotfixes.sql` restores only DDL verified from the production migration ledger or read-only production catalogs:

- Three cash-payout check constraints from production record `20260915084602`.
- Two discount-application checks from `restore_restaurant_check_constraints` (`20260824115808`).
- The cash-payout updated-at trigger from `restore_restaurant_trigger_parity` (`20260824114307`).
- The partial unique tender-declaration request index, verified in `pg_indexes`; no matching versioned production migration record was found.

The migration is guarded and replay-tested. It has not been applied to production.

## Reconciliation dispositions

- Production currently has 70 tenant-composite FK relationships identified by migration 0134. The read-only cross-tenant data check found zero violating links. The current production catalog has 0/70 of those composite FKs and 1/18 supporting candidate indexes. Migration 0134 remains development-only.
- Migration 0135 reproduces the production member-station command-specific RLS policy state.
- Repository RLS is intentionally stricter than production for document-event reads, pricing-audit read/insert, receipt-delivery access, and location-aware price reads. Tests preserve these narrower policies; they are documented security deltas, not silently normalized to broader production policies.
- Mobile-money provider credential fields and a provider index are repository-only functionality from migrations 0100/0102. Production does not yet contain those fields; this is an unapplied feature migration.
- The local `migration_transfer_audit` compatibility stub now includes the production `source_count` and `target_count` columns.
- The inspected `restore_missing_restaurant_columns`, `restore_nonunique_index_parity`, `restore_tax_channel_column`, `restore_remaining_restaurant_triggers`, and `0005b_restore_has_any_role_defaults` effects are otherwise represented in the current replay.

## Change control

All corrections are on the existing PW-07 development integration branch. No production schema, data, migration ledger, RLS policy, grant, role or membership was modified. No merge, release or deployment is authorized.
