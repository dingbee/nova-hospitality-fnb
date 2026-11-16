# WCE — Production Migration Provenance Reconciliation

**Scope:** Read-only production ledger inspection and repository source reconciliation  
**Production project:** `lusiqcmxfxhnehxmwihs` (PostgreSQL 17.11)  
**Repository baseline inspected:** `main` @ `f6fd6824c672b386c1b0a4c450dd08cc5a28c443`  
**Recovery branch:** `wce/migration-provenance-recovery`  
**Production writes:** None. No migration was applied, marked applied, deleted, or reordered in production.

## 1. Reconciled counts and interpretation

| Evidence | Count | Meaning |
|---|---:|---|
| Production `supabase_migrations.schema_migrations` | 171 | Applied ledger rows, ordered by immutable version |
| Repository `standalone/db/migrations/` at inspected main | 157 | Current source files before this recovery branch |
| Historical source files recovered on this branch | +6 | Exact SQL recovered from the production ledger |
| Repository source inventory after recovery | 163 | Does not yet equal the production ledger because source consolidation and newer repository-only migrations are present |

The raw 171-versus-157 difference is **not** a count of missing migrations. The history contains five split core migrations represented by one canonical core file, several explicitly consolidated/renamed migrations, repeated migration-number prefixes, temporary migrations later removed, and newer repository files not present in the production ledger.

The production ledger stores the executed SQL in `statements`, plus `version`, `name`, `created_by`, `idempotency_key` and `rollback`. The read-only inspection confirmed all 171 rows have one statement array entry and **zero rollback entries**. The ledger was not changed.

## 2. Provenance matrix — historical split, rename and consolidation

| Production ledger record(s) | Canonical repository source | Disposition |
|---|---|---|
| `0001_fnb_core_part1` … `0001_fnb_core_part5` | `0001_fnb_core.sql` | Five-part hosted application consolidated into the generated standalone core schema. The canonical file documents machine-verified top-to-bottom replay on an empty PostgreSQL 17 database. |
| `migration_transfer_audit_20260824`, `restore_restaurant_trigger_parity`, `restore_missing_restaurant_columns`, `finish_restaurant_security_parity_v2`, `restore_tax_channel_column`, `restore_remaining_restaurant_triggers`, `restore_nonunique_index_parity`, `restore_restaurant_check_constraints` | `0001_fnb_core.sql` / `0002_hospitality_bridge.sql` baseline | Historical 2026-08-24 repair set, previously reconciled in `docs/me-00/ME-00-baseline-lock.md`; no separate current source file for each hot-fix. Final object-level parity still belongs in clean replay/schema comparison. |
| `0005b_restore_has_any_role_defaults` | `0005_fix_has_any_role_ambiguity.sql` | Same five-argument `has_any_role` definition/default arguments are in the canonical file; subsequent two-argument overload removal is also present. |
| `i7_restaurant_operational_reviews`, `i9_intelligence_events_processed_update`, `restaurant_tenant_logos`, `intelligence_memory_and_feedback` | `0021`, `0022`, `0023`, `0024` respectively | Renamed/renumbered sources. |
| `mobile_money_accounts_read_policy_fix` | `0026_mobile_money_foundation.sql`, followed by `0028_p1_property_scope_closure.sql` | The original read policy is present in the foundation; later canonical migration narrows it to property scope. |
| `p1_fix_read_scoped_tenant_isolation_bug`, `p01_completion_ai_concierge_entitlement_fix` | `0029_p1_fix_read_scoped_isolation_bug.sql`, `0036_p01_completion_ai_concierge_correction.sql` | Renamed/corrected canonical sources. |
| `p11_security_definer_and_rls_hardening`, `p11_anon_execute_revocation`, `p11_anon_execute_revocation_public_grant` | `0048_p11_security_hardening.sql` | Three production steps represented by one canonical security-hardening source. |
| `p11_fiscal_counter_authorization_fix` | `0066_p11_fiscal_counter_authorization.sql` | Canonical source header explicitly identifies the production version and name. |
| `me01_me02_me03_corrective_financial_functions_reconstruction`, `me01_me02_me03_corrective_day_is_locked_reconstruction` | `0076_me02_me03_financial_functions_reconstruction.sql` | Combined reconstruction; file documents exact production `pg_get_functiondef` / trigger and catalog evidence. |
| `me01_me02_corrective_rbac_user_roles_read_scope_regression_fix` | `0077_corrective_rbac_user_roles_read_scope_regression_fix.sql` | Renamed canonical corrective source. |
| `commercial_capability_activation_reconciliation_v2` | `0088_commercial_capability_activation_reconciliation.sql` | Canonical reconciliation source. |
| `property_location_integrity_0109`, `tenant_central_store_scope_0110`, `allow_tenant_central_store_pending_property_0111` | `0109`, `0110`, `0111` sources | Renamed/renumbered; source content and intent align. |
| `lb01_product_connection_persistence`, `lb01_product_connection_persistence_schema` | `0112_lb01_product_connection_persistence.sql` | First ledger record is a comment-only marker; schema-bearing record is the canonical implementation. |
| `cost_reconciliation_variance_intelligence_0042`, `cost_reconciliation_baselines_0043` | `0042_cost_reconciliation_variance_intelligence.sql`, `0043_cost_reconciliation_baselines.sql` | Renamed/renumbered; canonical files present. |
| `operational_consumables_phase1`, `operational_profitability_snapshots_phase5` | `0112_operational_consumables_phase1.sql`, `0133_operational_profitability_snapshots.sql` | Canonical current sources present. |

## 3. Applied ledger sources recovered on this branch

The following production-applied statements were absent as individual repository files and were recovered from the read-only `statements` column. Each SQL checksum below is the MD5 of the exact ledger statement text (not a Git blob hash).

| New canonical file | Production version / name | SQL MD5 | Why recovery matters |
|---|---|---|---|
| `0090_member_station_assignment_rls_overlap_cleanup.sql` | `20260922110540 / 0090_member_station_assignment_rls_overlap_cleanup` | `85844bb8a15acdb1d71a25fe4c81cb0a` | **P1 authorization:** drops the broad write policy and creates separate insert/update/delete policies with tenant, property and station ownership checks. The prior `0089` source alone does not reproduce this final policy split. |
| `0095_pos_owner_access_recovery.sql` | `20260926140534 / 0095_pos_owner_access_recovery` | `1a0e6d98882316a334d43e4dcad47221` | Historical temporary owner PIN bootstrap function, recovered verbatim. |
| `0096_remove_owner_pos_pin_recovery.sql` | `20260926144758 / 0096_remove_owner_pos_pin_recovery` | `597effaa4e66651854ba4cba9339b46c` | Immediately drops the temporary function created by 0095; preserves the historical lifecycle and final state. |
| `0120_lb02z_dispatch_scheduler_extensions.sql` | `20261112064645 / lb02_dispatch_scheduler_extensions` | `cc43db4d0d744210ecdf2d9e95b9cbe4` | Reconstructs the hosted pg_cron / pg_net prerequisites and extensions schema. Local installer neutralises platform-only extension creation. |
| `0120_lb02zz_dispatch_cron_schedule.sql` | `20261112064700 / lb02_dispatch_cron_schedule` | `5c67d21d1f41ca18a75776e50cccf42e` | Reconstructs the five-minute LB-02 outbox dispatch schedule. Local compatibility records it inactive; no external request is issued in local replay. |
| `0122_lb03z_restrict_pos_audit_trigger_function_execution.sql` | `20261112065129 / lb03_restrict_pos_audit_trigger_function_execution` | `56db56865d7d637e3a9b99822917489f` | **P1 security:** removes direct EXECUTE from PUBLIC, anon, authenticated and service_role on the audit immutability trigger function. |

The six files are recovery sources only. Their matching changes were already applied in the production ledger; this branch has not executed them against production.

## 4. Repository-only files and unapplied work

Current `main` also contains later implementation files that do not appear as applied ledger names. Examples include the P0-02 purchase-unit snapshot migration `0137_p0_02_purchase_unit_snapshot.sql` and several later channel, POS, commercial, product-bridge and performance changes. These are not to be marked applied or silently folded into production history. They must be replayed as forward repository migrations in the isolated clean-database test and remain production-unapplied until separately authorized.

Duplicate numeric prefixes (for example 0040–0043, 0081–0089, 0091–0094, 0100, 0112, 0120–0122) mean numeric prefix alone is not a reliable chronological identifier. The filename-sorted local installer is the current replay contract; the clean replay will expose any dependency ordering defect. Do not renumber or rewrite an already-applied source file to force an artificial sequence.

## 5. Clean-database replay strategy and current verification gate

The canonical isolated harness is the repository's existing local database bootstrap, not the production Supabase project:

1. Start a disposable PostgreSQL 17 database in CI.
2. Apply `local/sql/pre/00-roles.sql`, `01-extensions.sql`, `02-auth-shim.sql` and `03-supabase-compat.sql`.
3. Run `local/scripts/apply-migrations.sh` against every file under `standalone/db/migrations/` in the script's actual filename order, with atomic per-file application and SHA-256 ledger checks.
4. Apply `local/sql/post/10-nova-local.sql`.
5. Assert representative core, integration, LB-02 inbox, LB-03 financial ledger, profitability, policy and scheduler objects.
6. Confirm local cron is recorded inactive and no network dispatch occurs.
7. Compare expected application contracts and RLS/policy/function privileges after replay.

A CI workflow step implementing this isolated replay and object/security assertions passed on commit `3ba1f88ebc5159f0f4aee2e915c7d5cd22e6d122`, run `43955212519`.

**Replay evidence:** 162 migration files applied, 1 data-only migration marked not applicable, 0 already-present. The single local-only skip is `0087_repair_bar_station_routing.sql`, which repairs a KILI-029 UAT demo order-line fixture and is not schema DDL. It is skipped only in the empty local appliance because that UAT tenant fixture is not seeded; production history is unchanged.

The replay created 217 public tables and verified **217/217 have RLS enabled**, matching the production catalog count. It also verified: the LB-02 cron job is recorded inactive in local compatibility mode; station-assignment write policies are split into insert/update/delete with no broad write policy; the LB-03 audit trigger function has no direct EXECUTE grant to anon/authenticated/service_role; and the temporary owner POS PIN recovery function is absent after 0096.

The first replay attempt also exposed a source divergence in `0088_commercial_capability_activation_reconciliation.sql`: its UPDATE target alias was referenced from a JOIN `ON` clause, which PostgreSQL rejects. The repository-only source was corrected to the comma-FROM/WHERE form present in the applied production ledger statement. The full replay then passed. No clean replay is claimed against production; this is an isolated PostgreSQL 17 result.

## 6. Rollback and recovery assessment

- The production migration ledger contains zero rollback statements for all 171 applied records. Production migration rollback is therefore not a supported automatic path.
- The local installer applies each migration plus its local checksum-ledger row in one transaction; a failure rolls back that file's transaction, not prior files.
- For production, use forward corrective migrations, tested backups/PITR and explicit restore plans. Never delete or edit production ledger rows to reconcile counts.
- Do not mutate historical migration files after application. Recovered files are new source additions with their exact historical SQL; they must not be applied to production again.
- Before WCE-02 DDL, require a green full clean replay, a schema-contract diff, and explicit review of every P1 authorization/privilege finding.

## 7. Current disposition

**Migration provenance:** VERIFIED FOR WCE-02 — 171 live ledger rows preserved; historical split/rename/consolidation groups mapped; 6 missing applied SQL sources recovered; 10 repository-only migrations identified as not present in the production ledger.  
**Clean replay:** VERIFIED — CI run `43955212519`; 162 applied, 1 UAT-only data repair not applicable; 217/217 public tables RLS-enabled; security policy/function assertions PASS.  
**Production mutation:** NONE.  
**WCE-02 database gate:** VERIFIED — additive WCE schema implementation may proceed on a branch stacked on this recovery branch; production migration execution remains unauthorized.


## 8. Follow-on implementation gate

WCE-02 may now introduce additive messaging/session schema on a branch based on this recovery branch. The WCE-02 migration must itself pass the same clean replay, public-table RLS assertion, tenant/property/outlet isolation tests and full CI before WCE-03 begins. The recovered source branch and this provenance PR remain unmerged; no production deployment is implied by the green isolated replay.
