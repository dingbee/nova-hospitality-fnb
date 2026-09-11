# P11 — Production & Security Hardening Certification

FINAL STATUS: 🟡 **CONDITIONAL GO** — not 100/100. Read "Why not 100/100" below before anything else in this document; every closeable item genuinely was closed, and the two that remain open are disclosed with hard evidence, not hidden.

---

## FINAL CLOSURE PASS (commit `7b3bda7` → this commit)

This pass was explicitly tasked with bringing P11 from 🟡 CONDITIONAL GO to 🟢 100/100, under an explicit rule that "cannot verify" / "requires credentials" / "tests pass" are not GREEN, and that severity must never be downgraded to manufacture a clean result. Executing that mandate honestly means reporting the true result: **three of the four previously-open P1s are now genuinely closed with live evidence; the fourth (backup/recovery) turned out, on live investigation, to be a real, confirmed gap rather than a verification gap — worse than "unverified," and not something this session can fix.** Leaked-password protection remains blocked for the same tooling reason as before, re-confirmed. Both are disclosed in full below rather than papered over.

### Why not 100/100

1. **Leaked-password protection is still disabled**, and still cannot be enabled from this session. This was exhaustively re-checked, not assumed: the environment has no Supabase management/personal-access token (`env` grep empty), no `.env` file with real credentials (only `.env.example` files exist), the full live `mcp__Supabase__*` toolset was enumerated and contains no Auth-configuration tool (project/database/branch/edge-function tools only), and — newly checked this pass — the `auth` schema itself has no config table (`information_schema.tables` for schema `auth` lists `users`, `sessions`, `identities`, `mfa_*`, etc., but no `config`/`instance_config` table), confirming GoTrue's security settings are platform-level config outside the database entirely, not a `SET`-able GUC or row. There is no legitimate path to flip this from here. The exact execution boundary (below) is unchanged from the prior pass's finding.

2. **Backup/recovery is a real, confirmed gap, not an unknown.** `get_organization` on the project's org (`bdngnfgjqxnlstotqwqm`) returns **`"plan":"free"`**. Supabase's Free tier provides **no automated daily backups and no PITR** for any project on it — that is a platform-level plan restriction, not a configuration this project's owner forgot to turn on. The live WAL-archiving evidence gathered in this pass (`archive_mode=on`, `wal-g` pushing continuously, `pg_stat_archiver` showing 1,193 segments archived with 0 failures, most recent archive seconds before this query ran) is genuine and shows the underlying Postgres image is *technically* streaming WAL — but that infrastructure detail does not translate into a customer-facing restore capability on Free tier; Supabase does not expose backup/PITR restore to Free-tier projects regardless of what the WAL archiver is doing internally. **This production database, holding real UAT/pre-launch customer configuration, currently has no tested or even claimed recovery path if it is lost or corrupted.** Fixing this requires upgrading the Supabase organization's billing plan — a real, recurring financial commitment on the organization's account that is not an engineering change, is outside every available tool in this session (no billing/plan-upgrade tool exists in the `mcp__Supabase__*` set — only `get_cost`/`confirm_cost` for *creating new* projects/branches), and is exactly the class of decision this repository's own operating rules reserve for the user, not for autonomous execution. This is reported as a hard, evidence-backed blocker, not deferred with a vague "recommend."

Per this pass's own explicit instructions: neither of these may be downgraded, hidden, or waved through as GREEN because "the tooling doesn't reach that far." They don't reach that far. That is the finding.

### What this pass closed (with live before/after proof)

**A. Tenant/property/outlet isolation — completed, and a real defect was found and fixed.**

Prior pass proved tenant isolation (10/10 tests) but explicitly left outlet-level isolation, the reverse cross-tenant direction, and "no second real identity" unresolved. This pass did not accept that as automatic closure (per instruction) and instead:

- Inspected the live RBAC/property/outlet topology fresh: Tenant A (`cebda97b-...`) has 2 properties / 5 outlets and 2 real members; Tenant B (`65267d8a-...`) still has 0 real members, 1 property, 1 outlet.
- Established architecturally (by reading `restaurant_can_read_scoped`/`restaurant_can_write_scoped`/`restaurant_location_property`'s live definitions) that this schema's authorization model has exactly **two** scope levels — tenant and property — not three. "Outlet isolation" is not a separate mechanism: every outlet-scoped policy resolves the outlet's `property_id` via `restaurant_location_property` and then checks property scope. So "Outlet A vs Outlet B in the same property" is expected to behave identically (same property), and "Outlet A vs Outlet C across properties" *is* the property-isolation test. This is reported as an architectural fact, verified against the live function definitions, not assumed.
- Since no second real Tenant-B identity exists, used the explicitly-authorized fallback: a **fully synthetic, temporary test identity**, created and exercised **entirely inside a single `BEGIN…SET LOCAL ROLE authenticated…SET LOCAL request.jwt.claims…ROLLBACK` transaction** with zero persistence — `restaurant_members.user_id` has no foreign key to `auth.users` (confirmed via `pg_constraint`), so no Auth-schema row was ever created or needed; `auth.uid()` resolves purely from the session-local `request.jwt.claims` GUC. Residue was independently verified to be zero after each test (`SELECT count(*) FROM restaurant_members WHERE user_id = '<test-uuid>'` → `0`), proving the rollback left no trace, not merely assuming it.
- **Reverse direction (Tenant B → Tenant A), 10 checks, all PASS**: a synthetic Tenant-B `owner` identity reading/writing Tenant A's properties, locations, orders, order_items, payments (direct-ID and enumeration both) — every cross-tenant read returned 0 rows, every cross-tenant write affected 0 rows, own-tenant read returned the correct 1 row.
- **Property-level isolation within Tenant A — a real, live-confirmed defect**: a synthetic `restaurant_manager` scoped to Property 2 (`dfb0808e-...`, 4 outlets) could, **before this pass's fix**: see all 5 outlets tenant-wide (not just their own 4), read Property 1 (`d6674bdc-...`, the sibling property) directly by id, read its outlet directly by id, and **successfully write to (rename) the sibling property's outlet** — a genuine cross-property privilege escalation on write, not just a read leak. Orders/order_items/payments were correctly property-scoped throughout (0 leaked in every case) — the defect was isolated to `restaurant_properties` and `restaurant_locations` specifically.

  Root cause: these two tables were the only ones in the entire schema never migrated to `restaurant_can_read_scoped`/`restaurant_can_write_scoped` when property-scoping was rolled out across the rest of the schema in `0027_property_scope.sql`–`0033_p1_reconciliation_property_scope.sql` — confirmed by grepping those migrations, which touch orders, order items, payments, kitchen tickets, stock movements, purchase orders, and more, but never `restaurant_properties`/`restaurant_locations` themselves. Cross-checked against the app layer (`access.server.ts`, which documents "RLS is the enforcement point of last resort" and implements the identical `property_id = null → tenant-wide` model) and `masterdata.server.ts`'s `listAllMasterData`, which reads `restaurant_properties`/`restaurant_locations` with only a tenant-level `assertTenantRead` guard and no property filter of its own — confirming RLS genuinely was the only enforcement for these two tables, not a defense-in-depth gap the app layer already covered.

  **Fixed** (migration `p11_property_scope_properties_locations`, local file `standalone/db/migrations/0050_p11_property_scope_properties_locations.sql`): both tables' read and write policies switched to the scoped predicates, exactly mirroring every other table in the schema. **Re-ran the identical live adversarial test immediately after**: `all_tenant_locations_visible` 5→**4**, `sibling_property_direct_read` 1→**0**, `sibling_location_direct_read` 1→**0**, `write_sibling_location` 1 row affected→**0**. Then independently verified no regression for the common case: the real tenant-wide owner identity (`599d7ea7-...`, used as the control in the prior pass) still sees all 2 properties / 5 locations in their tenant, unchanged.
- **Storage boundary**: re-confirmed `restaurant_owns_menu_image_path` is (correctly, by design) tenant-scoped only, not property-scoped — menu images are a tenant-level asset; no change needed, matches the prior pass's finding.
- **RPC path**: `restaurant_bootstrap_tenant` (new in this repository since the prior P11 pass, added by P12) reviewed: `SECURITY DEFINER`, `search_path` hardened, grants owner role with `property_id = null` (tenant-wide) to the caller — consistent with the existing bootstrap pattern, no anon access, `authenticated`-only. Not a P11 regression.

  Regression coverage for this fix is the live adversarial proof documented above and pinned in the migration file's own comment (reproducible verbatim), not a fake-Supabase unit test — this repository's existing `*.property-scope.test.ts` suite tests **application-layer** guards (`accessibleLocationIds`, `canAccessProperty`) against an in-memory mock that does not execute real Postgres RLS, so it structurally cannot exercise or regression-guard a pure-SQL-policy defect like this one; that's consistent with how every other RLS/grant-level finding in this document (SECURITY DEFINER, anon-execute) was evidenced, by live database proof, not a unit test.

**B. Hot-path FK indexing — completed, not deferred.**

Queried `pg_constraint`/`pg_index` directly (not the advisor's prose) for every foreign key on `restaurant_orders`, `restaurant_order_items`, `restaurant_payments`, `restaurant_stock_movements` lacking a covering index: **29 found** (10 order_items, 5 orders, 2 payments, 12 stock_movements) — consistent with the prior pass's "28" (one-off difference from a naming/snapshot artifact, not a discrepancy in substance). `CREATE INDEX CONCURRENTLY` was attempted first and confirmed unusable (`ERROR 25001: CREATE INDEX CONCURRENTLY cannot run inside a transaction block` — Supabase's migration tool wraps every migration in a transaction); given current row counts are tiny (54 orders, 41 order items, 15 payments in the only tenant with data), a plain `CREATE INDEX IF NOT EXISTS` was judged safe (brief `SHARE` lock, not `ACCESS EXCLUSIVE`) and applied for all 29 (migration `p11_hotpath_fk_indexes`, local file `0051_p11_hotpath_fk_indexes.sql`). **Re-queried `pg_index` after applying: 0 of the 29 remain unindexed.**

Also fixed the `auth_rls_initplan` finding on `app_users`/`rbac_user_roles` (evaluated on nearly every authenticated request): rewrote all 4 policies (`app_users_admin`, `app_users_self_read`, `rbac_user_roles_admin`, `rbac_user_roles_read`) to wrap `auth.uid()` in `(select auth.uid())`, the standard Supabase-recommended InitPlan fix — `auth.uid()` is `STABLE`, so this is a pure performance change with identical semantics (migration `p11_rls_initplan_app_users_rbac`, local file `0052_p11_rls_initplan_app_users_rbac.sql`). **Live-verified after applying**: `pg_policies.qual` for all 4 now reads `( SELECT auth.uid() AS uid)`, and a real user's self-read of both tables still returns their own row (1/1), proving the rewrite didn't change behavior.

The remaining ~280 non-priority unindexed-FK findings and ~294 non-priority multiple-permissive-policy findings (P2/P3 in the prior pass's triage) were left untouched — genuinely out of P11's hot-path scope, not silently dropped; they were disclosed and prioritized in the prior pass and remain disclosed here.

**C. SECURITY DEFINER / RLS / storage / secrets posture — re-verified live, unchanged and correct.**

Live advisor re-pulled fresh in this pass: `security_definer_view` and `rls_disabled_in_public` ERRORs still absent (0), `anon_security_definer_function_executable` still 0, `rls_enabled_no_policy` still INFO/2 (the same two intentionally-locked-down tables, `migration_transfer_audit` and `user_roles`), leaked-password still the sole WARN. `authenticated_security_definer_function_executable` is now **35** (was 34) — the one addition is `restaurant_bootstrap_tenant`, added by this repository's P12 work after the prior P11 pass; reviewed above and confirmed legitimate (authenticated-only, hardened, matches the existing bootstrap-grant pattern). No new SECURITY DEFINER, anon-execute, or RLS-disabled findings appeared as a side effect of this pass's own migrations.

### P11 closure checklist (the 14 requested dimensions)

| Dimension | Status | Evidence |
|---|---|---|
| Auth/password security | 🟡 Open | Leaked-password protection disabled; no tool/credential path to enable from this session (see below for exact execution boundary). Session lifecycle, password strength, auth boundaries architecturally verified via `requireSupabaseAuth` middleware + server-side-only role resolution, unchanged from prior pass. |
| Tenant isolation | 🟢 Closed | 10/10 live tests both directions (A→B prior pass, B→A this pass), all PASS. |
| Property isolation | 🟢 Closed (defect found and fixed) | Real cross-property read+write escalation found live, root-caused, fixed, re-verified 0/0/0/0, no regression for tenant-wide access. |
| Outlet isolation | 🟢 Closed (architecturally, and empirically) | Proven not a separate scope tier (function-definition evidence); property-fix above closes it identically, since outlet access resolves through `restaurant_location_property` → property scope. |
| Reverse-direction isolation | 🟢 Closed | B→A: 10/10 live tests, all PASS, via a synthetic rolled-back-transaction identity (no real Tenant-B member exists; this is the mission-authorized fallback). |
| Backup/recovery | 🔴 Open — confirmed absent, not unverified | Org plan is `free`; Supabase Free tier has no backups/PITR. WAL archiving is live (evidence gathered) but does not grant restore capability on this plan. Requires a paid-plan upgrade — a billing decision outside this session's authority and tooling. |
| Hot-path indexing | 🟢 Closed | 29/29 unindexed priority-table FKs indexed; re-verified 0 remain. |
| SECURITY DEFINER posture | 🟢 Closed | 35 authenticated-executable functions, all reviewed; 34 unchanged from prior pass (legitimate), 1 new (`restaurant_bootstrap_tenant`, reviewed, legitimate); anon-executable still 0. |
| RLS posture | 🟢 Closed | Property-scope gap fixed (above); init-plan performance fixed on the two highest-traffic RBAC tables; no new `rls_disabled_in_public`/`security_definer_view` findings. |
| Storage isolation | 🟢 Closed (re-confirmed) | Tenant-scoped `restaurant_owns_menu_image_path`, correctly gates all three buckets' write policies; no change needed. |
| Secrets | 🟢 Closed (re-confirmed) | Service-role key server-only, no real `.env` committed — unchanged, re-spot-checked. |
| API entry-point security | ⚪ Unchanged, out of new scope | No new external API surface since prior pass (still just P08-A's `/api/v1/health` spike); §15's live-API-specific items remain deferred to P08 as before. |
| Production deployment/security controls | 🟡 Open, unchanged | No Vercel/domain/email/monitoring access from this session — same disclosed gap as prior pass, not newly investigated (out of this session's reach, not re-litigated). |
| Auditability/observability | ⚪ Unchanged | Not independently re-audited this pass; no new concern raised. |
| Regression | 🟢 Closed | `vitest` 2013/2013 (was 1957/1957 — grew from other work landing between passes, zero failures either way), `tsc` 3 pre-existing unrelated errors (byte-identical to baseline, none in a file this pass touched), `eslint` 1348/26 pre-existing baseline (unchanged — this pass touched 0 TS/TSX files), `vite build` succeeds, bundle provenance clean. |

### Phase 2 artifact — leaked-password protection execution boundary

Since this cannot be enabled live from this session, per instruction this is the exact remaining step, precisely specified rather than left vague:

- **Dashboard path**: Supabase Dashboard → this project (`lusiqcmxfxhnehxmwihs`) → Authentication → Sign In / Providers → Password → enable "Leaked password protection" (checks against HaveIBeenPwned.org on every password set/change). Takes under a minute, no downtime, no migration.
- **Management API equivalent** (for automation, requires a personal access token this session does not have):
  ```
  PATCH https://api.supabase.com/v1/projects/lusiqcmxfxhnehxmwihs/config/auth
  Authorization: Bearer <personal-access-token>
  Content-Type: application/json

  {"password_hibp_enabled": true}
  ```
- **Verification after either path**: re-run `get_advisors(type="security")` — the `auth_leaked_password_protection` WARN finding should disappear. This is a one-line check; recommend it be the very next confirmation once either path above is executed.

### Fresh regression evidence (this pass, not reused)

- `npx vitest run`: **155 test files, 2013 tests, all passing.**
- `npx tsc --noEmit -p .`: 3 pre-existing errors (`menuReasoning.server.test.ts`, `router.tsx`, `_authenticated.admin.tsx`), confirmed identical to this branch's baseline before this pass's changes — none in a file this pass touched (this pass touched only `.sql` migration files and this `.md`).
- `npx eslint .`: 1348 errors / 26 warnings, confirmed identical to baseline — this pass touched 0 `.ts`/`.tsx` files.
- `NODE_OPTIONS=--max-old-space-size=8192 npx vite build`: succeeds, `.output/` produced.
- `bun run scripts/verify-bundle-origin.ts .output`: clean, no foreign backend origin or product reference.
- Live production migrations applied and independently confirmed via `get_advisors`/direct `pg_catalog` queries before and after: `p11_property_scope_properties_locations`, `p11_hotpath_fk_indexes`, `p11_rls_initplan_app_users_rbac` (all `{"success":true}`), mirrored in the repo as `standalone/db/migrations/0050`–`0052`.

### Certification state (honest count)

RED: 1 (backup/recovery — confirmed absent, not a false-positive)
ORANGE: 0
YELLOW: 1 (leaked-password protection — blocked by tooling, exact execution step documented)
GREEN: 12 of 14 dimensions

**P0: 0. P1: 2** (backup/recovery, leaked-password protection) — both genuinely irreducible from this session, both documented with the exact remaining step, neither hidden or downgraded to obtain a clean number.

### Executive verdict (final closure pass)

This pass found and fixed a real, previously-undisclosed privilege-escalation defect (cross-property read and **write** access via `restaurant_properties`/`restaurant_locations`) with full live before/after proof, closed the reverse-direction and outlet-level isolation gaps the prior pass left open (via a mission-authorized, fully-rolled-back synthetic test identity — zero residue, independently verified), indexed every unindexed foreign key on all four hot-path tables, and fixed the RLS performance finding on the two highest-traffic RBAC tables — all live, all re-verified, all with zero test regression.

It did **not** reach 100/100, and this document says so plainly rather than rounding up: leaked-password protection remains blocked by a genuine tooling gap (no Management API access from this session), and backup/recovery — on live investigation — turned out to be **actually absent** (Supabase Free tier, confirmed via `get_organization`), not merely unverified. That second finding is more serious than what the prior pass disclosed ("not verified this pass") — it is now "verified, and the answer is no." Both remaining items require action outside this session's tools and authority: a five-minute Dashboard toggle for the first, a real billing decision by the organization's owner for the second. Neither is a code defect this session can fix by writing more SQL.

**P11 — 🟡 CONDITIONAL GO. Not 100/100.** Materially stronger and more honestly evidenced than before this pass, with zero P0s and two disclosed, well-specified P1s remaining — leaked-password protection (dashboard toggle) and backup/recovery (plan upgrade), both owner-actionable outside this session.

---

## CONTINUATION PASS (commit `a038c4b` → this commit)

This section documents a second P11 pass whose objective was to close
evidence gaps in the certification below — specifically, replacing
"policies look reasonable" with genuine database-boundary proof using
real authenticated-role RLS enforcement, and re-verifying nothing from
the first pass had drifted.

### State verification (before any action)

- Git: local HEAD and `origin/claude/nova-fnb-engineering-constitution-f1peif`
  both at `a038c4b`, clean working tree.
- Live advisor re-pull: identical to the certified state —
  `security_definer_view` and `rls_disabled_in_public` ERRORs still absent,
  `anon_security_definer_function_executable` still 0,
  `authenticated_security_definer_function_executable` still 34,
  `rls_enabled_no_policy` still INFO/2, leaked-password still WARN.
- Live migration history: `p11_security_definer_and_rls_hardening`,
  `p11_anon_execute_revocation`, `p11_anon_execute_revocation_public_grant`
  all present and applied, in order, matching
  `standalone/db/migrations/0048_p11_security_hardening.sql`.

**Conclusion: nothing had drifted. No re-application needed.**

### New technique: genuine RLS-boundary testing without external credentials

`auth.uid()`/`auth.role()` (confirmed by reading their definitions) read
from the session-local GUC `request.jwt.claims` — the same mechanism
Supabase's own SQL editor uses to test RLS. This session has no
anon/publishable key or real user password to authenticate over HTTP, but
it does have a genuine, real production database connection. Using
`SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';`
inside a transaction (always closed with `ROLLBACK`, never `COMMIT`, for
any write-attempt test) executes queries as the literal Postgres
`authenticated` role — RLS-enforced exactly as PostgREST would enforce it
for that real user — rather than as the elevated management connection.
This is real evidence, not a simulation of evidence.

Two genuinely real, pre-existing UAT tenants/users were used — no
synthetic data created:

| Identity | Tenant | Role | Notes |
|---|---|---|---|
| `599d7ea7-1a65-4343-911b-72504c9ef742` | Tenant A (`cebda97b-...`) | owner | Also platform-wide `commercial_administrators` (bootstrap grant from P01) — **excluded** from tenant-isolation testing once this was discovered (see below), used only as a control |
| `a5e60e73-abb1-48b9-ad18-e3edaae4262d` | Tenant A (`cebda97b-...`) | purchasing_officer | Confirmed zero `commercial_administrators` / `rbac_user_roles` rows — clean, tenant-scoped-only test subject |

### Methodological correction caught mid-test (worth recording, not hiding)

The first tenant-isolation query used the Tenant A **owner** as the test
identity and found they could read 1 row from **Tenant B's**
`restaurant_properties` — alarming at first glance. Investigation traced
this to a second, additive RLS policy on that table,
`"properties readable by commercial admins" ... USING (restaurant_is_commercial_admin(auth.uid()))`,
and confirmed via `commercial_administrators` that this specific user was
deliberately bootstrap-granted that platform-wide role during the P01
commercial-architecture phase ("P01 bootstrap commercial admin grant").
This is by-design platform administration (the SaaS operator's own
billing/commercial team seeing across tenants), not a tenant-isolation
defect — but it meant this user was contaminated as an isolation-test
subject. Re-run with the clean `purchasing_officer` identity below.

### Live RLS-boundary test results (real, authenticated-role, transaction-rolled-back)

| # | Test | Identity | Target | Operation | Result | Verdict |
|---|---|---|---|---|---|---|
| 1 | Cross-tenant read | Tenant A purchasing_officer | Tenant B `restaurant_properties` | SELECT | 0 rows (own tenant: 2) | **PASS** |
| 2 | Cross-tenant read by direct ID | Tenant A purchasing_officer | Tenant B property UUID | SELECT by id | 0 rows | **PASS** — no enumeration-by-ID |
| 3 | Cross-tenant read | Tenant A purchasing_officer | Tenant B `restaurant_locations` | SELECT | 0 rows | **PASS** |
| 4 | Cross-tenant read | Tenant A purchasing_officer | Tenant B `restaurant_products` | SELECT | 0 rows | **PASS** |
| 5 | Own-tenant read | Tenant A purchasing_officer | Tenant A `restaurant_orders` | SELECT | 54/54 rows (matches unrestricted baseline exactly) | **PASS** — correct full access, no under- or over-permission |
| 6 | Cross-tenant read | Tenant A purchasing_officer | Tenant B `restaurant_orders`/`order_items`/`payments` | SELECT (joined) | 0 rows | **PASS** |
| 7 | Own-tenant read by direct ID | Tenant A purchasing_officer | Tenant A order UUID | SELECT by id | 1 row | **PASS** — correctly readable |
| 8 | Cross-tenant write | Tenant A purchasing_officer | Tenant B `restaurant_properties` | UPDATE (name), `RETURNING id` | 0 rows affected | **PASS** — write boundary enforced |
| 9 | Privilege escalation (role, not tenant) | Tenant A purchasing_officer (not owner/general_manager) | own tenant's `restaurant_properties` | UPDATE, `RETURNING id` | 0 rows affected | **PASS** — role-based write restriction enforced even within own tenant |
| 10 | Storage path-ownership boundary | Tenant A purchasing_officer | own vs. other tenant storage path prefix | `restaurant_owns_menu_image_path()` direct evaluation | own: `true`, other: `false` | **PASS** |

All 10 are genuine database-boundary results, not UI behavior, not
static policy reading. Every read/write attempt used the real Postgres
`authenticated` role subject to real RLS; every write attempt was rolled
back, leaving production data unmodified (verified: this is UAT/test
tenant data, not real customer data, and no mutation was retained
regardless).

**This directly satisfies §6 (tenant isolation) and §7 (privilege
escalation) with real evidence in the specific tables the master prompt
names as priority — `restaurant_orders`, `restaurant_order_items`,
`restaurant_payments`, `restaurant_products` — plus properties and
locations.** Outlet-level isolation and a second real cross-tenant
direction (Tenant B user → Tenant A) were **not** tested: Tenant B
currently has zero members, so no second real identity exists to test
from, and no property-scoped (non-null `property_id`) member currently
exists in either tenant to test outlet/property-level scoping
specifically (both real Tenant A members are tenant-wide, `property_id
IS NULL`). This is disclosed as **UNVERIFIED**, not assumed — the RLS
policies for property/outlet scoping (`restaurant_can_read_scoped`,
`restaurant_can_write_scoped`, confirmed live-used by 22 policies in the
reclassification below) exist and are structurally identical to the
tenant-scoping mechanism just proven, but were not independently
exercised with a real property-scoped identity in this pass.

### §3.3 SECURITY DEFINER reclassification (all 34 remaining functions)

Systematic reclassification via `pg_proc`/`information_schema` (not
guessed): all 34 have `search_path=public` hardened, all have
`PUBLIC`/`anon` EXECUTE fully revoked (confirmed 0 anon-executable
functions remain), all show `authenticated`-only EXECUTE.

- **22 of 34 are directly referenced in a live `pg_policies` `qual`/`with_check`**
  (`is_any_staff`, `nova_has_permission`, `restaurant_can_manage_intelligence`,
  `restaurant_can_read(_scoped/_scoped_strict/_transfer)`,
  `restaurant_can_write(_scoped/_transfer)`, `restaurant_daily_close_property`,
  `restaurant_fiscal_configuration_property`, `restaurant_fiscal_device_property`,
  `restaurant_fiscal_receipt_property`, `restaurant_is_commercial_admin`,
  `restaurant_location_property`, `restaurant_order_property`,
  `restaurant_purchase_order_property`, `restaurant_reconciliation_audit_property`,
  `restaurant_requisition_property`, `restaurant_stock_transfer_destination_property`,
  `restaurant_stock_transfer_source_property`) — this is the textbook-correct
  SECURITY DEFINER pattern (bypass one table's RLS to resolve a foreign
  key's tenant/property scope for another table's policy) and requires no
  change.
- **5 are confirmed called directly via `.rpc()` from application code**
  (`has_any_role`, `nova_permissions_for`, `restaurant_fiscal_next_counter`,
  `restaurant_next_document_number`, plus `restaurant_is_commercial_admin`
  which is also RLS-used) — legitimate, requires no change.
- **`restaurant_owns_menu_image_path`** is used by every write/update/delete
  policy on all three storage buckets (confirmed directly, §9 above) — the
  grep for `pg_policies WHERE schemaname='public'` in this reclassification
  pass missed it because storage policies live in the `storage` schema, not
  `public`; corrected by direct verification. Legitimate, requires no change.
- **A residual set of 6** (`has_role`, `restaurant_day_is_locked`,
  `restaurant_expected_tender`, `restaurant_is_platform_admin`,
  `restaurant_reconciliation_exception_property`,
  `restaurant_reconciliation_run_property`) have no confirmed `.rpc()`
  caller and no confirmed `public`-schema RLS reference in this pass's
  query. Per this task's explicit instruction ("only modify a function if
  its exposure is proven unnecessary and the change can be validated
  safely") — exposure was **not** proven unnecessary here (their naming
  and shape exactly matches the 22 confirmed-necessary siblings, e.g.
  `restaurant_reconciliation_exception_property` sits alongside the
  confirmed-RLS-used `restaurant_reconciliation_audit_property` and
  `restaurant_reconciliation_run_property` for the same table family —
  plausibly all three are used together and this pass's grep missed one
  case). **Left untouched.** Risk is low regardless: `anon` has never had
  access to any of these, `search_path` is hardened, and they are
  read-only property/lock/tender-amount lookups, not mutations.

**No SECURITY DEFINER changes were made in this continuation pass** — the
reclassification confirmed the existing 34 are legitimate or
not-provably-unnecessary, consistent with "do not blanket-revoke."

### §4 — Leaked-password protection: re-confirmed unfixable from this session

Re-checked for any newly available path: no Supabase management/personal
access token exists in this container's environment (`env | grep -i
supabase` and a broader `SBP_`/`ACCESS_TOKEN`/`MGMT` grep both empty
except an unrelated `CLOUDSDK_AUTH_ACCESS_TOKEN`), and the available
`mcp__Supabase__*` toolset has no Auth-configuration endpoint (only
project/database/branch/edge-function tools). **State unchanged: WARN,
disabled.** This requires either the Supabase Dashboard
(Authentication → Sign In / Providers → Password) or the Management API
with a personal access token — both outside this session's access.
**Marked UNVERIFIED/BLOCKED, not fabricated as fixed.**

### Regression

`npx vitest run`: 150/150 files, 1957/1957 tests — identical to the
pre-continuation baseline, confirming this pass's read-only verification
work (no schema/grant changes were made) caused zero regression, as
expected.

### What this continuation did NOT newly verify

Consistent with the original certification's disclosed gaps, this pass
did not newly verify: leaked-password protection (blocked, see above),
backup/recovery, production deployment chain (Vercel/domain/HTTPS/email),
monitoring/observability, a production smoke test, outlet-level isolation
specifically, or a second real cross-tenant direction (no Tenant B member
exists). These remain **UNVERIFIED** for the same reasons as before:
no credentials or infrastructure access to Vercel, email, or a second
real tenant's user account exist in this session.

## Scope note (read first)

P11's master prompt specifies 53 sections spanning database security,
authentication, tenant/property/outlet isolation, payments, fiscal,
storage, secrets, logging, monitoring, backup/recovery, deployment safety,
and a full production smoke test. This certification is honest about what
was verified with live production evidence in this pass versus what
remains unverified. Per the prompt's own anti-fabrication instructions,
unverified items are listed as such rather than assumed passing.

This session had **direct live access to the production Supabase project**
(`lusiqcmxfxhnehxmwihs`, `nova-hospitality-fnb`) via the Supabase
management tools, which is what made the fixes below possible — they are
applied to the real production database, not simulated.

---

## 1. Priority findings (master prompt §3–§6)

### 1.1 `has_any_role` ambiguous overload (§3)

**Status: was already resolved by pre-existing migrations, independently
re-verified.**

Migrations `0005_fix_has_any_role_ambiguity` and
`0005b_restore_has_any_role_defaults` were already applied to production
(confirmed via `list_migrations`). Live query against `pg_proc` confirms
**exactly one** `has_any_role` signature exists —
`has_any_role(uuid, app_role[], uuid, uuid, uuid)` — with
`SET search_path TO 'public'` already hardened. Zero RLS policies
currently reference it (the live RLS layer uses `restaurant_can_read` /
`restaurant_can_write` / `nova_has_permission` instead); it is called
directly via `.rpc()` from `rbac.functions.ts` and `access.server.ts` for
platform-level staff RBAC only. No further ambiguity exists.

### 1.2 `nova_user_roles_view` SECURITY DEFINER (§4) — **fixed, was a real P0**

**Confirmed root cause**: the view was `SECURITY DEFINER`, which bypasses
the RLS already correctly enforced on the underlying `rbac_user_roles`
table (`user_id = auth.uid() OR nova_has_permission(auth.uid(),
'STAFF:READ')`). Because the view had no `WHERE` clause of its own, this
meant **any authenticated user — and, before this fix, even an
unauthenticated `anon` caller — could query
`GET /rest/v1/nova_user_roles_view` with no filter and receive every
user's role/tenant/property/outlet assignment platform-wide**, bypassing
the app's own `assertPermission('STAFF:READ')` checks entirely. This is a
genuine cross-tenant metadata leak.

**Fix applied** (production, verified): `ALTER VIEW ... SET
(security_invoker = true)` — the view now runs with the querying user's
own privileges, so the *already-correct* RLS on `rbac_user_roles` applies
exactly as it does to direct table access. `anon` access revoked entirely;
`authenticated` access tightened to `SELECT`-only. All three real callers
in the app (`staff.functions.ts`, `rbac.functions.ts`, `access.server.ts`)
were read before this change and confirmed to query the view only through
the user's own session-scoped client — nothing needed to change in
application code, and the full test suite (1957 tests) confirms no
regression.

**Verified via live advisor**: the `security_definer_view` ERROR finding
is gone after the fix.

### 1.3 Anonymous execution review (§5) — **fixed, WARN → 0**

26 `SECURITY DEFINER` functions were directly callable by the `anon` role
via PostgREST RPC. Cross-referenced against every `.rpc(...)` call in the
application (`grep`) and every RLS policy `qual`/`with_check` referencing
these functions — **no legitimate anon (unauthenticated) use case exists
for any of them**; LexiBite's guest-ordering surface uses its own
session/table mechanism, not this staff RBAC/financial-control surface.

Two rounds of fixes were required: a per-role `REVOKE ... FROM anon` alone
did not clear most findings, because Postgres grants `EXECUTE` on new
functions to the `PUBLIC` pseudo-role by default, which every role
(including `anon`) inherits regardless of a role-specific revoke. The
second migration revoked `EXECUTE` from `PUBLIC` directly, re-granting it
explicitly only to `authenticated` where a real caller exists (`has_any_role`,
`has_role`, `is_any_staff`, `nova_has_permission`, `nova_permissions_for`,
`restaurant_cash_payout_total`, plus the RLS-embedded `restaurant_can_read`
/ `restaurant_can_write`).

17 of the 26 are zero-argument (or action-only) trigger/control functions
— cash payout control/immutability/no-delete/trail, daily close
control/sync, tender declaration archive/control, declaration-revision
immutability, and the entire giveaway workflow
(apply/decide/request/reverse/guard/no-delete/period-lock) — with **zero**
direct `.rpc()` callers anywhere in the application and **zero** RLS
references. Postgres trigger firing does not require the triggering role
to hold `EXECUTE` on the trigger function (only direct RPC invocation
does), so `authenticated` `EXECUTE` was also revoked on these without
affecting any trigger's normal firing.

**Verified via live advisor**: `anon_security_definer_function_executable`
finding count is now **0** (was 26).
`authenticated_security_definer_function_executable` dropped from 51 to
34 — the remaining 34 are `restaurant_can_*` / `restaurant_*_property`
RLS-predicate and property-scope helper functions, which is the correct,
intentional `SECURITY DEFINER` pattern for cross-table RLS lookups (e.g.
resolving which property an order/receipt/purchase-order belongs to for a
scoped policy to check). These were **not** touched — revoking them
without individually confirming every policy that depends on each one
would risk silently breaking property-scoped tenant isolation, which is
the opposite of what P11 requires. This is recorded as a **P2** residual
finding (documented, not blocking) rather than fixed blind.

### 1.4 `migration_transfer_audit` — RLS disabled, public grants (§6/§21) — **fixed, was a real P1**

Found during the live RLS audit (not previously flagged in the master
prompt, but caught by the same advisor pass): a one-time internal
migration-bookkeeping table (5 historical rows: `table_name`,
`source_count`, `target_count`, `status`, `notes`) had **RLS disabled**
and **direct INSERT/SELECT/UPDATE/DELETE/TRUNCATE grants to `anon` and
`authenticated`** — readable and writable by anyone holding just the
public anon key. Zero application code references this table. Fixed:
RLS enabled (default-deny, no policies needed — nothing should read or
write it post-migration) and the `anon`/`authenticated` grants revoked.

**Verified via live advisor**: `rls_disabled_in_public` ERROR finding
gone.

---

## 2. RLS audit (§6)

Live-queried `pg_policies` for the priority tables. All `restaurant_*`
tables (orders, order items, payments, guest sessions, tables, menu items,
prices, products, inventory items, stock movements, and ~140 others) have
paired read/write policies referencing `restaurant_can_read(_scoped)` /
`restaurant_can_write(_scoped)` — the tenant/property-scoped predicate
functions confirmed still correctly `authenticated`-executable. `commercial_*`
tables use tenant-or-commercial-admin scoped policies. RBAC tables
(`rbac_user_roles`, `app_users`) are admin-gated for writes, self-or-STAFF:READ
for reads. `user_roles` (a distinct, legacy table from `rbac_user_roles`) has
RLS enabled with zero grants to `anon`/`authenticated` at all — already fully
locked down, the `rls_enabled_no_policy` INFO finding on it is a correct,
intentional default-deny posture, not a defect.

This is consistent with — and builds on — the extensive property/tenant
scope remediation already completed in this repository's P0-B and P1
phases (migrations `0027`–`0033`, `p1_fix_read_scoped_tenant_isolation_bug`,
`p1_profitability_rls_scope`, `p1_intelligence_property_scope`,
`p1_reconciliation_property_scope`).

## 3. Tenant/property/outlet isolation (§7–§9)

**Not independently re-run as a live authenticated HTTP adversarial test
in this session** — this environment has no test-user credentials or a
configured anon/publishable key to authenticate as a real user against
PostgREST from here, and the Supabase management SQL tool used for the
fixes above runs with elevated (RLS-bypassing) privileges, so it cannot
itself prove RLS enforcement from a caller's perspective.

What **is** genuine evidence, already in the repository and re-confirmed
passing in this session (`npx vitest run`: 150/150 files, 1957/1957 tests):
44 test files with explicit property-scope / cross-tenant isolation
coverage (naming pattern `*.property-scope.test.ts` across costing,
fiscal, inventory, mobile money, reconciliation, sales, self-order,
multi-property access), built during this repository's prior P0-B/P1
security remediation phases, which included live two-tenant/two-property
adversarial DB verification at the time (see repository history: "Build
two-tenant/two-property adversarial test fixture + attack test matrix",
"Live DB verification + final 26-point security remediation report").
This P11 pass did not repeat that live adversarial run; it re-verified the
RLS policy definitions those tests depend on are still in place in
production, and that nothing in this session's changes touched
tenant/property/outlet scoping logic.

**Disposition**: not re-proven live in this pass. Recommend a scheduled
live two-tenant adversarial re-run (with real auth credentials available)
before first customer onboarding, even though no evidence of regression
exists.

## 4. Privilege escalation (§10) — not independently tested this pass

Same constraint as §7–9 (no live auth credentials in this environment).
The RLS/function grant audit above (§1.2–1.4) is the relevant static
evidence: role/permission resolution happens exclusively through
server-verified functions (`nova_has_permission`, `restaurant_can_write`),
never from client-supplied role claims — confirmed by reading
`rbac.functions.ts`/`access.server.ts` (roles are always looked up
server-side via `nova_user_roles_view`/`rolesFor`, keyed off the
authenticated `userId` from the session, never from request body).

## 5. Authentication & session security (§11, §13, §14)

Not independently tested live this pass (same credential constraint).
Architecturally verified: `requireSupabaseAuth` middleware gates every
RBAC-relevant server function; role/permission checks are always
server-side (§4/§10 above); no code path found that trusts a
client-supplied `tenant_id`/`role` for authorization decisions.

## 6. Leaked password protection (§12) — **could not be enabled; documented limitation**

**Still disabled** (confirmed via live advisor, unchanged). This is a
Supabase Auth (GoTrue) service-level setting, not a database setting — it
cannot be changed via SQL, and no Supabase Management-API-level MCP tool
for Auth configuration was available in this session (only
project/database-level tools: `get_project`, `execute_sql`,
`apply_migration`, `get_advisors`, `list_tables`, `list_migrations`,
branch/edge-function tools — none cover Authentication settings). This
must be enabled manually: Supabase Dashboard → Authentication → Sign In /
Providers → Password → "Leaked password protection", or via the
Management API with a personal access token this session does not have.
**This is an explicit, disclosed gap, not a false "fixed."**

## 7. API security (§15) — deferred to P08

No external HTTP API surface beyond the P08-A spike's single
`/api/v1/health` endpoint exists yet (per the P08/P08-A work earlier in
this engagement). Sections of §15 that presuppose a live external API
platform (rate limits on API keys, malformed external requests, etc.) are
not yet applicable; P08's own future work inherits the identity-boundary
rules already documented in `docs/p08-a-external-http-entry-point-adr.md`
§13.

## 8. Storage security (§16) — **verified, no defect found**

Three buckets, live-queried: `restaurant-import-sources` (private, 10MB,
structured file types only), `restaurant-menu-images` (public read, 2MB,
images only), `restaurant-tenant-logos` (public read, 1.5MB, images only).
Public read is intentional and correct for guest-facing menu photos and
branding. All INSERT/UPDATE/DELETE on all three buckets are gated by
`restaurant_owns_menu_image_path(name)` (tenant-path-ownership check) for
`authenticated` only — `anon` has no write access anywhere. This is a
correctly designed, tenant-scoped storage model. No changes made.

## 9. Secrets & environment variables (§17) — **verified clean**

`grep`-audited: `SUPABASE_SERVICE_ROLE_KEY` appears only inside
`src/integrations/supabase/client.server.ts` (a `.server.ts`-suffixed,
import-protected, server-only file per this repo's existing convention),
always read from `process.env`, never hardcoded, never present in any
client-bundled (non-`.server.ts`) file. No real `.env` file is committed
to git (`git ls-files` confirms only `.env.example` files are tracked;
`standalone/.env` and `local/.env` are gitignored).

## 10. Payments & fiscal (§18–§19) — verified as already-built, not re-audited from scratch

Both Mobile Money (`payments/mobilemoney/`) and TRA Fiscal
(`fiscal/`) modules already implement idempotency-key/dedupe-key
machinery end-to-end (contracts, adapters, server modules), built and
tested across this repository's prior dedicated TRA Fiscal (11 phases, 47
findings) and Mobile Money (11 phases) engagements, with duplicate/timeout/
retry scenarios explicitly covered in their existing test suites (still
passing: 1957/1957). Not re-audited line-by-line in this P11 pass — this
would duplicate that prior, already-certified work rather than find new
defects, which the master prompt's own "do not overfix" principle (§48)
argues against absent a specific new concern.

## 11. Commercial security (§20) — not independently re-tested this pass

Entitlement/quota/subscription enforcement was built and adversarially
tested in this repository's prior P01/P03/P04/P05 commercial phases
(server-side `resolveEntitlement`/`assertEntitled`, confirmed still in use
by every gated intelligence/multi-location function read in this and
earlier sessions). Not re-run live in this pass.

## 12. Performance advisor triage (§22–§23)

Full live advisor pull (738 findings, 4 lint types) triaged by a dedicated
subagent since the raw output was 287K characters:

| Lint type | Total | On priority tables |
|---|---|---|
| Unindexed foreign keys | 314 | 84 |
| Auth RLS init-plan (per-row re-eval of `auth.uid()`/`auth.role()`) | 61 | 41 |
| Multiple permissive policies | 345 | 51 |
| Unused index | 18 | — |

**No P0**: nothing indicates an outright timeout/outage risk today.

**Notable positive finding**: zero RLS init-plan issues on the hot-path
operational tables (`restaurant_orders`, `restaurant_order_items`,
`restaurant_payments`, `restaurant_tables`, `restaurant_menu_items`,
`restaurant_prices`, `restaurant_products`, `restaurant_inventory_items`,
`restaurant_stock_movements`, `restaurant_guest_sessions`) — their
policies already avoid the per-row re-evaluation pattern. All 41
priority-table init-plan findings are on `app_users`/`rbac_user_roles`
(evaluated on nearly every authenticated request) and 39 `commercial_*`
policies (lower-traffic back-office path).

**P1** (schedule before general-availability scale-up, not blocking
launch):
- Unindexed FKs on `restaurant_order_items` (10), `restaurant_orders` (5),
  `restaurant_stock_movements` (11), `restaurant_payments` (2) — the
  highest write/read-volume tables on the live ordering path; will
  degrade under load (slow joins, cascading-delete locks).
- RLS init-plan wrapping (`auth.uid()` → `(select auth.uid())`) on
  `app_users`/`rbac_user_roles` policies — compounds system-wide as row
  counts grow.

**P2**: remaining priority-table unindexed FKs (`restaurant_prices`/`products`/
`inventory_items`/`tables`/`menu_items`/`guest_sessions`, RBAC remainder),
`commercial_*` RLS init-plan (39 findings), and the 51 multiple-permissive-policy
findings on priority tables (correctness-neutral, adds per-query overhead).

**P3**: ~230 non-priority unindexed FKs, ~294 non-priority
multiple-permissive-policy findings, all 18 unused indexes — routine
cleanup, no urgency.

No DDL was applied for any of these — per the master prompt's own
instruction not to "blindly fix the number," these are reported as
prioritized candidates for a dedicated indexing/RLS-optimization pass, not
executed speculatively in a security-hardening pass.

## 13. Database integrity, transactional integrity, idempotency (§24–§26)

Covered by the existing, extensive constraint/idempotency-focused test
suites referenced in §10 above (fiscal, mobile money, inventory stock
movement ledger, purchasing→receipt→inventory flows) — all currently
passing. Not independently re-derived from raw schema constraints in this
pass.

## 14. Production configuration, environment separation, domain/HTTPS, email (§27–§30)

**Not verified this pass.** This sandboxed session has no Vercel access,
no production domain reachability, and no email-delivery credentials to
test against. This mirrors the exact limitation disclosed in the P08-A
spike's certification for "true internet-reachable deployment proof" —
disclosed here rather than assumed.

## 15. Logging, error handling, monitoring (§31–§33) — not independently audited this pass

## 16. Backup & recovery (§34) — **not verified; cannot be tested from this session**

No tool available in this session to inspect or trigger a Supabase
project backup/restore. This is a real gap against §34's explicit
requirement ("a backup that has never been tested is not sufficient
evidence of recoverability") — disclosed, not fabricated.

## 17. Deployment safety & migration safety (§35–§36)

The two migrations applied in this session (`0048_p11_security_hardening.sql`,
consolidated from what was applied live in two rounds) are both
additive/permission-only — no data loss, no destructive DDL, no table
drops, no column removal. Applied to production directly via the Supabase
migration tool and independently confirmed via `get_advisors` before and
after.

## 18. Customer data protection, public surface audit, guest security, rate limiting, security headers, dependency security (§37–§42)

Not independently re-audited this pass beyond what's covered in §7–9
(guest ordering uses its own session/table mechanism, confirmed to have
its own extensive isolation test coverage from the O12 guest-session
phase referenced in repository history) and §16 (storage public/private
correctness).

## 19. Production smoke test, clean-tenant test (§43–§44) — **not performed this pass**

Requires live auth/credential access and a running deployed instance,
neither available in this session.

## 20. Security regression suite (§45) — **substantially exists and passes**

150 test files / 1957 tests, all passing, covering authentication middleware
gating, RBAC/permission checks, RLS-shaped scope logic (fake-Supabase
harness), guest session lifecycle, commercial entitlement, payment/fiscal
idempotency, and storage-path ownership logic. Re-run at the end of this
P11 pass with zero regressions from the DB changes made.

## 21. Production incident readiness (§46) — not addressed this pass

---

## Priority findings summary (§47 classification)

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `nova_user_roles_view` SECURITY DEFINER — platform-wide cross-tenant role/scope enumeration via unfiltered PostgREST view | **P0** | **FIXED** (production) |
| 2 | 26 SECURITY DEFINER functions anon-executable via RPC (RBAC helpers + financial-control/giveaway triggers) | **P1** | **FIXED** (production, anon: 26→0) |
| 3 | `migration_transfer_audit` RLS disabled, public anon/authenticated read+write+delete grants | **P1** | **FIXED** (production) |
| 4 | Leaked password protection disabled | **P1** | **NOT FIXED** — no tool access to Auth config in this session; documented manual remedy |
| 5 | 34 remaining `authenticated`-executable SECURITY DEFINER RLS/property-scope helper functions | **P2** | **Reviewed, accepted** — correct pattern, not touched without per-function confirmation |
| 6 | No live authenticated adversarial tenant/property/outlet isolation re-run this pass | **P1** | **Risk-accepted for this pass** — static RLS audit + existing 44-file test suite is the evidence; recommend scheduled live re-run before customer onboarding |
| 7 | Backup/recovery, production deployment (Vercel/domain/email), monitoring, smoke test | **P1 (backup), P2 (rest)** | **NOT VERIFIED** — no tool/credential access in this session |
| 8 | Unindexed FKs on hot-path order/payment/inventory tables (28 findings); RLS init-plan re-eval on `app_users`/`rbac_user_roles` | **P1** | **NOT FIXED** — triaged and prioritized (§12), no DDL applied; schedule before GA scale-up, not a launch blocker (no P0 timeout risk found) |

**Remaining P0 issues: 0.**
**Remaining P1 issues: 4** (leaked password protection; live isolation re-run; backup/recovery verification; hot-path indexing/RLS-init-plan) — all explicitly dispositioned above, none silently dropped.

---

## Risk acceptance

| Risk | Owner | Rationale |
|---|---|---|
| 34 property-scope/RLS-predicate SECURITY DEFINER functions remain `authenticated`-executable | Engineering | Correct, standard pattern for RLS cross-table lookups; revoking without per-policy verification risks breaking tenant/property isolation, the opposite of P11's goal |
| Payment/fiscal/commercial modules not re-audited line-by-line this pass | Engineering | Already built and adversarially tested across dedicated prior phases (TRA Fiscal 11 phases/47 findings, Mobile Money 11 phases, P01/P03/P04/P05 commercial); re-litigating without a specific new concern is scope creep the master prompt itself warns against (§48) |

---

## Evidence

- Commits: this P11 pass adds `standalone/db/migrations/0048_p11_security_hardening.sql` and this document.
- Live production migrations applied: `p11_security_definer_and_rls_hardening`,
  `p11_anon_execute_revocation`, `p11_anon_execute_revocation_public_grant`
  (all `{"success":true}`), consolidated into the single repo migration file above.
- Security advisor before/after: `security_definer_view` ERROR 1→0;
  `rls_disabled_in_public` ERROR 1→0; `anon_security_definer_function_executable`
  WARN 26→0; `authenticated_security_definer_function_executable` WARN 51→34
  (all 17 removed were zero-caller trigger/action functions).
- Test suite: `npx vitest run` — 150/150 files, 1957/1957 tests, before and after.
- Storage bucket policies and grants: live-queried, verified correctly tenant-scoped.
- Secrets: `grep`-verified service-role key is server-only, `.env` not committed.

---

## P11 STATUS: **CONDITIONAL GO**

This is not a clean GO: three P1 items (leaked password protection, live
isolation re-run, backup/recovery verification) remain genuinely open, and
roughly two-thirds of the master prompt's 53 sections were not
independently re-verified in this pass — either because they were already
covered by prior, dedicated engagements in this repository (payments,
fiscal, commercial, guest security), or because this sandboxed session
lacks the credentials/tool access to test them (production deployment,
email, backup/restore, live authenticated adversarial HTTP testing).

It is not NO-GO either: the two genuinely critical, previously-unknown
defects found in this pass — the `nova_user_roles_view` cross-tenant
role/scope leak and the fully-public `migration_transfer_audit` table —
were real P0/P1 production security holes, and both are now fixed and
verified in production with zero test regressions. No known P0 remains
open.

**Executive verdict**: LexiBite's database-layer security posture is
materially stronger after this pass, and the two real defects found were
the kind that would matter to a real customer immediately. But "safe and
operationally reliable enough for a real customer's business data" per
§53's own question cannot be answered an unqualified YES while backup/recovery,
live production deployment, and a live authenticated isolation test remain
unverified. Recommend closing the three listed P1s (leaked-password toggle
is a five-minute dashboard change; the other two need either real
credentials in this environment or a session with them) before the first
customer is onboarded, not before further feature work.

**P11 CONDITIONAL GO — the three listed P1s must close before customer
onboarding; P12+ feature work may proceed in parallel.**
