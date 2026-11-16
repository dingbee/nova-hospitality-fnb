# P0-01 — Production hotfix and replay reconciliation

Target: Supabase project `lusiqcmxfxhnehxmwihs`  
PW-07 integration path: `integration/pw07-procurement-mainline`  
Integrated historical lineage: `feat/operational-profitability-integrated` at `53d4d60b73a6021eff8b693b799dc12b8cee966c`

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


## End-to-end execution evidence — 2026-11-16

### Replay blocker corrected

The integrated replay blocker was in `0112_operational_consumables_phase1.sql`, function `public.restaurant_capture_operational_consumption()`. Its dollar-quote terminator was malformed (`END $$$;`). The source migration now ends with `END $$;` at commit `53d4d60b73a6021eff8b693b799dc12b8cee966c`. The PW-07 CI replay pin was updated to that exact commit.

The P0-01 hotfix-parity verification block also had an invalid anonymous-block delimiter (`DO $`); it was corrected to `DO $$` before the successful run.

### Clean replay and CI acceptance

Successful workflow: [LexiBite CI #1727](https://github.com/dingbee/nova-hospitality-fnb/actions/runs/43902452748), PW-07 head `2b249152b9673ee2bfafc86d00c66527a7603614`.

- Strict typecheck, changed-source lint, build, scoped tests and the full repository test suite passed.
- Full merged-repository replay: PostgreSQL 17 (`170012`), 159 migration files, 160 applied ledger rows including the disposable UAT fixture, zero skipped migrations. The before/after replay ledger fingerprint was identical.
- Integrated historical baseline replay: 156 migration files, 157 applied rows including the fixture, zero skipped migrations.
- Integrated hardened replay: 159 migration files, 160 applied rows including the fixture, zero skipped migrations. The before/after hardened ledger fingerprint was identical.
- Operational-expense tables: 2; operational-consumables tables: 3; profitability tables: 2.
- Procurement tenant referential-integrity negative tests passed in both isolated replay paths.
- Schema fingerprints, component fingerprints, object fingerprints and replay SQL/ledger evidence were uploaded as workflow artifacts.

The isolated catalogue verification reported 70 validated tenant-composite foreign keys and 18 valid tenant candidate indexes. Shared/global inventory units were intentionally excluded.

The hotfix parity test passed; the security-policy hardening test passed; the 0076 financial reconstruction test passed. The full CI job concluded SUCCESS.

### Financial-function provenance against production

A read-only comparison was run against production project `lusiqcmxfxhnehxmwihs`. All 19 functions reconstructed by migration 0076 were present in production and their stored function bodies matched the repository definitions after whitespace normalization, accounting for later documented replacements:

- 15 functions: migration 0076.
- `restaurant_daily_close_control`: later correction in migration 0080.
- `restaurant_apply_giveaway`, `restaurant_cash_payout_total`, and `restaurant_expected_tender`: later security-definer hardening in migration 0093.

All 19 production functions were `SECURITY DEFINER`, configured with `search_path=public`, and not executable by `anon`. This comparison confirms the 0076 reconstruction and the subsequent, documented definition changes; it does not treat the later versions as unexplained drift.

### Historical split, rename and consolidation dispositions

- Production records `0001_fnb_core_part1` through `part5` are the five sequential segments of the canonical core-schema creation. The repository replay uses the consolidated `0001_fnb_core.sql` file.
- The concurrent ME-01/ME-02 `0065`/`0066` numeric-prefix collision and subsequent `0065`–`0075` corrective sequence are reconciled in the existing ME-01/02/03 corrective-integration record. Their SQL was captured in production application order; the independent branch versions were not silently overlaid.
- Production recorded the financial reconstruction and `restaurant_day_is_locked` reconstruction as separate ledger entries. The canonical `0076` file contains the complete 19-function set; the clean replay verifies all 19.
- The later `0078`–`0082` corrections remain distinct. Reused numeric prefixes (including `0081` and `0082`) are separate, uniquely named migration files; the local replay ledger keys by full filename and checksum, and applies the files in deterministic filename order.
- The `0095` owner-POS-PIN recovery migration created `restaurant_bootstrap_owner_pos_pin`; `0096` immediately dropped it. The function is absent from the final production catalogue, so this transient create/drop pair has no final schema object to reconstruct.
- `lb02_dispatch_scheduler_extensions` and `lb02_dispatch_cron_schedule` are platform extension/scheduler configuration (`pg_cron`, `pg_net`, Vault and a scheduled HTTP dispatch), not application-table schema. They are not replayed as local product-schema migrations; the production extension catalogue was inspected read-only.
- The separate `lb03_restrict_pos_audit_trigger_function_execution` grant restriction is present in the canonical LB-03 migration.
- Operational-expense lifecycle migrations, operational consumables Phase 1, cost-reconciliation 0042/0043, and profitability Phase 5 were included in the integrated historical replay. CI verified the expected tables and repeatable replay.

### Production-reference comparison and documented deltas

The production migration ledger contains 171 timestamped records, latest version `20261116143857`. Production was inspected read-only; no SQL write, migration application, role change or data mutation was performed.

Production catalogue checks confirmed:

- 19/19 reconstructed financial functions present.
- 0/70 P0-01 tenant-composite foreign keys and 1/18 P0-01 candidate indexes currently present in production. The 70/18 additions are the intentional, isolated-development delta introduced by migration 0134; migration 0134 has not been applied to production.
- Three command-specific member-station RLS policies present and the legacy broad write policy absent, matching migration 0135.
- Five evidence-backed check constraints, the cash-payout updated-at trigger, and the tender-declaration idempotency index present, matching migration 0136.
- The production schema fingerprint is 10 extensions, 221 relations, 126 routines, 1 public schema and 316 types. The isolated hardened replay fingerprint is 5 extensions, 221 relations, 130 routines, 1 public schema and 316 types.

The fingerprint deltas are classified rather than represented as byte-identical catalog state: the isolated PostgreSQL replay has `citext`, `fuzzystrmatch`, `pg_trgm`, `pgcrypto` and `plpgsql`, while production additionally has `pg_cron`, `pg_net`, `pg_stat_statements`, `supabase_vault` and `uuid-ossp`; the four additional replay routines are the two local email-queue compatibility functions, the repository-only ME-13 PO-fulfilment helper, and the repository POS-session start function not present in the final production catalogue. The relation fingerprint also includes the intentional 0134 tenant-FK/index delta and repository-only schema features. The 19 financial functions and the P0-01-specific constraints, indexes, trigger and RLS policies were checked separately against production. Full raw fingerprints remain attached to CI artifacts for audit.

### P0-01 acceptance disposition

| Gate | Result |
|---|---|
| P0-01.01 Migration inventory | PASS |
| P0-01.02 Historical lineage reconciliation | PASS — split, collision, consolidation and external scheduler dispositions recorded |
| P0-01.03 Replay equivalence | PASS — both clean replay paths and repeatability checks passed |
| P0-01.04 Schema/function reconciliation | PASS WITH DOCUMENTED DELTAS — production comparison and isolated hardening deltas recorded |
| P0-01.05 Full acceptance checklist | PASS |

P0-01 is accepted on the isolated development evidence at commit `2b249152b9673ee2bfafc86d00c66527a7603614`. P0-02 is eligible for a separately authorized next sequence but has not been started.

## Change-control result

- PR #186 remains open and draft on the existing PW-07 integration path.
- PR #187 remains open and draft as the dependent PW-08 branch; it was not edited, promoted or merged.
- No production schema, data, migration ledger, role, membership, grant or RLS policy was changed.
- No PR was merged, no release was promoted and no production deployment was performed.
