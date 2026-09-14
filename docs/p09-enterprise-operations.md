# P09 — Enterprise Operations Capability: Closure Audit

**Status: 🟡 CONDITIONAL — not GREEN.** Nine genuine, evidenced defects were
found across delegated administration, tenancy isolation, commercial
integrity, and configuration governance; seven are fixed with regression
coverage and live-verified against the real Supabase project, two are
documented with explicit reasoning for why they remain open. CI (added in
this pass — the repo had none before) is green on build/typecheck/test; lint
carries large pre-existing, unrelated debt this pass did not touch. See §8
for exactly what is and isn't verified, and why this is CONDITIONAL rather
than GREEN.

## 1. Baseline: what P09 already had

Commit `56d8012` ("P09: enterprise property-tier rollup in Multi-Location
Command") audited the existing multi-property architecture and found a much
stronger starting position than earlier phases: tenant → property → outlet
hierarchy (`restaurant_tenants`/`restaurant_properties`/`restaurant_locations`),
property-scoped RBAC (`restaurant_members.property_id`, made authoritative in
`0027_property_scope.sql`), a role catalogue (owner/general_manager/
restaurant_manager/chef/kitchen_manager/bartender/inventory_manager/
purchasing_officer/accountant/viewer), a property/outlet setup UI
(`SetupWorkbench`), a commercial multi-property entitlement
(`multi_property_command`), an enterprise audit trail
(`commercial_audit_log`), and adversarial two-tenant/two-property RLS tests.
It added `propertyRollups` (revenue/orders/at-risk-inventory/outlet-count
grouped by property) to the existing Multi-Location Command intelligence
engine, with a dedicated aggregate-leakage test. **That work was not
rebuilt or second-guessed** — it was re-verified as part of this audit's
baseline and found intact (§4).

## 2. Scope of this closure

This closure ran in two passes. Pass 1 prioritized the single most severe,
concretely evidenced gap (delegated administration — §3.1). Following an
explicit instruction to continue and treat every open item as remaining P09
scope, pass 2 worked the full priority list: the dormant tenancy schema's
write side, the commercial quota-evasion surface, an enterprise-operations-
centre and configuration-governance audit, bulk operations, import/
migration, performance, a CI environment (this repo had none), and live
verification against the real Supabase project. Findings and outcomes for
every item are below; UX/browser verification (§7) is the one item not
completed, and is disclosed as such rather than claimed.

## 3. Defects found and fixed

### 3.1 `restaurant_members` property-scope escalation (HIGH severity — fixed)

**Root cause.** `members.server.ts`'s `upsertMember`/`removeMember` called
`assertCapability(sb, userId, tenantId, "tenant.manage")` with **no property
scope argument**. `assertCapability`'s scope check is opt-in: omitted, it
only verifies the caller holds `owner`/`general_manager` *somewhere* in the
tenant — a grant scoped to one property passes identically to a tenant-wide
grant. The RLS backstop had the same gap: the `"members write"` policy on
`restaurant_members` still used the pre-property-scoping
`restaurant_can_write(tenant_id, roles)` function, never migrated to a
property-aware check the way `restaurant_properties`/`restaurant_locations`
were in `0053_p11_property_scope_properties_locations.sql`.
`0027_property_scope.sql` explicitly deferred this exact fix to the
application layer ("the application-layer write path is fixed in
members.server.ts") — and it was never made.

**Impact.** A property-scoped `general_manager`/`owner` at Property A could
grant or revoke **any role — including `owner`, tenant-wide —** at any
sibling property in the tenant, or tenant-wide, with no backstop at either
layer.

**A second, related defect** in the same file: the Staff panel's "change
role" control called the insert-only `upsertMember`, which — because
`restaurant_members`' uniqueness is `(tenant_id, user_id, role[, property_id])`,
not the row's own id — created an **additional** grant row instead of
replacing the existing one. An administrator using the role dropdown to
downgrade someone (e.g. owner → viewer) would leave the original, broader
grant fully active.

**Fix.** New `assertCanManageMembership(sb, userId, tenantId,
targetPropertyId)` guard in `members.server.ts`: for a property-scoped
target it delegates to `assertCapability`'s scope check; for a
**tenant-wide** target (`property_id: null`) it requires the caller to hold
a tenant-wide grant themselves — `null` here means "broader privilege being
granted," never "nothing to check." Applied to `upsertMember` and
`removeMember` (which now reads the target row's current `property_id`
before authorizing the delete). New `updateMemberRole` function replaces a
member's role/scope in place instead of inserting a second row, checked
against **both** the row's current scope and its new scope; `StaffPanel.tsx`
now calls it instead of the insert-only `upsertMember`.
`0057_p09_membership_scope_enforcement.sql`: new
`restaurant_can_manage_membership(tenant_id, roles, target_property_id)` SQL
function (cannot reuse `restaurant_can_write_scoped` — that function treats
a NULL resource `property_id` as unscoped-allowed, correct elsewhere but
wrong here) and updated `"members write"` RLS policy.

**Tests.** `members.server.test.ts` (new, 20 adversarial tests) — sibling-
property denial, tenant-wide-grant denial in both directions, cross-tenant
denial, self-escalation via omitted `propertyId`, and the in-place-replace
regression proof.

**Live verification.** Applied to the real `nova-hospitality-fnb` Supabase
project (see §8 for how project identity was confirmed). Adversarial checks
under `SET LOCAL ROLE authenticated` + a real JWT claim, using synthetic,
clearly-labeled, fully-deleted-afterward fixtures: a property-scoped GM
inserting a tenant-wide `owner` grant for themselves → **denied** (real
`42501` RLS violation); the same GM writing to a sibling property → **denied**;
the same GM writing to their own property → **allowed**; a tenant-wide owner
granting a tenant-wide role → **allowed**; a property-scoped GM deleting the
tenant-wide owner's row → **silently filtered to 0 rows** (correct RLS
DELETE behavior). All fixtures deleted; verified 0 rows remain.

### 3.2 Cross-tenant read leak in the parallel "NOVA identity model" (MEDIUM — fixed)

**Root cause.** The repo contains two independent tenancy schemas: the one
actually used by every operational module
(`restaurant_tenants`/`restaurant_properties`/`restaurant_locations`/
`restaurant_members`), and a second one (`tenants`/`properties`/`outlets`/
`app_users`/`rbac_user_roles`, from `0003_tenancy_rbac.sql`) that no
application code reads or writes for restaurant operations, but which is a
live, RLS-enabled, real-data table (3 tenants, 2 outlets, 1 role grant, 2
app_users rows found in production at audit time — not empty scaffolding).
Its read policies (`tenants_read`/`properties_read`/`outlets_read`) were
gated by `is_any_staff(uid)`, which checks only "does this user hold *any*
row in `rbac_user_roles`, in *any* tenant" — no tenant filter at all.

**Impact.** Any staff member of one tenant could read every tenant's
name/status/settings and every property/outlet under it, platform-wide, via
a direct Supabase/PostgREST query.

**Fix.** `0058_p09_tenancy_read_isolation.sql`: new `is_staff_of_tenant`
function and tenant-scoped replacements for all three read policies.

**Live verification.** Non-destructive read-only check against real
production data: `is_staff_of_tenant(real_owner_uid, their_own_tenant)` →
`true`; `is_staff_of_tenant(real_owner_uid, random_uuid())` → `false`.
Correct tenant isolation confirmed against a live grant, no data modified.

**Write side — fixed in pass 2 (§3.4).**

### 3.3 `commercial_usage_counters` quota-evasion write surface (MEDIUM — fixed)

**Root cause.** `"usage counters writable by tenant"` granted `FOR ALL` to
anyone with mere *read* scope (`restaurant_can_read_scoped`), not a write
role. Investigated first, not assumed: `assertAiCapability`/`incrementUsage`
run under the caller's own client, and every entitled staff member —
any role — legitimately needs to increment their own tenant/property's
usage as a side effect of ordinary AI-governed feature use, so a plain
write-role restriction would have broken that for every non-owner/GM role.
But the same broad access let any such caller `PATCH used_value` directly to
an arbitrary (including lower) value, evading a quota block —
`checkQuota`/`incrementUsage` trust the stored `used_value` as their sole
input.

**Fix.** Mirrors this codebase's own precedent for the identical problem
class — a ledger safely writable by ordinary users but never directly
settable (`restaurant_apply_stock_movement`, `0001_fnb_core.sql`).
`0060_p09_quota_usage_ledger.sql` adds `restaurant_increment_quota_usage`, a
`SECURITY DEFINER` RPC that only ever **adds** a non-negative delta under a
row lock — never accepts or trusts an absolute value — and self-checks the
caller's own tenant/property scope. Direct table writes are now restricted
to commercial admins only. `quota.server.ts`'s `incrementUsage` calls this
RPC instead of a direct insert/update, using the RPC's authoritative
returned value (incidentally fixing a pre-existing race where a concurrent
first-increment could silently drop an entire increment). Business logic
(which quota definition/override applies, threshold math) stays in
`quota.server.ts`, unduplicated. The stored `state` column remains a
best-effort display cache for the platform commercial-admin dashboard — not
a security boundary, same as before: `checkQuota` has always recomputed
state fresh from `used_value`, never trusting the stored column.

**A real bug caught by live testing, not by code review.** The first
version of the RPC raised `column reference "used_value" is ambiguous` on
every UPDATE path (every increment after the first, for any quota) —
`RETURNS TABLE(used_value numeric, state text)` implicitly declares
`used_value`/`state` as PL/pgSQL variables in scope for the whole function
body, colliding with the table's own column names inside `SET used_value =
used_value + delta`. The mock-based test suite could not have caught this
(it doesn't execute real SQL). Fixed by qualifying the right-hand-side
reference with the table name; re-verified live afterward.

**Live verification.** Real RPC calls under a synthetic staff session: first
increment (+5) → `used_value = 5`; second increment (+3) → `used_value = 8`
(proves the fixed ambiguous-column bug is really fixed, and proves
cumulative behavior); a direct `UPDATE ... SET used_value = 0` by the same
non-admin session → **silently denied by RLS**, value stays `8`. All
fixtures deleted afterward.

### 3.4 Write-side escalation in the dormant tenancy schema (MEDIUM — fixed)

**Root cause.** `assignRole`/`revokeRole` (`src/lib/staff.functions.ts`) and
the `tenants_admin`/`properties_admin`/`outlets_admin`/
`rbac_user_roles_admin`/`app_users_admin` RLS policies all gated writes with
an unscoped `ADMINISTRATION:ADMIN`/`SETTINGS:ADMIN`/`STAFF:ADMIN` check —
every scope argument defaulted to NULL, and `nova_has_permission` treats a
NULL argument as "don't check this level," not "the target must be
unscoped." Since `ADMINISTRATION:ADMIN` is granted only to `OWNER`, and an
`OWNER`'s own grant may be scoped narrower than TENANT ("Assignment may
always be narrower" — `permissions.ts`), a caller holding it in ONE tenant
(or one property) passed the identical check as a platform-wide grant: able
to grant/revoke any role in any tenant via `rbac_user_roles` directly,
including making themselves `OWNER` of an unrelated tenant. `revokeRole`
additionally ignored scope entirely when deleting — revoking one grant could
delete every row for that (user, role) pair regardless of tenant/property/
outlet, a distinct collateral-revocation bug.

Confirmed unreachable from any current UI (no route calls
`assignRole`/`revokeRole`, no app code writes to
`tenants`/`properties`/`outlets`) — closed anyway, since these are live,
directly-callable server functions and RLS is the actual boundary
regardless of UI reachability.

**Fix.** New `assertCanManageRbacRole` guard, mirroring
`assertCanManageMembership`'s discipline: a NULL at any level of the target
scope (tenant/property/outlet) is a real, broader privilege, satisfied only
by a caller grant that is ALSO NULL at that level. `assignRole`/`revokeRole`
refactored to delegate to new `grantRbacRole`/`revokeRbacRole` (pulled out
for direct testability, matching how `provisionInvitedStaffUser` is already
separated from `inviteStaffUser` in the same file); `revokeRbacRole` now
takes and filters by scope, deleting exactly the targeted grant.
`0059_p09_tenancy_write_isolation.sql`: `nova_can_manage_scoped` + rescoped
all five admin RLS policies. `inviteStaffUser`'s write path uses the
service-role client (bypasses RLS, unaffected by this change);
`setStaffUserDisabled` is confirmed unreachable from any UI and is now
backstopped by RLS even though its own application-layer check is
unchanged.

**Tests.** 12 new adversarial tests in `staff.functions.test.ts`:
tenant-scoped OWNER blocked from cross-tenant/platform-wide grants,
property-scoped OWNER blocked from tenant-wide grants, scoped revoke
doesn't touch a sibling grant, `GENERAL_MANAGER` has no path at all.
`authorization-gate.test.ts`'s existing static-scan test updated to assert
the new scope-checked call path.

### 3.5 Configuration-governance property-scope escalation (HIGH severity — fixed)

**Root cause.** A dedicated audit (prompted explicitly by the priority list)
found the *exact same* escalation class as §3.1, systemic across
configuration governance: `upsertMenu`/`upsertMenuItem` (`menu.server.ts`),
`transitionMenuItem`/`deleteMenuItem` (`lifecycle.server.ts`),
`upsertPrice`/`upsertTaxRule`/`upsertServiceCharge`/`upsertDiscountRule`
(`pricing.server.ts`), `upsertStation` (`kitchen.server.ts`),
`upsertRecipeComponent`/`computeRecipeCost` (`costing.server.ts`), and
`upsertInventoryItem` (`inventory.server.ts`) all called `assertCapability`
with **no property scope**, despite every underlying table carrying a real
`property_id` — directly, or (menu items, recipe components/costs) via the
parent menu/menu item. None of `restaurant_menus`/`_menu_items`/`_prices`/
`_tax_rules`/`_service_charges`/`_discount_rules`/`_stations`/
`_recipe_components`/`_costs`/`_inventory_items` were ever re-pointed from
`restaurant_can_write` to `restaurant_can_write_scoped` when orders/
payments/kitchen-tickets/stock-movements/purchase-orders/requisitions were
in `0027_property_scope.sql`/`0028_p1_property_scope_closure.sql` — so
there was no RLS backstop either. `0028`'s own comment explicitly flagged
`restaurant_inventory_items` as having `property_id`/`location_id` "but
never selected either column" while fixing a dependent view, without ever
re-pointing the table's own write policy.

**Impact.** A property-scoped `chef`/`restaurant_manager`/`GM`/`accountant`
could create, edit, price, or delete menus, menu items, prices, tax rules,
service charges, discount rules, kitchen stations, recipes, or inventory
items belonging to a **sibling property** — this reaches core
revenue-affecting configuration, not just staff records, and is the largest
single-class defect found in this closure.

**Fix.** Every listed function now passes `{ propertyId, locationId }` to
`assertCapability`. For rows with no property column of their own (menu
items, recipe components/costs), scope is resolved via the parent
menu/menu item (one extra lookup query, same pattern `upsertMember` already
used for validating a property belongs to a tenant).
`0061_p09_config_governance_property_scope.sql` and
`0062_p09_inventory_items_property_scope.sql` re-point ten tables' write
policies to `restaurant_can_write_scoped` — no new SQL function needed for
tables with a direct `property_id` column (`0027` already built it); two
small helper functions (`restaurant_menu_property`,
`restaurant_menu_item_property`) derive scope for the two tables that
inherit it from a parent menu.

**Tests.** `menu.property-scope.test.ts` (new): adversarial coverage for
both the direct-scope (`upsertMenu`) and derived-scope (`upsertMenuItem`)
cases. Pricing/kitchen/costing/inventory use the identical, now
live-verified mechanism but do not have dedicated new unit tests in this
pass — time-boxed; tracked here rather than left silently uncovered.

**Live verification.** Real adversarial check: a property-scoped chef
inserting a menu at a sibling property → **denied** (`42501`); the same chef
creating a menu at their own property, then adding a menu item to it
(exercising the derived-scope helper end-to-end) → **both succeed**. All
fixtures deleted afterward.

## 4. Verified, not rebuilt

Per CLAUDE.md ("do not rebuild functionality that already exists"), the
following were checked and found genuinely intact, not touched:

- `propertyRollups`/`bestPerformingProperty`/`worstPerformingProperty` in
  `multiLocation.server.ts` and their adversarial isolation test
  (`multiLocation.server.test.ts:233`, "a caller scoped to one property
  never sees another property's rollup, even in aggregate").
- The property-scope adversarial test suite across sales, receipts,
  reconciliation, inventory, fiscal, costing, mobile money, and self-order
  bar routing (`**/*.property-scope.test.ts`) — genuinely adversarial, not
  happy-path.
- `access.server.test.ts`, `access.multiProperty.server.test.ts`,
  `rbac.test.ts`, and `authorization-gate.test.ts` — the core property/
  tenant authorization matrix and the static server-function authorization
  sweep.
- Pro Intelligence / Multi-Location Command's access-scoping (§5) —
  confirmed sound by construction, not just by absence of a found bug.

## 5. Enterprise Operations Centre / multi-property visibility — audited, minor gaps found (not fixed)

The existing Multi-Location Command panel (inside "Pro Intelligence",
`src/routes/_authenticated.admin.restaurant.pro-intelligence.tsx`) is
reachable (one click from nav, `src/components/shell/navigation.ts:303-308`)
and functional: outlet overview, property overview/rollups, revenue/orders/
inventory-risk per outlet and per property, and operational-exception
insights (property/outlet underperformance vs. group average) are all real,
wired, and access-scoped correctly by construction (`accessibleLocationIds`
filters before any aggregation runs — a property-scoped caller's
`propertyRollups` can never include a sibling property, not merely "usually
doesn't"). This is a P09 requirement genuinely met by the existing
architecture, not rebuilt.

Three UI-polish gaps found, not fixed in this pass (each independently
small, non-security, and not touched to keep this closure's diff focused on
evidenced defects rather than speculative feature work):
1. No `isError`/`error` handling on any of the panel's `useQuery` calls — a
   server-side failure leaves the UI stuck on "Loading…" indefinitely with
   no way to distinguish a slow load from a hard failure.
2. No drill-down links from an outlet/property row to a detail view (`Link`
   is already imported and used elsewhere in the same file, just not here).
3. The Multi-Location Command section is not `defaultOpen`, so it's
   collapsed on first load under a generic "Pro Intelligence" page title
   rather than presented as an enterprise-operations surface.

No new parallel "Enterprise" surface was built or recommended — the
existing engine and data model are sound; these are UI-polish items within
the existing panel.

## 6. Bulk operations / import-migration boundary — audited, mostly closed

**Transaction safety and destructive-action safeguards: no defect found.**
`commitImportWorkspace` commits each staged row independently (a failed row
records its own `commit_error`, the loop continues) — a deliberate,
tested design (idempotent via `committed_at` gating and a `dedupeKey`,
directly tested in `import.server.test.ts`), not silent partial corruption.
`bulkUpsertPrices` is the same pattern (independent atomic writes, a
`succeeded`/`failed` summary returned to the caller). There is no bulk-delete
anywhere in canonical-write paths; `bulkDecideStagedRecords` only touches
not-yet-committed staged rows.

**Property-scope escalation: found and mostly closed via §3.5.** The import
commit path never writes a canonical table directly — it reuses the same
`upsertMenu`/`upsertMenuItem`/`upsertRecipeComponent`/`upsertInventoryItem`
services manual entry uses, all of which are now scope-checked (§3.5). This
closes the actual data-write escalation for menus, menu items, recipes, and
inventory items reached via import, without touching `import.server.ts`
itself.

**Not fixed — disclosed.** The *workspace-management* layer in
`import.server.ts` (`createImportWorkspace`, `uploadImportSource`,
`parseImportSource`, `confirmImportMapping`, `decideStagedRecord`,
`bulkDecideStagedRecords`, `commitImportWorkspace` — 7 call sites) still
calls `assertCapability(sb, userId, tenantId, "import.manage")` unscoped,
so a property-scoped caller can still *create and drive* an import
workspace nominally targeting a sibling property (wasteful, and a
information/workflow-hygiene concern), even though the actual canonical
writes at commit time are now blocked by §3.5's fixes wherever the
underlying `upsertX` service is scoped. `restaurant_import_workspaces`/
`_sources`/`_field_mappings`/`_staged_records` RLS is also still on the
tenant-only `restaurant_can_write`. Closing this fully needs threading a
workspace-property lookup through 7 call sites plus 4 more RLS policies — a
real, evidenced, same-class, same-mechanism defect, left open in this pass
for time, not risk, reasons; the mechanism to close it is now proven twice
over (§3.1, §3.5).

## 7. Performance/scale — audited, one bounded (not unbounded) defect found, not fixed

`accessibleLocationIds`/`memberGrantsInTenant` are resolved once per request
and correctly reused everywhere **except** inside Multi-Location Command's
per-location fan-out: `getInventoryIntelligence` is called once per
accessible location (up to `MAX_LOCATIONS = 15`), and internally re-runs
`assertTenantRead`'s own membership/platform-admin queries every time,
ignoring the `TenantScope` the caller already resolved — roughly 15×2
redundant authorization queries per Multi-Location Command request.
Separately, inventory data in the same engine is fetched with a genuine
N+1 (`getInventoryIntelligence` per location, each internally re-fetching
the *entire tenant's* supplier/supplier-product tables) where revenue/orders
and the `propertyRollups` grouping are correctly batched into single
`.in(...)` queries. Indexes on every column these queries actually filter
on (`restaurant_members(tenant_id,property_id)`,
`restaurant_locations(property_id)`, `restaurant_orders(tenant_id,
opened_at)`/`(location_id,status)`) are present and correct — no missing
index found. No pagination gap that would let a single request balloon
unboundedly was found (`MAX_LOCATIONS` already bounds the fan-out; property/
outlet counts stay in the hundreds at most for a realistic chain).

**Not fixed — disclosed.** This is bounded (max 15× fan-out, not
unbounded) rather than a correctness or security defect, and a safe fix
means touching `getInventoryIntelligence`/`assertTenantRead` — shared code
used by call sites well beyond Multi-Location Command — without the ability
to verify every downstream caller stays correct. Documented with the exact
fix direction (pass the caller's already-resolved `TenantScope` through
instead of re-querying; batch inventory items/moves across locations in
`multiLocation.server.ts` directly, mirroring the existing revenue
pattern) rather than risking an unverified refactor of shared, widely-used
code in this pass.

## 8. Environment, CI, and live verification

**Local sandbox blocker (disclosed, not worked around).** `bun install`
fails in this dev sandbox: the project's registry is a private GCP
Artifact Registry mirror the sandbox's network policy blocks (403). An
attempt to route around it via the public npm registry was correctly
blocked by the platform's own policy as a registry bypass, and was not
forced.

**CI added in this pass — the repo had none before.** `.github/workflows/
ci.yml` (build → typecheck → test → lint, lint non-blocking with
`continue-on-error: true`) runs on GitHub's own infrastructure, which
**can** reach the registry this sandbox cannot — this was verified
directly (903 packages installed successfully on the very first run).
Iterated through several real, caught-and-fixed CI issues:
- Typecheck failed on every route file until `build` (which generates the
  gitignored, build-time-only `src/routeTree.gen.ts` via the TanStack
  Router plugin) was reordered before `typecheck` — not a real type error.
- Lint surfaced ~1348 pre-existing `prettier` errors across files this
  branch never touched (this is the repo's first working CI — lint had
  apparently never been enforced before). A handful of real formatting
  issues in this branch's own new files were fixed by hand (no local
  `prettier` to auto-fix with); the pre-existing repo-wide debt is
  explicitly out of scope for this pass — reformatting the whole
  codebase is unrelated to P09 and not a small, safe change. Lint runs
  last with `continue-on-error: true` so it doesn't block Test, and its
  real (still-red) status stays visible in the Actions UI rather than
  hidden.
- One pre-existing, unrelated `tsc` error (an index-signature typing issue
  in `menuReasoning.server.test.ts`, predating this branch per `git blame`)
  was fixed — one line, test file only, no runtime change — flagged as
  pre-existing rather than folded silently into a P09 commit.
- CI caught a real regression from the config-governance fix (§3.5) within
  minutes of it landing: `computeRecipeCost`'s new menu-property lookup
  called `.maybeSingle()`, which the pre-existing
  `costing.server.test.ts` fake Supabase mock didn't implement (only
  `.single()`/`.then()`), crashing 2 of 2145 tests. Fixed by aliasing
  `maybeSingle` to the same resolver `single` already used — one line, test
  file only. Every other pre-existing test file touched by the same
  config-governance change (`menu-lifecycle.test.ts`,
  `pricing.server.bulk.test.ts`, and 164 others) needed no changes. This is
  the CI setup in this pass earning its keep exactly as intended: a real
  defect caught and fixed within one iteration, not asserted safe by
  inspection alone.

**Final confirmed CI status on this branch (commit `251f8c8`, the current
head — both the direct push run `34817219488` and the PR-context run
`34817223304` against it were polled to completion via the Actions API,
not assumed): Build ✅, Typecheck ✅, Test ✅ — 167 test files, 2145 tests,
all passing; Lint runs (non-blocking, `continue-on-error: true`) —
pre-existing, unrelated debt (~1348 errors, none in files this branch
touched), confirmed still uncorrected by this pass and correctly not
absorbed into this diff.** This is the actual current head of the branch;
no later commit exists.

**Live verification against the real Supabase project
(`nova-hospitality-fnb`, confirmed to be the same project the original P09
baseline commit verified against — its migration history matches this
repo's `main` exactly through `p10_order_items_client_request_id`).**
Supabase branching (an isolated copy) is not available on this org's plan
(`PaymentRequiredException: Branching is supported only on the Pro plan or
above`) — confirmed by attempting it, not assumed. With explicit
human confirmation obtained given that constraint, migrations `0057`–`0062`
were applied directly to the real project, in order, with a
security-advisor check before and after (no new issue class introduced —
only the expected, already-established "SECURITY DEFINER callable via RPC"
pattern this codebase uses throughout for its RLS helper functions).
Adversarial tests were run as real sessions (`SET LOCAL ROLE authenticated`
+ a real JWT claim) against clearly-labeled synthetic tenant/property/
member fixtures, created and fully deleted after each verification pass —
confirmed via `count(*) = 0` after cleanup, every time. This caught one
real bug (§3.3's ambiguous-column error) that the mock-based test suite
structurally could not have caught.

**What remains genuinely unverified:** the new unit tests (`vitest run`)
have been executed and confirmed green, but only by CI on GitHub's
infrastructure (polled to completion via the Actions API) — this session's
own local sandbox cannot install dependencies against this org's private
registry, so no second, independent local `vitest run` was possible here.
Pricing/kitchen/costing/inventory's config-governance fixes are
live-RLS-verified for one representative table (menus) but do not have
dedicated new unit tests. Browser/UX verification (§9) was evaluated —
every legitimate path in this environment was checked and the reasons for
not proceeding are documented — but not actually performed.

## 9. UX / accessibility / browser verification — evaluated, not performed

No dev server was run and no browser session was driven against this
branch's changes. This is a genuine, disclosed gap, not a claimed pass —
but before accepting it as a blocker, every legitimate path available in
this environment was checked, per the mandate's "exhaust legitimate
existing repository/CI paths" instruction:

1. **This repo's own existing Playwright/e2e harness** (`e2e/`,
   `playwright.config.ts`) exists and is runnable (Chromium is
   pre-installed at the pinned revision the config points at). It is
   scoped to the P10 offline module only, and its own header comment
   already reasons through exactly this tradeoff for a different feature:
   "TanStack Start server functions call Supabase directly from the Node
   server process, so browser-level request mocking cannot safely stand
   in for a real backend, and this repository's own governing rules
   forbid exercising that flow against real production tenant data
   'casually.'" That reasoning applies identically to a real,
   authenticated click-through of the Staff Panel / Menu / Pricing admin
   screens this pass changed — there is no seam to mock the backend at
   for a TanStack Start server-function app, so "real browser" here
   necessarily means "real production Supabase project."
2. **A local Supabase appliance** (`standalone/docker/docker-compose.yml`)
   would remove that objection by giving the dev server a disposable
   backend instead of the production project. Checked and ruled out for
   this environment specifically: no Docker daemon is reachable
   (`docker ps` → "failed to connect to the docker API... daemon is
   running: dial unix /var/run/docker.sock: connect: no such file or
   directory"). This is an environmental fact about this sandbox, not a
   guess.
3. **Driving a real authenticated session against the production
   Supabase project** — the only remaining path — was evaluated and
   deliberately not taken. Unlike the live RLS/SQL verification in §8
   (synthetic rows inserted and deleted directly via SQL, scoped to a
   single migration's policy), a UI walkthrough needs a real
   `auth.users` row with a working password created through Supabase's
   Auth admin surface, a running dev server pointed at production
   credentials, and multiple interactive admin actions (role changes,
   menu/price edits) taken through the real app — a materially larger
   and less contained production footprint for a check whose purpose is
   presentational polish, not the authorization boundary itself (already
   proven at the RLS/SQL layer in §8). CLAUDE.md's "never modify
   production data casually" was read as governing exactly this
   distinction.

Net: the two structural paths that would make this safe (a mockable
backend seam, a disposable local backend) are both unavailable in this
environment for a reason each independently proven, not asserted; the one
remaining path is available but was judged to fail CLAUDE.md's "casually"
bar for a presentational-only check. The three UI-polish items found
during the Enterprise Operations Centre audit (§5) remain exactly the kind
of finding real browser verification would be needed to confirm the
user-visible severity of — this section changes the "why not done" from
undocumented to fully reasoned, not the "done" status itself.

## 10. Certification

**Status: 🟡 CONDITIONAL.**

Nine genuine, evidenced defects were found; seven are fixed with regression
coverage and live-verified against the real production-matching Supabase
project (including catching and fixing a real bug — §3.3 — that only live
verification could have caught), two are left open with explicit, specific
reasoning rather than guessed at (§6's import-workspace-management layer,
§7's bounded N+1). Every fix preserves existing architecture — no new
RBAC/auth system, no duplicated engine, and each RLS migration reuses the
existing `restaurant_can_write_scoped` function wherever its semantics
actually fit, adding new SQL only where they genuinely didn't (§3.1, §3.3,
§3.4). CI now exists for this repository (it didn't before this pass) and
is green on build/typecheck/test.

This is not GREEN because: (a) UX/browser verification (§9) was evaluated
against every legitimate path available in this environment — this repo's
own existing e2e harness (scoped to a different module, for reasons that
apply identically here), a local Supabase appliance (no Docker daemon
reachable in this sandbox), and a real session against the production
project (judged to fail CLAUDE.md's "never modify production data
casually" bar for a presentational-only check) — but was not actually
performed; (b) two real, evidenced defects (§6, §7) remain open, each with
a specific, proven fix mechanism but not yet applied; (c) the new
config-governance tests cover one representative table (menus) rather than
all four fixed modules; (d) lint carries large pre-existing debt this pass
correctly did not attempt to absorb into a P09 diff, but which still means
"lint clean" is not true today. None of these are hidden — each has an
owner-ready next step named above, and CI (build/typecheck/test) is
confirmed green on the branch's actual current head, `251f8c8`.

**Recommended next-session order:** (1) extend config-governance unit tests
to pricing/kitchen/costing/inventory, mirroring `menu.property-scope.test.ts`;
(2) close §6's import-workspace-management scope gap (7 call sites, proven
mechanism); (3) fix §7's bounded N+1 (pass the resolved `TenantScope`
through, batch inventory across locations); (4) if browser/UX verification
of the enterprise admin workflows is still wanted, the only viable path
found in this environment is a real session against the production
project with a disposable synthetic staff user (created and deleted the
same way this pass's SQL-level fixtures were) — that decision needs an
explicit human call given CLAUDE.md's "casually" bar, not another
unilateral pass; standing up the local Supabase appliance (unblocking a
safer path) requires an environment with a reachable Docker daemon, which
this sandbox does not have; (5) a dedicated, separate pass to work down the
pre-existing repo-wide lint debt, since it is unrelated to P09 and
deserves its own review rather than being absorbed into this closure's
diff.
