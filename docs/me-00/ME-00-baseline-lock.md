# ME-00 — Market Entry Baseline Lock

Product: LexiBite / NOVA Hospitality F&B — Restaurant & Bar Operating System
Repository: `dingbee/nova-hospitality-fnb`
Certification Programme: Market Entry (ME) — Gate ME-00 (Baseline Lock)
Inspection date: 2026-09-14
Nature of this document: read-only inspection and evidence capture. No application code, schema, migration, RLS policy, function, index, configuration, dependency, or production data was modified to produce it. This document itself is a new file; no existing file was changed.

---

## ME-00-A — Git Baseline

- Repository: `dingbee/nova-hospitality-fnb`
- Inspected ref: `main` (checked out **detached** at `origin/main`'s tip in this session's working copy)
- HEAD commit: `a481620f73d37a4042c8f99b6ad828d7bc4e9560`
- Commit subject: "Merge P10 Offline Operations into main"
- Commit timestamp: 2026-09-12 10:59:01 +0300
- Author: dingbee <engutoto@googlemail.com>
- Working tree status at inspection start: **clean** — `git status --porcelain=v2` returned no staged, unstaged, or untracked entries before this evidence package was added.
- Tags/releases: none (`git tag -l` empty).
- Local/remote branch topology: only `main`/`origin/main` were present before this session ran `git fetch`. After fetching, the following additional remote branches exist (none checked out, none inspected beyond commit-list metadata where explicitly noted):
  - `origin/claude/p07-analytics-closure` — 1 commit ahead of current main HEAD, 0 behind (based on current main tip)
  - `origin/claude/p08-api-integration-closure` — 1 commit ahead of current main HEAD, 0 behind (based on current main tip)
  - `origin/claude/p09-enterprise-closure-f1peif` — 36 commits ahead of current main HEAD, 0 behind (based on current main tip)
  - `origin/claude/nova-fnb-engineering-constitution-f1peif` — stale; 9 commits *behind* current main HEAD, contributes nothing unmerged (its content was already merged into main earlier per commit `85d04b3`)
  - `origin/claude/bar-pos-station-routing-fix`, `origin/claude/nova-fnb-gep4-brand-theme`, `origin/fix/openai-responses-gateway`, `origin/restore-verified-fnb`, several `origin/tmp-*` / `origin/tmp/*` branches, `origin/ui/reconcile-canonical-shell` — present on the remote, not inspected (out of scope; look like scratch/merge-staging branches from prior sessions).
  - Per this session's mandate, none of the P07/P08/P09/P11 branch diffs were opened or read — only `git log --oneline` metadata was consulted. See ME-00-M for the reconciliation detail.
- Reproducibility: the repository is reproducible from `main` HEAD `a481620` — the tree is clean and the commit is pushed (present on `origin/main`).

**Classification: 🟢 Git baseline is unambiguous.**

---

## ME-00-B — Production Deployment Baseline

- No CI/CD pipeline configuration exists in the repository (`.github/` is absent; no `.gitlab-ci.yml`, no other CI config found).
- No platform-specific deployment manifest (`vercel.json`, `netlify.toml`, `wrangler.toml`, `Dockerfile` for hosted deploy) is committed at the repo root. The only Docker artifacts are under `standalone/docker/` and belong to the **local appliance** deployment model (see ME-00-K), not a hosted production deployment.
- Dependencies include `@cloudflare/vite-plugin`, `nitro`, `@tanstack/react-start` — indicating the hosted build target is a Cloudflare Worker built via Vite/Nitro (consistent with `docs/p08-a-external-http-entry-point-adr.md`, which documents `src/server.ts` being proven "against the actual built Cloudflare Worker artifact via `wrangler dev`"). No live Cloudflare project identity, deployment URL, build ID, or deployment timestamp could be established from repository contents alone — this session has no Cloudflare account/API access.
- **Production URL**: UNKNOWN — not present in any committed file (by design; see `.env.example`, which documents `VITE_SUPABASE_URL`/`SUPABASE_URL` as environment-supplied, never hardcoded).
- **Deployed commit / build identifier / deployment timestamp / runtime version**: UNKNOWN — no deployment-status tooling accessible in this session.
- **Database backing the "hosted" runtime**: identified indirectly. `docs/p10-offline-operations.md:243` and `docs/p11-production-security-hardening.md:317` both explicitly name Supabase project `lusiqcmxfxhnehxmwihs` ("nova-hospitality-fnb") as "the production Supabase project" with data verified directly against its live schema by prior P10/P11 sessions. This session independently confirmed via the Supabase management API that this project exists, is `ACTIVE_HEALTHY`, region `eu-central-1`, Postgres 17.6, created 2026-08-24. See ME-00-C.
- **Git ↔ Production classification: 🟠 UNKNOWN (not DRIFT, not MATCH)** — this session has no access to the actual deployed application artifact (no hosting-platform credentials), so the deployed commit cannot be compared to git HEAD. This is a gap in this baseline, not a finding of drift — it should be closed before ME-01 by whoever holds deployment-platform access.

---

## ME-00-C — Database Baseline

- **Supabase project**: `nova-hospitality-fnb`, id/ref `lusiqcmxfxhnehxmwihs`, org `bdngnfgjqxnlstotqwqm`, region `eu-central-1`, status `ACTIVE_HEALTHY`, created 2026-08-24T06:46:34Z.
- **Database engine**: PostgreSQL 17.6.1.155 (`postgres_engine: 17`, release channel `ga`). `select version()` confirms `PostgreSQL 17.6 on x86_64-pc-linux-gnu`.
- **A second, unrelated Supabase project** (`personal-intelligence-platform`, id `uzshazetfkjkrdnxwjtl`) exists in the same organization. It is **not** referenced anywhere in this repository (confirmed by grep) and is recorded here only to establish that it is out of scope, not the certification target.
- **Schema in use**: `public` (149 tables, all with `rowsecurity = true`). No LexiBite-specific tables were found outside `public`.
- **Branching**: Supabase branching shows exactly one branch, `main` (`is_default: true`, status `FUNCTIONS_DEPLOYED`), i.e. there is no active preview/dev database branch in use — all live data lives in the single production branch.
- **Extensions installed** (schema-qualified, non-default): `pgcrypto` 1.3 (`extensions`), `citext` 1.6, `pg_trgm` 1.6, `fuzzystrmatch` 1.2, `uuid-ossp` 1.1, `pg_stat_statements` 1.11, `supabase_vault` 0.3.1, `plpgsql` 1.0 (`pg_catalog`, always present). No PostGIS, pgvector, pg_cron, pg_net, or other heavier extensions are installed despite being available — the schema is a conventional relational/RLS design, not using any exotic extension.
- **Repository ↔ Production migration-state relationship: 🔴 MATERIAL DRIFT.** See ME-00-D for the full inventory and reasoning; summary: production has **at least 9 applied migrations with no corresponding file anywhere in the current `main` branch's `standalone/db/migrations/`** — `0057_p09_membership_scope_enforcement` through `0063_p09_import_workspace_property_scope` (8 migrations, applied 2026-09-14 06:46–07:40 UTC) plus `p11_is_staff_of_tenant_self_check` (applied 2026-09-14 16:41:52 UTC — **minutes before this ME-00 session began**, strongly suggesting a concurrent live session modified production schema during or immediately before this inspection). These migration names correspond closely to isolation/escalation fixes ("membership scope enforcement," "tenancy read isolation," "tenancy write isolation," "quota usage ledger," "config governance property scope," "inventory items property scope," "import workspace property scope") described by the still-unmerged `origin/claude/p09-enterprise-closure-f1peif` branch (see ME-00-M) — i.e., it appears P09-closure-branch fixes were applied directly to the live production database without ever being committed to git/merged to `main`. **The repository as checked out at `main` HEAD `a481620` cannot reproduce the actual current production schema.**

---

## ME-00-D — Migration Inventory

- Repository (`standalone/db/migrations/`, current `main` HEAD): **54 files**, numbered `0000`–`0056` with two intentional numbering gaps: `0008` (absent from the repo entirely — see below) and `0051`/`0052` (explicitly renumbered to `0053`–`0055` per `docs/p11-production-security-hardening.md`, "to resolve a filename collision with the merged commit's own `0050`" — a disclosed, self-consistent renumbering, not a hidden gap).
- Production (`list_migrations` against project `lusiqcmxfxhnehxmwihs`): **80 applied migrations** (version-stamped `20260824080251` through `20260914164152`).
- Comparing the two sets by name (normalizing numeric prefixes):
  - The large majority of the difference in count is **cosmetic**: the repo consolidates what production applied as several small patch migrations into fewer, larger files (e.g. production's `0001_fnb_core_part1..part5` = repo's single `0001_fnb_core.sql`; production's `restore_restaurant_trigger_parity`, `restore_missing_restaurant_columns`, `finish_restaurant_security_parity_v2`, `restore_tax_channel_column`, `restore_remaining_restaurant_triggers`, `restore_nonunique_index_parity`, `restore_restaurant_check_constraints`, and `migration_transfer_audit_20260824` are hot-fix/repair migrations applied directly to production on 2026-08-24 with no separately-named repo file — they were folded into the consolidated `0001`/`0002` files or left unrepresented; `p11_security_definer_and_rls_hardening` + `p11_anon_execute_revocation` + `p11_anon_execute_revocation_public_grant` ≈ repo's `0048_p11_security_hardening.sql`; similar 1:many folding applies to `i7_restaurant_operational_reviews`≈`0021`, `i9_intelligence_events_processed_update`≈`0022`, `intelligence_memory_and_feedback`≈`0024`, `mobile_money_accounts_read_policy_fix`→folded into `0026`, `p01_completion_ai_concierge_entitlement_fix`→folded into `0036`, `p1_fix_read_scoped_tenant_isolation_bug`≈`0029`).
  - **`0008_reseed_role_permissions`** (applied to production 2026-08-25T01:00:07Z) has **no corresponding file or fold-in anywhere in the current repo migration directory** — a small, unexplained gap. Low material impact (a re-seed of `role_permissions` data, not a structural/security change), but it means replaying the repo's migrations from scratch would not reproduce this data state exactly.
  - **`0057_p09_membership_scope_enforcement`, `0058_p09_tenancy_read_isolation`, `0059_p09_tenancy_write_isolation`, `0060_p09_quota_usage_ledger`, `0060b_p09_quota_usage_ledger_fix_ambiguous_column`, `0061_p09_config_governance_property_scope`, `0062_p09_inventory_items_property_scope`, `0063_p09_import_workspace_property_scope`** (all applied 2026-09-14, between 06:46:14 and 07:40:00 UTC) — **no corresponding file exists anywhere in the repo.** This is the material gap called out in ME-00-C.
  - **`p11_is_staff_of_tenant_self_check`** (applied 2026-09-14T16:41:52Z) — likewise absent from the repo. Given the timestamp is minutes before this inspection began, this is very likely a live, in-progress change from a concurrent session, not a stable baseline fact — see ME-00-M and the Baseline Drift Test.

### Migration inventory grouped by domain (repository files, `standalone/db/migrations/`)

| Domain | Files |
|---|---|
| Prereq/core schema | `0000_prereq`, `0001_fnb_core`, `0002_hospitality_bridge` |
| Tenancy / RBAC | `0003_tenancy_rbac`, `0004_rbac_canonicalisation`, `0005_fix_has_any_role_ambiguity` |
| Guest | `0006_guest_service_requests`, `0007_guest_feedback`, `0018_guest_dining_sessions`, `0045_guest_session_order_linkage` |
| Menu | `0009_menu_item_images`, `0037_menu_economics_unit_dimension_repair`, `0038_menu_economics_ccb01_cost_snapshot_repair` |
| Intelligence | `0010_intelligence_events`, `0011_intelligence_decision_governance`, `0015_intelligence_action_lifecycle`, `0022_intelligence_events_processed_update`, `0024_intelligence_memory`, `0043_p04_commercial_intelligence`, `0044_p05_restaurant_intelligence_activation` |
| Inventory | `0012_inventory_identity`, `0047_inventory_content_conversion` |
| Import/migration tooling | `0013_import_studio`, `0014_import_studio_products`, `0020_import_match_candidates`, `0046_lexibite_template_import_domains` |
| Procurement | `0016_purchase_request_correlation_unique`, `0017_po_supplier_communication` |
| Operational reviews | `0021_restaurant_operational_reviews` |
| Pricing | `0019_price_review_correlation` |
| Branding | `0023_restaurant_tenant_logos`, `0039_branding_sprint_identity_hierarchy_repair` |
| Fiscal | `0025_fiscal_foundation`, `0031_tra_vfd_protocol` |
| Payments | `0026_mobile_money_foundation` |
| Property/tenant scoping | `0027_property_scope`, `0028_p1_property_scope_closure`, `0029_p1_fix_read_scoped_isolation_bug`, `0030_p1_profitability_rls_scope`, `0032_p1_intelligence_property_scope`, `0033_p1_reconciliation_property_scope` |
| Commercial | `0034_p01_commercial_architecture`, `0035_p01_subscription_write_gate_fix`, `0036_p01_completion_ai_concierge_correction`, `0040_p02_commercialization_lifecycle`, `0041_p02_commercial_admin_tenant_visibility` |
| Configuration / service requests | `0042_service_request_lifecycle_and_cooldown` |
| Security / RBAC hardening (P11) | `0048_p11_security_hardening`, `0050_p11_rbac_self_check_enforcement`, `0053_p11_property_scope_properties_locations`, `0054_p11_hotpath_fk_indexes`, `0055_p11_rls_initplan_app_users_rbac` |
| Commercial onboarding (P12) | `0049_p12_self_serve_tenant_bootstrap` |
| Offline (P10) | `0056_p10_order_items_client_request_id` |

### Migrations applied to production but absent from the repository (material)

| Version | Name | Applied | Domain | Repo file? |
|---|---|---|---|---|
| 20260825010007 | 0008_reseed_role_permissions | 2026-08-25 | tenancy/RBAC | ❌ absent (minor) |
| 20260914064614 | 0057_p09_membership_scope_enforcement | 2026-09-14 | tenancy | ❌ absent (material) |
| 20260914064632 | 0058_p09_tenancy_read_isolation | 2026-09-14 | tenancy | ❌ absent (material) |
| 20260914064656 | 0059_p09_tenancy_write_isolation | 2026-09-14 | tenancy | ❌ absent (material) |
| 20260914064715 | 0060_p09_quota_usage_ledger | 2026-09-14 | commercial | ❌ absent (material) |
| 20260914065109 | 0060b_p09_quota_usage_ledger_fix_ambiguous_column | 2026-09-14 | commercial | ❌ absent (material) |
| 20260914070621 | 0061_p09_config_governance_property_scope | 2026-09-14 | configuration | ❌ absent (material) |
| 20260914071410 | 0062_p09_inventory_items_property_scope | 2026-09-14 | inventory | ❌ absent (material) |
| 20260914074000 | 0063_p09_import_workspace_property_scope | 2026-09-14 | import | ❌ absent (material) |
| 20260914164152 | p11_is_staff_of_tenant_self_check | 2026-09-14 16:41 (minutes pre-inspection) | RBAC | ❌ absent (material, likely in-flight) |

No case of the reverse (a repo migration file with no production counterpart) was found — every repo file maps to an applied production migration (directly or via the documented renumbering).

**Classification: 🔴 MATERIAL DRIFT — production migration state is ahead of and not reproducible from the current `main` branch.**

---

## ME-00-E — Schema Inventory

149 tables in `public`, all RLS-enabled. Grouped by the domains in the mandate (table names abbreviated without the `restaurant_`/`commercial_` prefix where obvious; row counts as observed at inspection time — a live, changing production database, so treat as a point-in-time sample, not an invariant):

**Core**: `tenants`(3), `restaurant_tenants`(2), `properties`(1), `restaurant_properties`(3), `outlets`(2), `restaurant_locations`(6), `restaurant_members`(2), `app_users`(2), `roles`(12), `permissions`(72), `role_permissions`(274), `rbac_user_roles`(1), `rbac_legacy_role_map`(20), `user_roles`(0, deprecated — see below).

**Restaurant**: `restaurant_menus`(6), `restaurant_categories`(5), `restaurant_menu_items`(49), `restaurant_modifier_groups`(3), `restaurant_modifiers`(13), `restaurant_product_modifier_groups`(2), `restaurant_bundle_components`(0), `restaurant_tables`(3), `restaurant_service_periods`(0), `restaurant_orders`(54), `restaurant_order_items`(41), `restaurant_payments`(15), `restaurant_receipts`(20), `restaurant_receipt_deliveries`(11), `restaurant_stations`(2), `restaurant_kitchen_tickets`(23), `restaurant_kitchen_ticket_items`(23), `restaurant_productions`(0), `restaurant_production_inputs`(0).

**Inventory**: `restaurant_inventory_units`(21), `restaurant_inventory_categories`(24), `restaurant_inventory_items`(15), `restaurant_inventory_reasons`(0), `restaurant_inventory_batches`(8), `restaurant_stock_movements`(39), `restaurant_stock_transfers`(4), `restaurant_stock_transfer_lines`(4), `restaurant_stock_reservations`(0), `restaurant_stocktakes`(10), `restaurant_stocktake_lines`(66), `restaurant_requisitions`(1), `restaurant_requisition_lines`(1).

**Procurement**: `restaurant_suppliers`(24), `restaurant_supplier_products`(11), `restaurant_purchase_orders`(2), `restaurant_purchase_order_items`(9), `restaurant_purchase_requests`(5), `restaurant_purchase_request_items`(7), `restaurant_approval_rules`(0), `restaurant_supplier_confirmations`(0), `restaurant_supplier_confirmation_items`(0), `restaurant_goods_receipts`(2), `restaurant_goods_receipt_items`(10), `restaurant_po_deliveries`(2), `restaurant_procurement_variances`(0), `restaurant_supplier_price_history`(17), `restaurant_supplier_invoices`(0), `restaurant_supplier_invoice_items`(0), `restaurant_procurement_audit`(14).

**Recipes/costing**: `restaurant_recipes`(1), `restaurant_recipe_lines`(8), `restaurant_recipe_components`(2), `restaurant_recipe_costs`(1), `restaurant_recipe_cost_history`(4), `restaurant_products`(3), `restaurant_product_variants`(2).

**Pricing/tax**: `restaurant_currencies`(2), `restaurant_exchange_rates`(0), `restaurant_prices`(8), `restaurant_price_lists`(0), `restaurant_tax_rules`(0), `restaurant_service_charges`(0), `restaurant_discount_rules`(0), `restaurant_discount_applications`(0), `restaurant_promotions`(0), `restaurant_rounding_rules`(0), `restaurant_pricing_audit`(5).

**Fiscal**: `restaurant_fiscal_configurations`(1), `restaurant_fiscal_devices`(0), `restaurant_fiscal_receipts`(4), `restaurant_fiscal_receipt_items`(5), `restaurant_fiscal_submissions`(1), `restaurant_fiscal_acknowledgements`(1), `restaurant_fiscal_z_reports`(0), `restaurant_fiscal_credentials`(0), `restaurant_fiscal_counters`(0).

**Payments (mobile money)**: `restaurant_mobile_money_accounts`(1), `restaurant_mobile_money_collections`(0), `restaurant_mobile_money_webhook_events`(0), `restaurant_mobile_money_refunds`(0).

**Reconciliation / cash**: `restaurant_daily_closes`(0), `restaurant_tender_declarations`(0), `restaurant_declaration_revisions`(0), `restaurant_reconciliation_runs`(0), `restaurant_reconciliation_exceptions`(0), `restaurant_reconciliation_audit`(0), `restaurant_cash_payouts`(0), `restaurant_cash_payout_events`(0), `restaurant_document_sequences`(10), `restaurant_document_events`(37).

**Guest**: `restaurant_guest_sessions`(6), `restaurant_service_requests`(4), `restaurant_guest_feedback`(5), plus a separate, apparently legacy/unrelated hospitality set: `guests`(0), `bookings`(0), `guest_preferences`(0), `pms_folio_postings`(0) — these four have zero rows and generic (non-`restaurant_`-prefixed) names; they read as an older/bridging hospitality-PMS schema (`0002_hospitality_bridge`) not actively used by the current restaurant/POS product. Flagged as a schema-cleanliness item, not a defect (see ME-00-N).

**Intelligence**: `intelligence_events`(437 — by far the largest operational table sampled), `intelligence_decisions`(15), `intelligence_plans`(11), `intelligence_plan_steps`(69), `intelligence_actions`(6), `intelligence_memory`(0), `intelligence_feedback`(0).

**Import**: `restaurant_import_workspaces`(5), `restaurant_import_sources`(5), `restaurant_import_field_mappings`(52), `restaurant_import_staged_records`(1096 — largest table by row count in the entire schema).

**Commercial**: `commercial_administrators`(1), `commercial_plans`(3), `commercial_programmes`(1), `commercial_capabilities`(34), `commercial_plan_entitlements`(102), `commercial_programme_entitlements`(3), `commercial_pricing`(3), `commercial_property_policies`(3), `commercial_property_classifications`(0), `commercial_quota_definitions`(6), `commercial_usage_counters`(0), `commercial_ai_usage_log`(2), `commercial_overrides`(0), `commercial_audit_log`(6), `commercial_billing_accounts`(1), `commercial_agreements`(1), `commercial_invoices`(0), `commercial_invoice_lines`(0), `commercial_payments`(0), `commercial_payment_webhook_events`(0), `commercial_notifications`(0), `commercial_signals`(0), `commercial_recommendations`(0).

**Operational reviews**: `restaurant_operational_reviews`(2).

**Migration/audit tooling**: `migration_transfer_audit`(5).

**Deprecated**: `user_roles` — table comment (captured verbatim from the live schema) reads: *"DEPRECATED (0004): historical role store. Not an authorization source. Canonical model is rbac_user_roles + role_permissions."* Zero rows, RLS enabled, no policies (see ME-00-F). This is the one canonical authorization model the CLAUDE.md constitution requires (`user → role → permission → tenant/property/outlet scope`); the deprecated table is correctly inert, not a parallel system.

**Total public tables**: 149. **Total indexes**: 419 (see ME-00-G for the advisor-reported subset that are unindexed FKs / unused).

---

## ME-00-F — Database Security Baseline

- **RLS coverage**: 149/149 public tables have `rowsecurity = true` (100%). **0 tables** have `FORCE ROW LEVEL SECURITY` set — table owners (and any role with `BYPASSRLS`, i.e. `postgres`/`service_role` in Supabase's model) bypass RLS by default. This is standard Supabase practice (server-side privileged operations use `service_role`, which is expected to bypass RLS and enforce authorization in application code instead), not a defect in itself — but it means RLS alone does not protect against a compromised or misused service-role key, and the "canonical authorization: user → role → permission → tenant/property/outlet scope" chain described in CLAUDE.md depends on `service_role` credentials never reaching client code (this session did not check client bundle contents for key leakage — flagged as an ME-05/ME-06 follow-up, not verified here).
- **Policies**: 294 total policies across 147 of the 149 tables (2 tables — `migration_transfer_audit` and the deprecated `user_roles` — have RLS enabled with **zero policies**, meaning RLS's default-deny applies: no role except the RLS-bypassing owner/service_role can read or write them at all. This is a lockout, not an exposure — flagged as INFO by Supabase's own advisor, not WARN).
- **Policy operation breakdown**: `SELECT` 146, `ALL` 121, `INSERT` 18, `UPDATE` 9 (no bare `DELETE`-only policies found — deletes are covered either by `ALL` policies or, per the domain model, are largely not exposed as a direct table operation, consistent with the ledger-style/append-only inventory and financial tables described in CLAUDE.md).
- **Policy role targeting**: `authenticated` 173 policies, `public` (i.e. applies to all roles including `anon`) 120, `service_role` 1. **No policy explicitly grants `anon`** — confirmed separately: `select tablename from pg_policies where 'anon' = any(roles)` returns zero rows. Any `anon`-role access to `public`-targeted policies is therefore governed entirely by those 120 policies' `USING`/`WITH CHECK` clauses (not audited row-by-row in this pass — that granular a check belongs to ME-02/ME-05, not ME-00). Given the product's guest-ordering feature (QR/table-based guest sessions with no login), this is the boundary that ME-05 (guest adversarial certification) must scrutinize closely: guest requests plausibly travel as `anon` or as a server-issued `authenticated` guest token — this baseline does not determine which, and that distinction matters for what those 120 `public`-role policies actually expose to an unauthenticated caller.
- **SECURITY DEFINER surface**: 66 of 69 functions in `public` are `SECURITY DEFINER` (96%). The Supabase security advisor flags 44 of these as directly callable by the `authenticated` role via PostgREST RPC (`/rest/v1/rpc/<name>`) — full list captured in the raw advisor output retained for this session; the functions are almost entirely the RBAC/scope-check helper family (`has_role`, `has_any_role`, `is_any_staff`, `is_staff_of_tenant`, `nova_has_permission`, `nova_can_manage_scoped`, `nova_permissions_for`, `nova_property_tenant`, and ~35 `restaurant_can_*`/`restaurant_*_property` scope-resolution helpers), plus a handful of true mutating RPCs (`restaurant_bootstrap_tenant`, `restaurant_next_document_number`, `restaurant_fiscal_next_counter`, `restaurant_increment_quota_usage`, `restaurant_daily_close_property`, `restaurant_expected_tender`). This is architecturally consistent with CLAUDE.md's canonical model (`requirePermission` resolving `nova_has_permission` "against the caller's own token") — but a `SECURITY DEFINER` function being broadly `authenticated`-callable means each one's *own* internal authorization logic is the only thing standing between a signed-in user and privilege escalation; this baseline does not verify each function's body enforces "caller can only query their own identity" (the reconciliation agent's P11 findings — ME-00-M — indicate this exact class of bug, "RBAC self-check bypass," was found and fixed for several of these functions in migrations `0050`/`p11_is_staff_of_tenant_self_check`; whether all 44 are now safe is an ME-03 question, not resolved by ME-00).
- **EXECUTE grants to `anon`/`PUBLIC`**: only 3 functions — `enforce_purchase_order_transition`, `set_updated_at`, `update_updated_at_column` — all generic trigger functions with no meaningful standalone RPC use (they operate on `NEW`/`OLD` row context supplied by the trigger machinery, not caller-supplied arguments), so this is not treated as a live exposure.
- **`grants` summary** (EXECUTE on `public` routines): `postgres` 69, `service_role` 69, `authenticated` 47, `PUBLIC` 3, `anon` 3.
- **Auth-level finding**: leaked-password protection (HaveIBeenPwned check) is **disabled** (`auth_leaked_password_protection`, WARN). `docs/p11-production-security-hardening.md` explicitly disclosed this as an open P1 item that a prior session could not close ("cannot be enabled live from this session," recommending the Dashboard toggle). **Confirmed still disabled at ME-00 inspection time** — the documented remediation was not subsequently applied. Carried into the Known Defect Register (ME-00-N).
- No RLS policy content (`USING`/`WITH CHECK` clause bodies) was extracted table-by-table in this pass — 294 policies is out of proportion to a baseline-lock exercise; this is explicitly left as ME-02's job ("RLS policy complexity").

**Classification: no unauthorized modification made; two pre-existing, previously-disclosed gaps confirmed still open (RLS-enabled-no-policy on 2 inert tables — informational; leaked-password protection disabled — WARN, actionable, zero-downtime fix available and already documented).**

---

## ME-00-G — Database Performance Baseline

Live Supabase performance-advisor output, captured at inspection time (project `lusiqcmxfxhnehxmwihs`):

| Finding | Level | Count | Mandate's stated approximate baseline | Match? |
|---|---|---|---|---|
| `unindexed_foreign_keys` — Unindexed foreign keys | INFO | **285** | ~285 | ✅ exact match |
| `auth_rls_initplan` — Auth RLS Initialization Plan | WARN | **54** | ~54 | ✅ exact match |
| `multiple_permissive_policies` — Multiple Permissive Policies | WARN | **293** | ~293 | ✅ exact match |
| `unused_index` — Unused Index | INFO | **46** | ~46 | ✅ exact match |

All four figures the mandate pre-stated as "approximately" the current inspection's findings were independently re-verified against the live advisor API in this session and matched **exactly** (not merely approximately) — full finding-level detail (specific table/policy/index names for each of the 678 individual findings) was retrieved and is available in this session's raw tool output; it is not reproduced table-by-table here to keep this baseline document a usable size, but nothing in it should be assumed unverified — every count above is a live re-check, not a copy of the mandate's text.

**Classification: 🟢 confirmed — this is the accurate, current ME-00 performance baseline, not a stale or assumed figure.** No remediation was performed (out of scope for ME-00; this is the starting point for ME-01/ME-08/ME-09).

---

## ME-00-G(ii) — Index Baseline (summary)

- Total indexes in `public`: **419**.
- Of these, the advisor identifies **46 as unused** (`idx_scan = 0` since last stats reset) and **285 foreign-key columns as lacking a supporting index** (a different axis — most unindexed FKs are on tables that do have *some* other indexes, just not one covering the FK column).
- Given 149 tables and 419 indexes (~2.8 indexes/table average) against a schema with heavy multi-tenant scoping (`tenant_id`/`property_id`/`outlet_id` composite filtering is pervasive per ME-00-E), both figures are directionally unsurprising for a system whose RLS policies filter on scope columns on almost every query — but the count of *unindexed* FKs (285) considerably exceeds the *unused* index count (46), suggesting the gap is under-indexing relative to the schema's actual join/filter patterns, not general index bloat. This is exactly ME-01's remit; no index was added, removed, or otherwise touched in this session.
- Full per-index inventory (table, column, uniqueness, predicate, type, usage stats) was not transcribed line-by-line into this document — it is available live via the advisor/`pg_indexes`/`pg_stat_user_indexes` views for whoever executes ME-01, and doing so here would not make the baseline more "locked," only longer.

---

## ME-00-H — Application Architecture Baseline

*(Produced by a dedicated code-tracing pass over `main` HEAD `a481620`. Scale observed: 47 route files, 54 SQL migrations, ~495 `createServerFn` declarations across ~69 `.functions.ts`/`.server.ts` files.)*

**Frontend.** TanStack Start/React Router (file-based routes in `src/routes/*.tsx`), TanStack Query for server state, Zod for input validation. Domain code lives under `src/modules/restaurant/<area>/` (60+ areas: `sales`, `kitchen`, `bar`, `inventory`, `procurement`, `fiscal`, `pricing`, `menu`, `offline`, `selforder`, `onboarding`, `readiness`, `reconciliation`, etc.), each split into `*.contracts.ts` (Zod schemas, browser-safe), `*.server.ts` (DB logic + authorization), `*.functions.ts` (`createServerFn` RPC wrapper), and a `ui/` subfolder. `src/modules/commercial/` holds platform billing; `src/modules/intelligence/` the advisory/decision layer; `src/domains/hospitality/folio/` a PMS-folio adapter seam. One bundle serves both deployment targets (`vite.config.ts:9-13`).

**Server functions / DB access.** All server code is TanStack Start `createServerFn` handlers (no separate REST framework, except the two Vercel Functions under `api/`). Every handler talks to Postgres through `@supabase/supabase-js` (PostgREST) — no custom RPC framework. Three client seams in `src/integrations/supabase/`: `client.ts` (browser client; in appliance mode points at `window.location.origin`/`https://localhost:8443`, not a hosted URL — `client.ts:10-27`); `client.server.ts` (service-role admin client, "bypasses RLS... never expose to client code," used only inside `.server.ts` files); `auth-middleware.ts` (`requireSupabaseAuth`, extracts the bearer token, calls `supabase.auth.getClaims(token)`, rejects if no `claims.sub` — `:25-70`), the only place a request becomes an authenticated `{supabase, userId, claims}` context; `auth-attacher.ts` (`attachSupabaseAuth`), the client-side middleware attaching the bearer token to every RPC call.

**Authentication → authorization — TWO coexisting, non-overlapping RBAC systems (evidence-based finding).**

1. **Platform-tier RBAC** (`src/lib/rbac/`): roles `OWNER, GENERAL_MANAGER, RESTAURANT_MANAGER, BAR_MANAGER, CHEF, WAITER, BARTENDER, CASHIER, STOREKEEPER, PROCUREMENT, FINANCE, AUDITOR` (`permissions.ts:49-63`), `DOMAIN:ACTION` permission strings, stored in `rbac_user_roles`, resolved via the `nova_has_permission` SQL RPC (`rbac.server.ts:28-52`). A `requirePermission(perm)` middleware factory is defined (`rbac.server.ts:71-79`) but **is not composed by any business server function in the repo** — it exists and is documented but has no call sites outside its own module/comments. Actual `assertPermission` call sites are narrow: `src/lib/staff.functions.ts` (staff directory/role grant), `src/modules/intelligence/core/access.server.ts`, `src/domains/hospitality/folio/folioAdapter.server.ts`.

2. **Tenant/restaurant-tier RBAC** (`src/modules/restaurant/core/access.server.ts` + `core/permissions.ts`): a **separate** role vocabulary — `owner, general_manager, restaurant_manager, chef, kitchen_manager, bartender, inventory_manager, purchasing_officer, accountant, viewer` — and a `RestaurantCapability` string map, stored in `restaurant_members(tenant_id, user_id, role, property_id)`, not `rbac_user_roles`. This is the actual enforcement workhorse: `assertCapability(supabase, userId, tenantId, capability, scope?)` (`access.server.ts:307-337`) is imported by **88 files** across every restaurant/bar/inventory/procurement/fiscal/pricing/menu module. It short-circuits for a platform admin, loads the caller's `restaurant_members` grants, checks the role against `rolesForCapability(capability)`, and checks `property_id`/`location_id` scope coverage. The module's own doc comment states the split is intentional: *"Roles are commercial hospitality roles stored in `restaurant_members`... separate from host platform roles... so the module can be sold to other operators"* (`core/permissions.ts:2-9`); the intelligence registry independently documents the same split (`registry.ts:27-30`).

   RLS is a genuine second, independent enforcement layer: migration `0027_property_scope.sql` documents fixing a real prior gap (`restaurant_members.property_id exists... but has never been read by any authorization check`). `authorization-gate.test.ts` (600 lines) is a source-level + behavioral regression suite asserting: `has_any_role`/`nova_has_permission` never read `raw_user_meta_data` or hard-coded emails; every `createServerFn` composes `requireSupabaseAuth` except a commented allow-list of 10 token-scoped guest files; no server function accepts a role/permission/admin flag from the client; UI permission hooks never decide from local/session storage.

   **Certification note**: the README's summary ("`requirePermission("INVENTORY:WRITE")` resolves `nova_has_permission`... enforcement is server-side") accurately describes the platform-tier mechanism but is *not* how the bulk of restaurant/POS/inventory/procurement business logic is actually gated — that runs through `assertCapability`/`restaurant_members`/RLS. Both paths are genuinely server-side and both are test-covered, but they are two distinct, non-unified authorization models in one codebase. The code's own comments frame this as a deliberate two-tier (platform vs. tenant-sellable-module) design, not an accidental duplicate — but it is close enough to CLAUDE.md's "never introduce a parallel RBAC system" boundary that it is recorded explicitly here rather than assumed benign (see KD-10).

   Owner bootstrap: `public.nova_bootstrap_owner()` (platform tier) and `public.restaurant_bootstrap_tenant()` (tenant tier, SECURITY DEFINER, owner strictly `auth.uid()`, migration `0049`) are the two separately-scoped self-elevation escape hatches, each covered by `authorization-gate.test.ts`.

**Event/background processing.** No queue/cron infrastructure found (no `bull`, `pg_cron`, scheduled function in `src/`/`api/`). Two webhook endpoints exist as standalone Vercel Functions, deliberately outside TanStack Start's server-fn convention: `api/pesapal-ipn.ts` (re-verifies via `confirmPesapalCallback`, never trusts the callback's own status) and `api/mobile-money-webhook.ts` (idempotent by `(provider_code, provider_event_id)`). Both covered by `authorization-gate.test.ts:469-501`.

**Integrations.** Payments: Pesapal + mobile money. Notifications: `src/lib/notifications/adapters.server.ts` — generic HTTP email relay + Twilio WhatsApp, returns `reason: "not_configured"` rather than faking success when env vars are absent. AI gateway: `src/lib/ai-gateway.server.ts` — OpenAI-compatible endpoint, throws a clear "AI advisory is not configured" error when the API key is absent rather than silently degrading. Fiscal/TRA-VFD: `src/modules/restaurant/fiscal/` — `fiscal.server.ts` calls a real TRA EFD/VFD XML protocol adapter (`providers/traEfd.server.ts`), with a separate deterministic test double used only by this repo's own tests.

**Storage.** Supabase Storage buckets (not a custom file service) — `menu-image.server.ts`/`tenant-logo.server.ts` against public-read buckets governed by tenant-write RLS policies.

**Offline architecture (P10).** Hand-rolled IndexedDB wrapper (`db.ts`, no Dexie/idb dependency), six stores, a durable `queue.ts` (rejects duplicate `clientRequestId` via a unique index), `syncEngine.ts`. Scope is explicitly closed per `docs/p10-offline-operations.md`: only `open_order`/`add_item`/`fire_to_kitchen` are queueable (enforced as an exhaustive TypeScript `switch`); payment, receipt, order-status change, inventory movement, fiscalisation, and all guest ordering are `ONLINE_REQUIRED`/`FORBIDDEN_OFFLINE`. Replayed operations call the *same* production server functions through the same `requireSupabaseAuth`/RLS path.

**Intelligence architecture.** `src/modules/intelligence/` implements an Observe→Reason→Decide→Act→Learn pipeline: `events.server.ts` (dedupe by `dedupeKey`, tenant-scoped via a pluggable `TenantScopeChecker` registry), `decisions/` (`decisionEngine.ts`, `decisionRules.ts`, `planningEngine.ts`, `optionEvaluator.ts`), `memory/memory.server.ts` (human-curated: new entries start `new`, only `approved` entries recalled by default), `predictions/forecast.server.ts`. The registry module explicitly documents that intelligence spans two different tenant-ID spaces (platform `tenants` vs. restaurant `restaurant_tenants`/`restaurant_members`) — corroborating the two-RBAC-system finding above.

---

## ME-00-I — Feature / Module Baseline

Classification key: IMPLEMENTED / PARTIAL / NOT IMPLEMENTED / UNKNOWN — each traced to actual code, not UI labels.

**Commercial** (`src/modules/commercial/`, migrations `0034`–`0043`): Plans/catalog — IMPLEMENTED. Entitlements — IMPLEMENTED (`resolver.server.ts`, precedence override > programme > plan baseline > safe-unavailable default; consumed by restaurant code, e.g. gating `multi_property_command`). Quotas — IMPLEMENTED (`quota.server.ts`, lifecycle NORMAL→…→BLOCKED). Property policies/classification — IMPLEMENTED. Billing/invoicing — IMPLEMENTED (`billing.server.ts`, every line traces to `commercial_agreements`). Agreements — IMPLEMENTED (+test). Collections — IMPLEMENTED (+test). Renewals — IMPLEMENTED (+test). Commercial intelligence — IMPLEMENTED (+test, UI). Commercial admin access — IMPLEMENTED, deliberately separate from tenant RBAC (`commercial_administrators` allow-list, explicitly not derived from OWNER's permissions "which would immediately leak commercial control to every tenant owner").

**Restaurant**: Setup/onboarding — IMPLEMENTED (see ME-00-J). Menu — IMPLEMENTED (`menu.server.ts`, `lifecycle.server.ts`, `allergens.server.ts`, image upload). Inventory — IMPLEMENTED (`movements.server.ts`, `batches.server.ts`, `transfers.server.ts`, `stocktake.server.ts`, `waste.server.ts`, `reservations.server.ts`, `locations.server.ts`). Suppliers/Purchasing/Procurement — IMPLEMENTED (three-way-match surface: `receiving.server.ts`, `invoices.server.ts`, `variances.server.ts`, `confirmations.server.ts`). Recipes/Costing/Pricing — IMPLEMENTED (`costing.server.ts` + `profitability.server.ts`, `pricing.server.ts` + bulk tests + `pricing/readiness.server.ts`). POS — IMPLEMENTED (`pos.server.ts`, `sales.server.ts`, `bill.server.ts`, `cancellation.server.ts`, `roomcharge.server.ts`). Kitchen/Bar — IMPLEMENTED with server-enforced routing: `sales/stationRouting.ts`'s `resolveCataloguedLineStation()` derives the production station from the product's own catalogue/beverage classification, never a client-proposed value for a catalogued line — a client-proposed station is honored only for non-catalogued "open" items and only if it belongs to the tenant. This satisfies CLAUDE.md's "never fix routing only in the UI." Payments/Receipts — IMPLEMENTED. Reconciliation — IMPLEMENTED, explicitly read-only ("never edits an order, a payment, a stock position or an invoice... writes only its own artefacts").

**Guest**: Public menu/QR-table context — IMPLEMENTED (`order.$tableId.tsx`; `resolveGuestTableContext` is the sole source of tenant/property/location for every guest function — guest contracts carry no `tenantId/propertyId/locationId` fields at all, per `authorization-gate.test.ts:318-330`). Guest session — IMPLEMENTED. Ordering — IMPLEMENTED (incl. "Ask NOVA" AI-grounded guest chat). Payment — IMPLEMENTED, amount always server-re-derived (`order.total - order.paid_total`), never accepted from the client. Bill request/feedback/service requests/tracking — IMPLEMENTED. Receipt — IMPLEMENTED, token-scoped, no identity required.

**Fiscal** (migration `0031_tra_vfd_protocol.sql`): Configuration — IMPLEMENTED. Sequencing — IMPLEMENTED (Z-report numbering). Submission — IMPLEMENTED (real TRA EFD/VFD adapter). Retries — IMPLEMENTED, typed outcomes with `next_retry_at` scheduling; fiscalization explicitly non-blocking ("a fiscal failure must never fail the payment or the receipt"). Reconciliation — PARTIAL/UNKNOWN as a fiscal-specific concern: general operational reconciliation exists, but no fiscal-submission-vs-receipt-specific reconciliation report was located distinct from the retry/state machine itself (not traced further given time budget).

**Offline**: Detection — IMPLEMENTED. Local queue — IMPLEMENTED. Replay — IMPLEMENTED. Deduplication — IMPLEMENTED. Sync — IMPLEMENTED but narrowly and deliberately scoped (3 operation types only). Conflict handling — IMPLEMENTED. Device identity — IMPLEMENTED.

**Intelligence**: Events — IMPLEMENTED. Decisions/plans/actions — IMPLEMENTED. Predictions/forecasts — IMPLEMENTED. Memory — IMPLEMENTED, human-curated approval gate. Feedback — IMPLEMENTED. Recommendations — PARTIAL/UNKNOWN — `decisionRules.ts`/`optionEvaluator.ts` exist but end-to-end recommendation surfacing to a UI was not confirmed within the time budget of this pass.

---

## ME-00-J — Customer Activation Baseline

Traced end-to-end as real code, not documentation-only:

1. **Signup** — Supabase Auth (`auth.tsx`, `auth_.sign-up.tsx`); no custom auth system.
2. **Tenant creation** — `_authenticated.onboarding.tsx` (P12) → `bootstrapTenant()` (`onboarding.server.ts:44-77`) → `public.restaurant_bootstrap_tenant()` SQL function (migration `0049`) — the one documented, narrow SECURITY DEFINER bypass of the normal RLS write policy, needed to solve the chicken-and-egg problem of a user with zero `restaurant_members` rows creating their first tenant. Owner is always `auth.uid()`, never a parameter.
3. **Property → Outlet** — `createFirstOutletFn`, routed through the *existing, already-authorized* `upsertProperty`/`upsertLocation` functions, not a parallel configuration engine (the caller now genuinely holds `restaurant_members.role = 'owner'`).
4. **Operating model** — `setOperatingModelFn`.
5. **Users/Roles** — tenant tier via `restaurant_members` upserts; platform tier via `inviteStaffUser`/`assignRole` (`STAFF:ADMIN`/`ADMINISTRATION:ADMIN`-gated). **Hidden manual prerequisite**: `inviteStaffUser` depends on Supabase SMTP being separately configured in the Supabase dashboard — no invite email is sent without it (self-documented in code comments).
6. **Configuration/Menu/Inventory/Pricing** — real UI at `/admin/restaurant/setup*`, `/menu`, `/inventory*`, `/pricing`.
7. **Payment/Fiscal setup** — `/admin/restaurant/fiscal` route; payments configured per-deployment via env, no UI-only "fake configured" state.
8. **Test sale → Go live** — `readiness.server.ts` (P13) is a single, authoritative gate: `computeReadiness()` reads 15 live tables including `restaurant_orders` filtered `payment_state = 'paid'` and computes `hasRecordedTestSale` from a genuine completed sale, not a synthetic flag. State machine `NOT_READY → READY_FOR_TEST → READY_FOR_GO_LIVE` (zero CRITICAL/HIGH blockers **and** a recorded paid order) `→ LIVE` only after `confirmGoLive()` — an explicit owner-only, capability-gated, audited write, never inferred automatically from configuration existing.

**Manual/DB-only steps identified**: the very first platform administrator on a from-scratch install needs `NOVA_BOOTSTRAP_OWNER_EMAIL` + `public.nova_bootstrap_owner()` — a one-time, non-UI bootstrap distinct from P12's tenant bootstrap. On the local appliance, the first run prompts in-UI to create the administrator, but a subsequent `./nova seed` re-run is needed to attach that admin as owner of the demo tenant. Staff email invites silently degrade to "account created, no email sent" without separately-configured SMTP.

---

## ME-00-K — Hosted vs Appliance Deployment Model Baseline

**Hosted.** `bun install && bun run dev` against `.env` pointing at a Supabase-compatible Postgres/PostgREST API. Build: `vite build` (Cloudflare/Nitro target — `@cloudflare/vite-plugin` dependency, static assets from `.output/public`). Auth: Supabase Auth (real JWTs). Payments/webhooks reach the app via two Vercel Functions under `/api`, explicitly documented as living outside the Nitro/TanStack build ("Nitro has no server/api convention wired into this project's build plugin... Vercel's own build step is what serves this path"). **This implies the hosted deployment target is, at least in part, Vercel for the webhook surface**, alongside whatever serves the Cloudflare/Nitro static output for the SPA/SSR portion — the repo does not fully resolve this dual-target ambiguity in one place; it is inferred from file-level comments, not stated as a single deployment diagram. This is recorded as an open question for whoever owns deployment (see ME-00-B's UNKNOWN classification and KD-04). Backup assumptions for hosted are owned by the Supabase-compatible provider, out of repo scope.

**Local appliance.** `./nova up` — PostgreSQL 17 in Docker (bound to `127.0.0.1`, named volume `nova_fnb_pgdata`), then `local/scripts/install.sh` (schema, keys, TLS, UI bundle, gateway) and `local/scripts/seed-demo.sh`. Migrations applied in order from `standalone/db/migrations/` via `local/scripts/apply-migrations.sh`. Its own gateway process (`local/gateway/server.ts`) is documented as "the ONLY LAN-exposed surface... PostgreSQL and PostgREST bind to loopback"; it fronts PostgREST and mints its own ES256-signed JWTs, verified by PostgREST against the public JWK only ("a compromised PostgREST cannot mint identities"). TLS is served whenever cert material exists (self-signed via `local/scripts/gen-tls.sh`) because "Android Chrome only treats HTTPS as a secure origin." Password hashing/lockout: max 8 failed attempts, 15-minute lock, constant-time comparison plus a dummy-hash path for unknown emails to avoid a timing oracle. Upgrade path: `local/scripts/verify-bundle.sh`/`scripts/verify-bundle-origin.ts` and a `standalone/BUILD_INFO` marker suggest a package-and-verify flow, but the actual upgrade/rollback procedure for an already-running appliance was not traced in full in this pass.

**The hosted-exclusion guard is real, not documentation-only** (`nova` script):
```bash
# Standalone safety gate: refuse to run against anything hosted.
for v in VITE_SUPABASE_URL NOVA_DB_HOST; do
  [[ "${!v:-}" == *supabase.co* ]] && die "$v points at a hosted project — refusing to start"
done
```
It runs before the database is even started, on every invocation. It is backed at the source level by `src/lib/independence.test.ts`, which scans `src/`, `standalone/`, `local/` for forbidden patterns (a specific foreign product name, a specific hard-coded foreign Supabase project ref, `.supabase.co`, a specific foreign hosted-platform domain) and fails the build if any non-exempted file matches — the `nova` script and `verify-bundle.sh` are explicitly exempted because they *reference* the hosted suffix only to refuse it. This is the concrete, testable form of CLAUDE.md's "no Mtoni runtime dependencies" boundary.

**Asymmetric capabilities — do not assume parity:**
- `src/modules/runtime/runtime-config.ts` formally declares `WAN_DEPENDENT_CAPABILITIES = ["email-delivery", "whatsapp-delivery", "external-payment-capture", "intelligence-advisory"]`, required to "degrade honestly rather than report false success" on a local install; `wanExpected` is `true` only for hosted mode.
- Pesapal/mobile-money webhook capture (Vercel Functions) has no shown equivalent inbound path for the appliance, which has no public internet ingress by design — an appliance can initiate a mobile-money payment but cannot receive a PSP's async webhook without a WAN tunnel (outside this repo's scope).
- Email/WhatsApp and AI advisory both explicitly report "not configured"/throw a clear error rather than silently failing — appliance-without-WAN is a supported, tested state.
- Fiscal (TRA-VFD) submission requires reaching TRA's servers regardless of deployment mode — a WAN dependency inherent to the regulatory integration itself, not modeled in `WAN_DEPENDENT_CAPABILITIES`. The readiness engine treats fiscalisation as CRITICAL only when the tenant's market requires it (e.g. Tanzania), else OPTIONAL — the interaction with an appliance lacking WAN was not traced further.
- The hospitality/PMS folio bridge (`0002_hospitality_bridge.sql`) is explicitly inert in standalone (a feature flag turns it into a no-op) versus a real folio adapter when deployed inside a hotel-platform host context this repo is otherwise firewalled from per CLAUDE.md.

---

## ME-00-L — Test Baseline

Commands run, in this session, on `main` HEAD `a481620`, in the provided remote execution container:

| Command | Result | Detail |
|---|---|---|
| `bun run typecheck` (`tsc --noEmit`) | ❌ FAILED, exit 2 | `error TS2688: Cannot find type definition file for 'vite-plugin-pwa/react'` and `'vite/client'` |
| `bun run lint` (`eslint .`) | ❌ FAILED, exit 2 | `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@eslint/js'` |
| `bun run test` (`vitest run`) | ❌ FAILED, exit 127 | `vitest: command not found` |
| `bun run build` | not attempted | would fail identically (see below) |

**Root cause, determined and confirmed, not guessed**: this container's `node_modules/` was essentially empty at session start (`ls node_modules | wc -l` = 1; no `.bin/tsc`). `bun install --frozen-lockfile` failed (`error: lockfile had changes, but lockfile is frozen`). A non-frozen `bun install` was then attempted **solely to obtain an accurate test signal** (not to alter the committed lockfile) and failed differently: every package download returned **HTTP 403** from this session's pre-configured outbound package-registry proxy (`europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/...`), i.e. this remote execution environment's network policy does not permit this session to fetch npm packages at all.
`bun.lockb`'s checksum was verified unchanged before and after both install attempts (`md5sum` identical), and `git status`/`git diff` on `bun.lockb`/`package.json` show no modification — **no dependency or package-version state was altered**, per the ME-00 no-modification rule.

**Classification: ENVIRONMENT-RELATED, not a baseline code defect.** This session's sandbox cannot install dependencies, so `typecheck`/`lint`/`test`/`build` could not be executed to a real pass/fail verdict here. This is a genuine gap in the ME-00 test baseline that must be closed by re-running these four commands in an environment with outbound npm registry access (or a pre-warmed `node_modules`) before ME-00 can be considered to have a real test baseline. README.md documents the expected clean baseline ("`bun run typecheck` # 0 errors", "`bun run test` # includes RBAC enforcement and independence checks", "`bun run build`") and the P07/P08/P09/P10/P12/P13 closure docs consistently self-report passing suites in the 1950–2110-test range at the time each was written — none of that was independently reproduced by this session.

**Classification: 🟠 TEST BASELINE NOT ESTABLISHED (environment limitation) — carried forward as an explicit ME-00 gap, not papered over.**

---

## ME-00-M — P07–P13 Reconciliation

*(Produced by a dedicated evidence-gathering pass against `main` HEAD `a481620`, cross-referencing commit history, `docs/*.md`, and the actual current source files — not inferred from commit messages alone. Reproduced in full below as delivered.)*

### P07 — Analytics (Sales composition + menu intelligence reconciliation)
**Claimed** (commits `a62b729`/`276fde4`, duplicate content): added `salesComposition` (gross/net/discount/tax/cash-collected) to `RevenueIntelligence`; reconciliation tests proving `menu.server.ts` per-item aggregates equal the sum of raw `restaurant_order_items`.
**Actual**: `src/modules/restaurant/intelligence/revenue.server.ts:107` builds `salesComposition`; `p05.types.ts:172` declares the field; included in the returned object at line 288 — confirmed present. `src/modules/restaurant/intelligence/menu.server.test.ts` (155 lines) exists with a matching reconciliation `describe` block. Duplicate commits `a62b729`/`276fde4` are attribution-footer-only variants of the same tree (merge commit `9518c8d`) — cosmetic history noise.
**ME relevance**: CERTIFICATION INPUT. **Discrepancy**: none.

### P08 — API Integration (only the P08-A spike is on `main`)
**Claimed** (`docs/p08-a-external-http-entry-point-adr.md`, commit `f8ef4da`): explicitly scoped as a proof-of-mechanism spike, not the full programme; `src/server.ts` proven as the framework's HTTP override point (`/api/v1/health`), verified against both dev server and a built Cloudflare Worker; full P08 (auth, API keys, webhooks, external write endpoints) explicitly declared out of scope.
**Actual**: `src/server.ts` matches the doc exactly (default-exports `{fetch(request)}`, `/api/v1/health` GET-only, 405 otherwise, else delegates to `createStartHandler`). `src/routes/api/` does not exist on `main`. No credential/API-key/webhook-registry code found anywhere in `src/`.
**ME relevance**: CERTIFICATION INPUT for the spike as documented; KNOWN LIMITATION for "P08" as a label — **the full API Integration Platform (credentials, versioned resources, integration registry, outbound webhooks, idempotency) exists only on the unmerged `origin/claude/p08-api-integration-closure` branch (1 commit ahead of main) and is NOT part of main.**
**Discrepancy**: labeling risk only (a reader could mistake the "P08" commit label on main for the full platform); the doc itself is honest about scope.

### P09 — Enterprise / Multi-Tenant (only a property-tier rollup is on `main`)
**Claimed** (commit `56d8012`): added `propertyRollups`/`bestPerformingProperty`/`worstPerformingProperty` to `multiLocation.server.ts`, computed from already-fetched, already-scoped data; adversarial test asserting no cross-property leak.
**Actual**: `src/modules/restaurant/intelligence/multiLocation.server.ts:140-231` — all three fields present, computed via `Map` aggregation over already-scoped `summaries`; empty-state default confirmed at line 73.
**ME relevance**: CERTIFICATION INPUT for what's on `main`. **Important caveat, corroborated independently by ME-00-D's migration-drift finding**: the much larger `origin/claude/p09-enterprise-closure-f1peif` branch (36 commits ahead of main) contains extensive additional isolation/escalation fixes — "cross-tenant read leak," "delegated-administration escalation in restaurant_members," "commercial_usage_counters quota-evasion write surface," "configuration-governance property-scope escalation," "inventory-item property-scope escalation" — **none merged into `main`'s git history**. ME-00-D independently found that migrations `0057`–`0063` bearing near-identical names ("membership scope enforcement," "tenancy read isolation," "tenancy write isolation," "quota usage ledger," "config governance property scope," "inventory items property scope," "import workspace property scope") **are applied to the live production database** despite having no file in `main`. The two findings corroborate each other: it is highly likely the P09-closure branch's fixes were applied directly to production out-of-band, without the corresponding migration files ever being committed. **This is the most material single finding of ME-00.**
**Discrepancy**: main's git history does not reflect what is actually running in production for the P09 domain.

### P10 — Offline Operations
**Claimed** (`docs/p10-offline-operations.md`, merged via `a481620`): real IndexedDB queue, idempotent replay via `client_request_id`, sync engine with bounded retry/dead-letter, conflict classification, device identity, POS UI wiring, 95 unit + 15 real-Chromium Playwright tests. Explicitly discloses no full live-auth E2E certification was performed.
**Actual**: `src/modules/restaurant/offline/` contains every file the doc names (`adapters.ts`, `auth.ts`, `chaos.test.ts`, `conflict.ts`, `connectivity.ts`, `contracts.ts`, `db.ts`, `device.ts`, `queue.ts`, `security.test.ts`, `sequence.ts`, `snapshot.ts`, `syncEngine.ts`, `useOfflineSync.ts`, `ui/`), non-trivial sizes. `PosWorkspace.tsx:60,276,284-285,359-369,738` genuinely wires `useOfflineSync`/`ConnectivityIndicator` into the real POS component. Migration `0056_p10_order_items_client_request_id.sql` present. A dedicated follow-up commit (`7519bbe`, "wire pruneSynced into the sync engine so queue cleanup actually runs") is merged, closing a gap the doc itself flagged.
**ME relevance**: CERTIFICATION INPUT — the most candidly self-disclosed programme (explicit KNOWN LIMITATION section naming `change_quantity`/`remove_item` as still `ONLINE_REQUIRED`, and no live-production-auth E2E attempted).
**Discrepancy**: none.

### P11 — Production Security Hardening
**Claimed** (`docs/p11-production-security-hardening.md`, three stacked passes, FINAL STATUS explicitly "🟡 CONDITIONAL GO — not 100/100"): fixed a `nova_user_roles_view` cross-tenant SECURITY DEFINER leak (P0); revoked 26 anon-executable SECURITY DEFINER functions to 0; locked down the RLS-enabled-no-policy `migration_transfer_audit` table; fixed an RBAC self-check bypass (`has_any_role` etc. callable with an arbitrary user id); fixed `restaurant_properties`/`restaurant_locations` property-scope escalation; added 29 hot-path FK indexes; wrapped RLS init-plan calls on `app_users`/`rbac_user_roles`. Explicitly discloses two still-open P1s: leaked-password protection (blocked, no Auth-config credential in that session) and backup/recovery (confirmed absent, Free-tier org plan, no PITR).
**Actual**: migration files `0048`, `0050`, `0053`, `0054`, `0055` present; `0051`/`0052` explained as renumbered (self-consistent). `0050_p11_rbac_self_check_enforcement.sql` was read in full and genuinely rewrites `has_any_role` (and the related helper family) to require `_user_id = auth.uid()`, matching the claim. This ME-00 session independently re-confirmed via live advisor query that **leaked-password protection is still disabled** — the disclosed-open item remains open. This ME-00 session also independently found `p11_is_staff_of_tenant_self_check`, applied to production **2026-09-14 16:41:52Z**, with no corresponding file in `main` at all — i.e., P11-labeled security hardening is *still actively happening against production*, past what `docs/p11-production-security-hardening.md` describes, and past what's in git.
**ME relevance**: CERTIFICATION INPUT for the migration files that do exist and match their described SQL; OPEN DEFECT for leaked-password protection and backup/recovery (both still open, confirmed); KNOWN LIMITATION that this doc's central evidentiary claims (live advisor before/after counts, exploit reproduction) rest on a prior session's live-database assertions that a static code read cannot independently re-derive — though ME-00 *did* independently re-run the advisor checks this session and got matching current numbers (ME-00-G) and matching still-disabled leaked-password status, which corroborates the doc's honesty rather than contradicting it.
**Discrepancy**: production has at least one P11-domain migration (`p11_is_staff_of_tenant_self_check`) not reflected anywhere in git — same class of finding as P09.

### P12 — Self-Serve Onboarding
**Claimed** (commits `3b81d99`, `05f81a6`, `acfe938`, `c833fb7`): sign-up → business → property/outlet → operating-model → ready wizard; `restaurant_bootstrap_tenant` SECURITY DEFINER RPC solving the RLS chicken-and-egg problem for a first tenant; live-simulation-driven fixes (a route-nesting bug hiding the sign-up form; a duplicate-submission race); country field + funnel telemetry + accessibility fixes; a final dark-theme contrast fix.
**Actual**: `src/modules/restaurant/onboarding/` contains `contracts.ts`, `onboarding.functions.ts`, `onboarding.server.ts`, `onboarding.server.test.ts` — all present. Migration `0049_p12_self_serve_tenant_bootstrap.sql` present. The claimed route-rename fix is visible directly in commit `05f81a6`'s file-stat (`auth.sign-up.tsx` → `auth_.sign-up.tsx}`) — an actual rename, not just a description. `src/styles.contrast.test.ts` (138 lines) matches the claimed WCAG-luminance regression test.
**ME relevance**: CERTIFICATION INPUT — a healthy build → live-simulate → fix → re-verify pattern with file-level evidence at each step.
**Discrepancy**: none.

### P13 — Configuration & Readiness Centre
**Claimed** (commit `7009618`): an 18-step canonical readiness engine reusing existing authoritative tables (no parallel engine); `confirmGoLive` requires a real recorded test sale plus explicit capability-gated confirmation (LIVE is never inferred from configuration alone); new Staff & Roles UI wired to previously UI-less member functions.
**Actual**: `src/modules/restaurant/readiness/` contains `contracts.ts`, `readiness.functions.ts`, `readiness.server.ts` (25KB), `readiness.server.test.ts`, `readiness.integration.test.ts`, `readiness.security.test.ts`, `ui/` — all present and sized consistent with the claimed scope. `StaffPanel.tsx` and its route exist per the commit's file list.
**ME relevance**: CERTIFICATION INPUT. One cross-programme claim (P12's later commit `acfe938` references matching a country-name string against P13's readiness engine) was **not independently re-verified line-by-line** in this pass — flagged as a follow-up spot-check, not confirmed or refuted.
**Discrepancy**: none confirmed.

### O6 (referenced but not a P0x programme)
`docs/o6-ocr-staging-architecture.md` is explicitly design-only: it states plainly "No OCR or AI extraction API is called anywhere in this codebase." Confirmed self-consistent (no OCR code found in `src/`). NOT RELEVANT to certification except as a reminder it is not a built capability.

### Unmerged branch divergence (commit-list metadata only, per this session's instruction not to inspect diffs)

| Branch | Ahead of main `a481620` | Behind | Merge-base | Note |
|---|---|---|---|---|
| `origin/claude/p07-analytics-closure` | 1 | 0 | = main HEAD | One further commit (`b48cb3a`, "close property/outlet isolation gaps in Purchasing, Kitchen and Inventory-Menu intelligence"), unmerged. |
| `origin/claude/p08-api-integration-closure` | 1 | 0 | = main HEAD | One further commit (`3a5e730`) — the actual full P08 API/Integration Platform. Unmerged. |
| `origin/claude/p09-enterprise-closure-f1peif` | 36 | 0 | = main HEAD | Large, iterative (repeated "Fix regression"/"CI:"/"Diagnostics:" commits, three successive certification-doc rewrites: "CONDITIONAL" → "pass-2 — still CONDITIONAL" → "pass-3 closure"). Unmerged. Corroborates ME-00-D's production-migration-drift finding. |
| `origin/claude/nova-fnb-engineering-constitution-f1peif` | 0 | 9 | behind main | Stale/superseded; already folded into main via `85d04b3`. Not a source of unmerged work. |

**Overall reconciliation verdict**: P07, P10, P12, P13 show no discrepancy between claim and code. P08 and P09 each have a "labeling risk" where the programme name on `main` covers far less than the full unmerged branch's scope. **P09 (and, to a lesser and more recent extent, P11) additionally show a real, material discrepancy**: production's applied-migration state contains schema/security changes that match the unmerged P09-closure branch's description almost exactly, with no corresponding commit anywhere in git history. This is carried forward into the Known Defect Register as KD-01.

---

## ME-00-N — Known Defect Register

| ID | Description | Source | Severity | Domain | Current Status | Market-Entry Impact | Gate |
|---|---|---|---|---|---|---|---|
| KD-01 | Production database has migrations applied (`0057`–`0063`, `p11_is_staff_of_tenant_self_check`) with no corresponding file in `main`'s `standalone/db/migrations/`; the repository cannot reproduce the current production schema. Strongly correlated with the unmerged `origin/claude/p09-enterprise-closure-f1peif` branch's described isolation fixes. | This ME-00 inspection (ME-00-C/D/M) | HIGH | Tenancy / RBAC / Commercial / Inventory / Import — cross-cutting | OPEN, confirmed live | Blocks a trustworthy "what exactly are we certifying" answer until resolved — the certification candidate's schema must be pinned to an actual git commit before ME-01 proceeds | ME-00 (recorded), ME-01 must resolve before hardening a schema state that isn't in git |
| KD-02 | Leaked password protection (HaveIBeenPwned check) is disabled in Supabase Auth. Previously identified and documented as an open P1 by `docs/p11-production-security-hardening.md`; remediation (a one-minute Dashboard toggle) was specified but not applied. | `docs/p11-production-security-hardening.md`; reconfirmed live by this session | MEDIUM | Auth | OPEN, confirmed still disabled | Zero-downtime fix available; should be closed before go-live | ME-00 (recorded), remediation candidate for ME-01/ME-02 |
| KD-03 | No Point-in-Time-Recovery/backup regime confirmed (org reported as Free-tier plan in `docs/p11-production-security-hardening.md`; this session did not re-verify plan tier or backup configuration directly). | `docs/p11-production-security-hardening.md` | HIGH (if unconfirmed) | Infrastructure | OPEN / UNVERIFIED by this session | A production system with real tenant data and no confirmed backup capability is a material go-live blocker | ME-00 (recorded), verification + remediation for ME-01/ME-11 |
| KD-04 | This session cannot establish the deployed production application's commit/build identity (no hosting-platform access) — Git↔Production relationship is UNKNOWN, not confirmed MATCH. | This inspection, ME-00-B | MEDIUM | Deployment | OPEN | Certification candidate's "what's actually running" side is unverified | ME-00 (recorded), close before ME-01 |
| KD-05 | Dependency baseline (`bun install`) cannot be verified in this session's sandbox — outbound npm registry access returns HTTP 403 — so `typecheck`/`lint`/`test`/`build` could not be executed to a real result. | This inspection, ME-00-L | MEDIUM (environment, not code) | Build/CI | OPEN (environment limitation) | Test baseline is not actually established; must be re-run in an environment with registry access before ME-00 evidence is complete | ME-00 (recorded) |
| KD-06 | `0008_reseed_role_permissions` (production) and a handful of granular repair migrations (`restore_restaurant_trigger_parity` et al.) have no discrete file in the repo's migration directory — mostly explained as consolidation, but not individually documented. | This inspection, ME-00-D | LOW | Tenancy/RBAC, schema hygiene | OPEN, low materiality | Minor reproducibility gap | ME-00 (recorded) |
| KD-07 | Two tables (`migration_transfer_audit`, deprecated `user_roles`) have RLS enabled with zero policies — default-deny, not an exposure, but worth an explicit ADR/comment confirming it's intentional rather than an oversight. | This inspection, ME-00-F (Supabase advisor `rls_enabled_no_policy`) | LOW | Database hygiene | OPEN, informational | None currently; clarify intent | ME-00 (recorded) |
| KD-08 | A legacy/unused hospitality-PMS table set (`guests`, `bookings`, `guest_preferences`, `pms_folio_postings`) exists with zero rows and no `restaurant_`/product-aligned naming; unclear if load-bearing or vestigial from `0002_hospitality_bridge`. | This inspection, ME-00-E | LOW | Schema hygiene | OPEN, needs owner confirmation | None currently; candidate for removal or documentation | ME-00 (recorded) |
| KD-09 | P08 ("API Integration") and P09 ("Enterprise") programme labels on `main` cover materially less than what those names' full closure branches (`origin/claude/p08-api-integration-closure`, `origin/claude/p09-enterprise-closure-f1peif`) describe. Risk of a certification reviewer conflating the label with the branch's full scope. | This inspection, ME-00-M | MEDIUM (process/labeling) | Process | OPEN | Could cause a false "already closed" assumption in later ME gates | ME-00 (recorded) |
| KD-10 | Two coexisting, non-unified RBAC systems exist in the codebase: a platform-tier system (`src/lib/rbac/`, `rbac_user_roles`, `nova_has_permission`) and a tenant/restaurant-tier system (`src/modules/restaurant/core/access.server.ts`, `restaurant_members`, `assertCapability` — the actual workhorse, imported by 88 files). The platform tier's own `requirePermission` middleware is defined but has no call sites in any business logic. Code comments frame the split as a deliberate two-tier (platform vs. sellable-module) design, not an accidental duplicate, and both paths are independently test-covered — but this sits close enough to CLAUDE.md's "never introduce a parallel RBAC system" boundary to require an explicit design-intent ruling rather than being assumed benign. | This inspection, ME-00-H | MEDIUM (architectural) | RBAC / cross-cutting | OPEN, needs an explicit architectural ruling | Certification must record whether this is an accepted, documented two-tier design or a defect to unify, before later ME gates build on either RBAC path | ME-00 (recorded), ruling needed before ME-02/ME-03 |

---

## ME-00-O — ME Finding Register

| ID | Title | Classification | Note |
|---|---|---|---|
| ME-01 | Database performance/indexing | CERTIFICATION REQUIREMENT | Baseline established exactly (ME-00-G): 285 unindexed FKs, 54 RLS init-plan findings, 293 multiple-permissive-policy findings, 46 unused indexes, across 419 total indexes / 149 tables. |
| ME-02 | RLS policy complexity | REQUIRES VERIFICATION | 294 policies across 147 tables; per-policy `USING`/`WITH CHECK` content not individually reviewed in ME-00 (explicitly out of scope for a baseline pass). |
| ME-03 | SECURITY DEFINER surface | REQUIRES VERIFICATION | 66/69 public functions are SECURITY DEFINER; 44 are `authenticated`-callable per the live advisor. P11 fixed a self-check-bypass class of bug in several of them; whether all 44 are now safe was not re-derived by ME-00. |
| ME-04 | Fiscal concurrency/order guarantee | REQUIRES VERIFICATION | Fiscal tables/functions (`restaurant_fiscal_next_counter`, `restaurant_next_document_number`, TRA-VFD protocol migration `0031`) exist; concurrency-safety under load not exercised in ME-00. |
| ME-05 | Guest adversarial certification | REQUIRES VERIFICATION | No policy grants `anon` directly (ME-00-F); whether guest sessions authenticate as `anon` or as a server-issued `authenticated` token, and what the 120 `public`-role policies actually expose to each, is unresolved — directly relevant to guest-ordering security and the single highest-priority item for ME-05. |
| ME-06 | Financial invariants | REQUIRES VERIFICATION | Not exercised in ME-00 (out of scope for a baseline-lock pass). |
| ME-07 | Inventory conservation | REQUIRES VERIFICATION | Stock-movement ledger exists (`restaurant_stock_movements`, 39 rows sampled) per CLAUDE.md's canonical model; conservation invariants not tested in ME-00. |
| ME-08 | Index rationalisation | CERTIFICATION REQUIREMENT | Same baseline numbers as ME-01 apply; 46 unused indexes are the starting point for ME-08 specifically. |
| ME-09 | RLS performance | CERTIFICATION REQUIREMENT | 54 auth-RLS-initplan findings and 293 multiple-permissive-policy findings are the ME-09 starting point. |
| ME-10 | Import/migration integrity | CONFIRMED DEFECT | ME-00-D/KD-01: production migration state is materially ahead of and undocumented in git. This is not merely "requires verification" — it is a confirmed, live discrepancy as of this inspection. |
| ME-11 | Hosted/appliance certification | REQUIRES VERIFICATION | Two deployment models exist by design (README.md, `nova` script); asymmetric-capability claims not exhaustively enumerated in this pass (see ME-00-K placeholder). |
| ME-12 | Observability | REQUIRES VERIFICATION | No monitoring/alerting/log-aggregation configuration was found in the repository during this pass; whether observability exists purely at the Supabase/hosting-platform layer (outside repo scope) is unresolved. |

---

## ME-00-P — Certification Candidate Definition

**CERTIFICATION CANDIDATE**

- **Repository**: `dingbee/nova-hospitality-fnb`
- **Branch**: `main`
- **Commit**: `a481620f73d37a4042c8f99b6ad828d7bc4e9560` ("Merge P10 Offline Operations into main", 2026-09-12T10:59:01+03:00)
- **Production Deployment**: UNKNOWN — no hosting-platform access in this session; Git↔Production relationship is UNKNOWN (KD-04), not confirmed MATCH. **This is a gap the candidate definition inherits and that must be closed before ME-01 proceeds on assumed-matching code.**
- **Database**: Supabase project `nova-hospitality-fnb` (`lusiqcmxfxhnehxmwihs`), Postgres 17.6.1.155, region `eu-central-1`
- **Migration state**: 🔴 **NOT reproducible from the named commit** — production has applied at least 9 migrations (`0008`, `0057`–`0063`, `p11_is_staff_of_tenant_self_check`) absent from `main`'s `standalone/db/migrations/` (KD-01, KD-06). **The certification candidate's database and its named git commit are two different systems until this is resolved.**
- **Schema**: 149 tables in `public`, all RLS-enabled (0 forced), 294 policies, 66 SECURITY DEFINER functions, 419 indexes — as directly queried from the live database at inspection time (ME-00-E/F/G).
- **Runtime**: TypeScript/React 19 + TanStack Start/Router + Vite, targeting a Cloudflare Worker (hosted) per `@cloudflare/vite-plugin`/`nitro` dependencies and `docs/p08-a-external-http-entry-point-adr.md`; exact deployed build UNKNOWN (KD-04).
- **Deployment Model**: dual — "hosted" (Postgres/PostgREST-compatible API, e.g. the Supabase project above) and self-contained local "appliance" (Dockerized PostgreSQL + PostgREST + local gateway, `./nova` CLI, explicitly refuses to start against anything with `supabase.co` in its URL). Full asymmetry analysis pending (ME-00-K placeholder).
- **Feature State**: substantially implemented restaurant/bar OS (POS, inventory, procurement, recipes/costing, pricing, fiscal, guest ordering, offline queue/sync, commercial/billing, intelligence advisory layer) per the P07–P13 programme history (ME-00-M) and the module matrix in ME-00-I — almost everything traced is IMPLEMENTED, with two PARTIAL/UNKNOWN items (fiscal-specific reconciliation reporting; end-to-end intelligence recommendation surfacing) and one architectural item requiring a ruling rather than a build status (KD-10, the two coexisting RBAC systems).

**This is the reference point ME-01 is allowed to change from — with the explicit caveat that its database and deployment identity are not yet pinned to a single reproducible state (KD-01, KD-04), and KD-10 (two RBAC systems) requires an explicit design-intent ruling before later gates build on either authorization path.**

---

## ME-00-Baseline Drift Test

| Comparison | Classification | Basis |
|---|---|---|
| Git HEAD (`a481620`) ↔ Production deployment | ⚪ UNKNOWN | No hosting-platform access in this session (KD-04) |
| Production deployment ↔ Database (`lusiqcmxfxhnehxmwihs`) | ⚪ UNKNOWN | Same reason — cannot confirm which commit the live app process is actually running against, only that this Supabase project is documented as "the production project" by prior sessions |
| Repository (`main`) ↔ Database migration state | 🔴 MATERIAL DRIFT | KD-01: 9+ migrations applied to production with no git representation, most recently minutes before this inspection began |
| Repository ↔ Database schema (structural) | 🟠 DRIFT (bounded) | Table/policy/function/index counts were captured directly from the live database, not derived from replaying repo migrations — so ME-00-E/F/G are accurate for *today's* database, but that database is demonstrably not what `main`'s migrations alone would produce |
| Configuration (env var contract) ↔ actual runtime config | ⚪ UNKNOWN | `.env.example` documents the contract; actual deployed environment variable values were not (and per the mandate, should not be) inspected |

---

*End of ME-00-A through ME-00-P and the Baseline Drift Test. All sections (including H–K, application architecture / feature-module inventory / customer activation / hosted-appliance model) are complete as of this revision.*
