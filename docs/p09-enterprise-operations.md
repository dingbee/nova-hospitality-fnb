# P09 — Enterprise Operations Capability: Closure Audit

**Status: 🟡 CONDITIONAL — not GREEN.** Real defects were found and fixed with
regression coverage, but the fixes could not be executed (vitest/typecheck/
lint/build) in this environment, and several mandate sections were not
audited to the same depth as the enterprise-administration security defect
below. This document states plainly what was verified by code review only
versus what remains unverified — see "What blocks GREEN" at the end.

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
rebuilt or second-guessed here** — it was re-verified as part of this
audit's baseline and found intact.

## 2. This pass's scope

Given the size of the full P09 mandate (enterprise hierarchy, delegated
administration, enterprise operations centre, configuration governance,
commercial boundary, adversarial security across every mutation surface,
bulk operations, import/migration, performance, UX/accessibility, full
regression), this pass prioritized the area the baseline audit and this
audit's own research agents converged on as the most severe, concretely
evidenced gap: **delegated administration** — specifically, whether a
property-scoped administrator can actually be prevented from acting outside
their own scope, which is the crux of P09 §2 ("inability to escalate
privileges... inability to assign privileges outside authorised scope").
That investigation surfaced a genuine, exploitable privilege-escalation
defect, which is fixed and tested below. A related cross-tenant read leak in
a second, dormant tenancy schema was also found and fixed. Other mandate
sections were investigated at research-agent depth (see §5) but not carried
through to fixes in this pass; they are listed as open gaps, not silently
dropped.

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
the application or database layer. This is the exact "role assignment...
inability to escalate privileges... inability to assign privileges outside
authorised scope" failure P09 §2 and §7 call out.

**A second, related defect** in the same file: the Staff panel's "change
role" control called the insert-only `upsertMember`, which — because
`restaurant_members`' uniqueness is `(tenant_id, user_id, role[, property_id])`,
not the row's own id — created an **additional** grant row instead of
replacing the existing one. An administrator using the role dropdown to
downgrade someone (e.g. owner → viewer) would leave the original, broader
grant fully active. This is a "safe revocation" / least-privilege failure
(P09 §2).

**Fix.**
- `src/modules/restaurant/core/members.server.ts`: new
  `assertCanManageMembership(sb, userId, tenantId, targetPropertyId)` guard.
  For a property-scoped target, it delegates to `assertCapability`'s
  existing scope check. For a **tenant-wide** target (`property_id: null`),
  it requires the caller to hold a tenant-wide grant themselves — `null`
  here means "broader privilege being granted," never "nothing to check" (in
  contrast to `assertCapability`'s general `ResourceScope` semantics, which
  are correct for resources that simply lack a property field). Applied to
  `upsertMember` and `removeMember` (the latter now reads the target row's
  current `property_id` before authorizing the delete).
- New `updateMemberRole` function + `updateMemberRoleSchema` +
  `updateRestaurantMemberRoleFn` server function: updates the specific
  member row in place (checking authorization against **both** the row's
  current scope and its new scope — moving a grant from a property the
  caller doesn't control, or to a broader scope, is exactly the escalation
  being blocked). `StaffPanel.tsx`'s role dropdown now calls this instead of
  the insert-only `upsertMember`.
- `standalone/db/migrations/0057_p09_membership_scope_enforcement.sql`: new
  `restaurant_can_manage_membership(tenant_id, roles, target_property_id)`
  SQL function and updated `"members write"` RLS policy. It cannot reuse
  `restaurant_can_write_scoped` — that function treats a NULL resource
  `property_id` as "nothing to check," which is correct for tables where
  NULL means "no property field" but wrong here, where NULL is the
  tenant-wide grant itself. The new function never gives a NULL target a
  free pass: writing a tenant-wide row requires a tenant-wide grant.
- `src/modules/restaurant/core/members.server.test.ts` (new, 20 tests):
  adversarial coverage for both `upsertMember`/`removeMember` (existing
  functions, previously **zero** test coverage) and the new
  `updateMemberRole`, including: sibling-property denial, tenant-wide-grant
  denial for a property-scoped caller (both granting and removing), the
  "move FROM a property you don't control" case, self-escalation via
  omitted `propertyId`, cross-tenant denial, and the in-place-replace
  regression proof (exactly one row after a role change, not two).

### 3.2 Cross-tenant read leak in the parallel "NOVA identity model" (MEDIUM severity — fixed)

**Root cause.** The repo contains two independent tenancy schemas: the one
actually used by every operational module
(`restaurant_tenants`/`restaurant_properties`/`restaurant_locations`/
`restaurant_members`), and a second, largely dormant one
(`tenants`/`properties`/`outlets`/`app_users`/`rbac_user_roles`, from
`0003_tenancy_rbac.sql`) that no application code currently reads or writes
(`0034_p01_commercial_architecture.sql` documents the first as "the real F&B
tenancy tree" and the second as reused-nowhere for commercial work). Its
read policies (`tenants_read`/`properties_read`/`outlets_read`) are gated by
`is_any_staff(uid)`, which checks only "does this user hold *any* row in
`rbac_user_roles`, in *any* tenant" — no tenant filter at all.

**Impact.** Any staff member of any one tenant on the platform could read
every tenant's name/status/settings and every property/outlet under it,
platform-wide, via a direct Supabase/PostgREST query — independent of
whether the app's own UI queries these tables. RLS, not "nothing calls it,"
is the actual security boundary (CLAUDE.md: "RLS is part of the security
boundary").

**Fix.** `standalone/db/migrations/0058_p09_tenancy_read_isolation.sql`: new
`is_staff_of_tenant(user_id, tenant_id)` function and tenant-scoped
replacements for all three read policies.

**Not fixed — disclosed.** The *write* side of this same schema
(`tenants_admin`/`properties_admin`/`outlets_admin`/`rbac_user_roles_admin`/
`app_users_admin` RLS policies, and the `assignRole`/`revokeRole` server
functions in `src/lib/staff.functions.ts`) has the identical unscoped
`nova_has_permission(...)` pattern — a tenant-scoped `OWNER` could in
principle write another tenant's rows. This is confirmed **unreachable from
any current UI** (no route/page calls `assignRole`/`revokeRole`, and no app
code writes to these four tables at all), so it carries no live exploitation
surface today, but it is a genuine remaining gap. Closing it correctly means
applying the same both-sides scope-guard pattern used for
`restaurant_members` across five RLS policies and two server functions in a
system with **no existing test coverage** — attempting that without any way
to execute tests in this pass (see §6) would be exactly the kind of
unverified guess CLAUDE.md prohibits. Tracked here as an open P09 defect
rather than silently deferred.

### 3.3 `commercial_usage_counters` — quota-evasion write surface (investigated, not fixed — disclosed)

The RLS policy `"usage counters writable by tenant"` grants `FOR ALL` (not
just read) to anyone who merely has *read* scope on the tenant/property —
`restaurant_can_read_scoped`, not a write-role check. In isolation this
looks like a defect (any staff member could zero out `used_value` to evade
a quota block). Investigation of the actual caller
(`assertAiCapability`/`incrementUsage` in
`src/modules/commercial/ai-governance.server.ts` →
`src/modules/commercial/quota.server.ts`) showed this is **not** an
oversight: any entitled staff member using an AI-governed feature —
regardless of role — needs to increment their own tenant/property's usage
counter as an ordinary side effect of normal use, via the caller's own
request-scoped client. Restricting the policy to a write-role (as was
initially planned) would have broken legitimate quota tracking for every
non-owner/GM role. A correct fix requires moving the increment path behind
a `SECURITY DEFINER` RPC (so direct table tampering is no longer possible
while legitimate increments still work) — a real architectural change
deserving dedicated review, not a rushed policy edit in this pass.
Documented here as a known, open P09 finding.

## 4. Verified, not rebuilt

Per CLAUDE.md ("do not rebuild functionality that already exists"), the
following were checked and found genuinely intact, not touched:

- `propertyRollups`/`bestPerformingProperty`/`worstPerformingProperty` in
  `multiLocation.server.ts` and their adversarial isolation test
  (`multiLocation.server.test.ts:233`, "a caller scoped to one property
  never sees another property's rollup, even in aggregate").
- The property-scope adversarial test suite across sales, receipts,
  reconciliation, inventory, fiscal, costing, mobile money, and self-order
  bar routing (`**/*.property-scope.test.ts`) — all genuinely adversarial
  (attack attempted, denial asserted), not happy-path.
- `access.server.test.ts`, `access.multiProperty.server.test.ts`,
  `rbac.test.ts`, and `authorization-gate.test.ts` — the core property/
  tenant authorization matrix and the static server-function authorization
  sweep.

## 5. Identified but not closed in this pass (open P09 gaps)

Research surfaced these; none were fixed here, and none are claimed closed:

- **No enterprise-level operations surface.** There is no route matching
  `*enterprise*`/a distinct Properties or Outlets admin list — property/
  outlet creation happens only via onboarding (first property/outlet) and
  `SetupWorkbench` (single-property foundation setup). Nav
  (`src/components/shell/navigation.ts`) has no property switcher or
  Enterprise section; the whole shell is built around one active property/
  tenant at a time. P09 §4's "understand the state of the organisation
  without manually visiting every property" is served only by the
  Multi-Location Command intelligence panel (§4 above), not a dedicated
  operations centre.
- **No invite-by-email flow** for adding staff — disclosed directly in
  `StaffPanel.tsx`'s own comments; unchanged by this pass.
- **§3.2's write-side gap** (System B admin policies/`assignRole`/
  `revokeRole`).
- **§3.3's quota-evasion write surface.**
- Configuration governance (menu/pricing/tax/central-vs-property-vs-outlet
  override model), enterprise billing/commercial boundary beyond what §3.2/
  3.3 touch, bulk operations audit, import/migration boundary, performance/
  scale review, and UX/accessibility/browser verification were **not**
  audited to fix-level depth in this pass — only the delegated-
  administration and read-isolation areas were.

## 6. What blocks GREEN

**Verification could not be executed in this environment.** `node_modules`
is incomplete (`vitest`, `tsc`, build tooling absent), and `bun install`
fails: the project's registry is a private GCP Artifact Registry mirror
(`europe-west1-npm.pkg.dev/lovable-core-prod/...`) that returns 403 in this
sandbox, and there is no `.github/workflows/` CI to fall back on for
post-push verification either. An attempt to route the install through the
public npm registry instead was correctly blocked by policy as a registry
bypass, and was not forced. **This means: no test run, no typecheck, no
lint, no production build were executed for this change.** The code above
was written and reviewed by hand against the exact patterns already used in
this codebase (`assertCapability`'s scope semantics, the
`restaurant_can_write_scoped` precedent, existing fake-Supabase test
fixtures), and the new test file's fixture was traced by hand against every
call the real functions make — but that is not a substitute for an actual
run, and this document does not claim it is.

## 7. Certification

**Status: 🟡 CONDITIONAL.**

A genuine, high-severity, previously-untested delegated-administration
escalation was found and fixed with adversarial regression coverage, along
with a related cross-tenant read leak. Both fixes preserve existing
architecture (no new RBAC/auth system, no duplicated engine) and are
minimal, scoped changes. This is real progress toward P09, not a
relabelling exercise. It is not GREEN because: (a) the fixes are unverified
by execution — a genuine, disclosed environment blocker, not a shortcut;
(b) two related defects (§3.2 write-side, §3.3 quota counters) were found
and deliberately left open rather than guessed at; (c) several mandate
sections (enterprise operations centre, configuration governance, bulk
operations, import/migration, performance, UX/accessibility) were not
audited to fix-level depth in this pass. The next session with working
registry access should, in order: run the new test suite and the existing
1957+ regression suite plus typecheck/lint/build against these changes;
then close §3.2 and §3.3; then extend the audit to the remaining §5 items.
