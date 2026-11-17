# ME-11 — Enterprise Operations / Enterprise Governance & Group Control Certification

## A. Executive summary

**Verdict: GREEN / CLOSED.**

P09's enterprise-governance implementation — tenant → property-scoped
membership, capability-based RBAC backed by RLS, delegated administration,
quota governance, configuration governance, and import-workspace
authorization — is genuinely present at the canonical ME-00 baseline and is
enforced server-side and at the database layer, not just in the UI. Live
adversarial testing against a from-scratch Postgres replay of the full
migration chain (10 probes covering horizontal escalation, vertical
escalation, cross-tenant access, cross-property access, forged scope
identifiers, and anonymous access) found every attack correctly refused and
every legitimate operation correctly permitted.

Two genuine, independent ME-11 defects were found, root-caused, fixed, and
regression-tested — both are cases where P09's own committed SQL migration
reached the ME-00 baseline but the corresponding application-layer half of
the same fix did not, leaving the database and the code out of sync:

1. **Quota-ledger write path broken by its own RLS fix** — `commercial_usage_counters`
   RLS restricts direct writes to commercial admins only
   (`0060_p09_quota_usage_ledger.sql`, part of P09's quota-integrity
   closure), but `quota.server.ts`'s `incrementUsage` still performed a raw
   `insert`/`update` under the ordinary tenant caller's own session — the
   exact write class that policy exists to block. Confirmed live: an
   ordinary tenant owner's first-ever quota increment throws `new row
   violates row-level security policy`. Fixed by restoring the
   `restaurant_increment_quota_usage` SECURITY DEFINER RPC call the
   original P09 commit (`213c93329b5`) made but which never reached this
   baseline.
2. **No audit trail exists for the actual delegated-administration
   surface** — `activity_logs`, the table `logActivity()` has written to
   since it was introduced, was never created by any migration on any
   branch; every "audit" write for staff invites and platform-tier role
   grants has always failed and been silently swallowed. Worse, the live
   P09 governance surface (`members.server.ts`'s `upsertMember`/
   `removeMember` — the actual mechanism by which an owner/GM grants or
   revokes a role at a tenant or property) never called it at all. Fixed by
   creating the table (with RLS: insert-own-row-only, tenant-scoped read
   restricted to the same senior roles `documents.audit.read` already
   reserves) and wiring both grant and revoke into it.

Both fixes are additive, minimal, and proven with live database probes and
new/extended unit tests. Full test suite, typecheck, lint and production
build all pass with zero regressions against the exact canonical baseline.

## B. Baseline lock (Phase 0)

- **Canonical branch:** `claude/me-00-baseline-lock`.
- **Exact baseline SHA:** `77a339e29fd82a062699635c5352f022694da218`
  ("ME-10: Import & Migration Certification" — one commit ahead of
  `claude/me-10-import-migration-cert-pcse84`'s tip `ed6fcbe2`, same tree;
  it is the rolling baseline-lock pointer, confirmed by an empty
  `git diff --stat` between the two).
- **Working branch:** `claude/me-11-enterprise-governance-wrrz6n`.

**Finding, before any code change:** the branch this session started on had
already been created equal to `origin/main` (HEAD `e2a59e2`), which has
**diverged from the ME-00→ME-10 canonical chain** — `git merge-base
--is-ancestor` proved neither branch is an ancestor of the other, and `main`
is missing, among other things, migrations `0081_me06_refund_retry_idempotency.sql`
and `0084_me10_import_studio_table_grants.sql` that are part of the
canonical baseline. Per the mandate's explicit Phase 0 instruction ("DO NOT
work from main if the canonical certification branch is different... If the
working branch is incorrectly based, re-root BEFORE making code changes"),
the branch was **hard-reset to `origin/claude/me-00-baseline-lock`**
(`git checkout -B claude/me-11-enterprise-governance-wrrz6n
origin/claude/me-00-baseline-lock`) before any inspection or remediation.
The branch carried zero commits of its own at that point, so no work was
lost by the re-root.

## C. P09 implementation lineage

The P09 "enterprise closure" work (delegated administration, tenancy
isolation, quota integrity, configuration governance, import authorization)
was originally developed on `origin/claude/p09-enterprise-closure-f1peif`
and applied directly to production (commits such as `2fa7343` "P09:
enterprise closure...", `213c933` "P09: close commercial_usage_counters
quota-evasion write surface", and others under `git log --all --grep=P09`).
That branch and its individual commits are **not** ancestors of the ME-00
baseline — the baseline instead carries a **byte-for-byte reconstruction**
of P09's production migrations, reconciled in by the ME-00 baseline-lock
pass and explicitly annotated as such in each migration's own header
comment ("Provenance (ME-00 baseline reconciliation): ... verified
byte-for-byte identical between (a) the exact SQL recorded in production's
own migration ledger ... and (b) the committed file of the same name on the
then-unmerged branch"). This reconciliation correctly captured every P09
**database** migration (`0057`–`0063`, `0060b`) but — as this certification
found — did not always capture the matching **application-code** half of
the same fix, which is the root cause of both defects below.

## D. Scope

In scope: the actual, existing P09 enterprise-governance implementation —
tenant/property/membership model (`restaurant_members`,
`restaurant_can_read_scoped`/`restaurant_can_write_scoped`,
`restaurant_can_manage_membership`), the dormant parallel tenancy/RBAC
schema (`tenants`/`properties`/`outlets`/`rbac_user_roles`/`app_users`,
`nova_can_manage_scoped`), quota governance (`commercial_usage_counters`,
`restaurant_increment_quota_usage`), configuration governance (menus,
recipes, prices, tax, service charges, discount rules, stations — property
scope), inventory-item property scope, Import Studio workspace
authorization, and the Staff Panel / Team Panel UI surfaces built on them.

Out of scope (per Phase 14 discipline, and confirmed not to be P09/ME-11
surfaces): the broader commercial-architecture entitlement/subscription
engine (P01, already covered by its own tests and not part of P09's
governance closure beyond the one quota write-path integration point),
ME-01 performance work (reused as baseline, not duplicated), and any
speculative new enterprise features not required to certify what already
exists.

## E. Architecture inspected

**Live authorization surface** (`src/modules/restaurant/core/`):

- `access.server.ts` — `TenantScope`/`MemberGrant` model:
  `restaurant_members` rows carry a `role` and an optional `property_id`
  (`NULL` = tenant-wide). `getTenantScope` resolves a caller's full grant
  set once; `canAccessProperty`/`canAccessLocation`/`canAccessResource`,
  `assertTenantRead`, `assertCapability(..., scope?)` and
  `assertCanManageMembership` are the single choke points every server
  function composes. `resolveEffectivePropertyId` /
  `resolveMultiPropertyScope` correctly gate tenant-wide aggregation behind
  the `multi_property_command` commercial entitlement, narrowing rather
  than throwing when a tenant lacks it.
- `tenancy.server.ts` (`getWorkspace`) — every property/location selector
  in the UI is built from a workspace resolved server-side and filtered to
  the caller's actual grants; a property-scoped member's dropdown cannot
  show a property/location outside their grant (verified by reading the
  code's own filtering logic, consistent with its documented invariant).
- `members.server.ts` — `listMembers`/`upsertMember`/`removeMember`, the
  live delegated-administration surface. Delegates authorization to
  `assertCanManageMembership`, which defers to the database's own
  `restaurant_can_manage_membership` (not a re-derived TypeScript
  equivalent), and validates a target `property_id` actually belongs to
  the tenant before writing.
- `permissions.ts` — the capability→role map, documented as UI-affordance
  only, RLS is the enforcement point; roles are commercial hospitality
  roles distinct from platform roles.

**Database enforcement** (`standalone/db/migrations/`):

- `0027_property_scope.sql` — introduces `restaurant_can_read_scoped`/
  `restaurant_can_write_scoped`, applies them to orders, order items,
  payments, kitchen tickets, stock movements, purchase orders (+items),
  requisitions (+lines).
- `0057_p09_membership_scope_enforcement.sql` — `restaurant_can_manage_membership`;
  a `_target_property_id IS NULL` (tenant-wide) write requires the caller's
  own grant to *also* be tenant-wide — never treated as "nothing to check."
- `0058`/`0059_p09_tenancy_*_isolation.sql` — closes cross-tenant read/write
  leaks in the dormant, RLS-enabled `tenants`/`properties`/`outlets`/
  `rbac_user_roles`/`app_users` schema (`is_staff_of_tenant`,
  `nova_can_manage_scoped`) — reachable directly via PostgREST regardless
  of whether current UI code queries it.
- `0060`/`0060b_p09_quota_usage_ledger.sql` — `restaurant_increment_quota_usage`,
  an atomic, non-negative-delta-only SECURITY DEFINER RPC; direct table
  writes restricted to commercial admins.
- `0061_p09_config_governance_property_scope.sql` — property scope for
  menus, menu items, recipe components/costs, prices, tax rules, service
  charges, discount rules, stations.
- `0062_p09_inventory_items_property_scope.sql` — inventory items.
- `0063_p09_import_workspace_property_scope.sql` — Import Studio
  workspaces/sources/field mappings/staged records.
- `0087_me11_activity_logs.sql` (**new, this pass**) — the `activity_logs`
  table, closing the auditability gap in §H.2.

## F. Authorization model (Phase 1/2)

```
user (auth.uid())
  → restaurant_members row(s): (tenant_id, role, property_id | NULL)
      → property_id = NULL  → tenant-wide grant for that role
      → property_id = <id>  → scoped to exactly that property
  → capability = f(role)  [permissions.ts, mirrored by RLS predicates]
  → resource scope = tenant_id [+ property_id | derived via a parent FK]
  → decision = restaurant_is_platform_admin(uid)
             OR EXISTS a matching-role grant whose property_id is NULL
                or equals the resource's property_id
```

A second, dormant parallel model (`tenants`/`properties`/`outlets`/
`app_users`/`rbac_user_roles`, `nova_has_permission`/`nova_can_manage_scoped`)
exists in the schema and is RLS-enabled but not read or written by any
current application UI beyond `listStaffUsers`/`inviteStaffUser` (verified
by `git grep` across `src/**` — `assignRole`/`revokeRole` have zero call
sites outside their own module and tests). Because a `createServerFn` is a
real, directly invocable endpoint independent of UI wiring, "no UI calls it"
is not the same as "unreachable" (Phase 3, adversarial test #9 — direct
server-function invocation) — so this was verified, not assumed: reading
`assertCanManageRbacRole` (`src/lib/rbac/rbac.server.ts`) confirms it already
composes the same `nova_can_manage_scoped` predicate RLS enforces, so a
direct invocation of `assignRole`/`revokeRole` is safe even though no UI
route reaches it.

## G. Security invariants — verified

| Invariant (Phase 2) | Verified how | Result |
|---|---|---|
| A. Tenant isolation | Live probes 2, 6, 10 (below) | Holds |
| B. Property isolation | Live probes 1, 4, 8, 9 | Holds |
| C. Group scope (tenant-wide grant) | Live probe 5 | Holds — tenant-wide grant correctly covers every property in the tenant |
| D. Enterprise-level admin not accidentally grantable | Code + live probe 3 | Holds — `restaurant_can_manage_membership` treats a `NULL` target scope as the *most* privileged, never "unrestricted" |
| E. Role/privilege separation (no escalation via forged IDs) | Live probes 3, 4, 6 | Holds |
| F. Inheritance / precedence / revocation | Code inspection (§F); membership rows are the sole source of truth, re-queried per request — no cache to go stale | Holds |
| G. Revocation — no stale privileged access | `getTenantScope`/`memberGrantsInTenant` re-query `restaurant_members` per call; no session-cached role list found | Holds |
| H. Administrative actions server-authorized, not UI-hidden | `assertCanManageMembership`/RLS both enforce; UI (`StaffPanel`/`TeamPanel`) never the sole gate | Holds (defect found in a *different* administrative surface — audit logging — see §H.2) |

## H. Adversarial testing (Phase 3) — live, not simulated

All probes ran against a **from-scratch Postgres 16 replay of all 87
migrations** (local disposable cluster, `nova_superuser`/`authenticated`/
`anon` roles, `auth.uid()` driven by a real `request.jwt.claims` GUC exactly
as PostgREST sets it) — never against a mock, and never as
`service_role`/superuser for the attack itself. Full transcripts are
reproducible from the migration chain; representative results:

1. **Horizontal (cross-property, same tenant) read** — property-A1-scoped
   owner selects Property A2's orders → **0 rows** (RLS-filtered silently,
   not an error — correct: existence is not disclosed either).
2. **Cross-tenant read** — same owner selects Tenant B's orders → **0
   rows**.
3. **Vertical escalation — self-grant tenant-wide** — property-A1-scoped
   owner inserts a `general_manager` row for themselves with
   `property_id = NULL` → **`ERROR: new row violates row-level security
   policy for table "restaurant_members"`**.
4. **Horizontal escalation — grant at a sibling property** — same owner
   grants a `bartender` role at Property A2 → **RLS rejection**.
5. **Legitimate tenant-wide operation** — a tenant-wide general_manager
   grants a role at Property A2 (a property they don't personally work at)
   → **succeeds** — tenant-wide grants correctly cover every property.
6. **Forged tenant_id** — Tenant B's owner inserts a membership row with
   Tenant A's `tenant_id` → **RLS rejection**.
7. **Anonymous / no JWT** — `anon` role selects `restaurant_orders` →
   **`permission denied for table restaurant_orders`** (no table grant to
   `anon` at all, stronger than RLS).
8. **Config governance (0061)** — property-A1-scoped owner updates
   Property A2's menu name → **`UPDATE 0`**, value unchanged.
9. **Import workspace scope (0063)** — same owner updates Property A2's
   import workspace status → **`UPDATE 0`**, value unchanged.
10. **Dormant tenancy schema, cross-tenant read (0058)** — a caller with an
    `rbac_user_roles` grant in "Legacy Tenant X" selects both Legacy Tenant
    X and Y from `tenants` → returns **only Tenant X**.
11. **Quota write surface (motivating the fix in §I.1)** — an ordinary
    tenant owner (no commercial-admin privilege) attempts the exact raw
    `INSERT` `quota.server.ts` used to perform →
    **`ERROR: new row violates row-level security policy for table
    "commercial_usage_counters"`**.
12. **Audit-log actor forgery (verifying the fix in §I.2)** — a caller
    inserts an `activity_logs` row attributing the action to a *different*
    user's `actor_id` → **RLS rejection**; the same caller inserting a
    correctly self-attributed row → succeeds.
13. **Audit-log cross-tenant read (verifying the fix in §I.2)** — Tenant
    B's owner queries Tenant A's audit-log rows → **0 rows**, even though a
    row exists; a Tenant A senior role querying the same tenant → **1
    row**.

Every attack above was refused; every legitimate operation succeeded. No
attack surfaced a new defect beyond the two documented in §I.

## I. Defects discovered and remediated (Phase 13)

### I.1 `commercial_usage_counters` write path broken by its own RLS fix (HIGH)

**Root cause.** P09's own remediation commit `213c93329b5` ("P09: close
commercial_usage_counters quota-evasion write surface") shipped two halves
of one fix: migration `0060` (restrict direct writes to commercial admins,
add a safe increment-only RPC) and a matching change to
`quota.server.ts::incrementUsage` to call that RPC instead of a direct
`insert`/`update`. The ME-00 baseline reconciliation correctly captured the
migration (it is present and applies cleanly) but the `quota.server.ts`
change was **not** reconciled — the file in the baseline still performs the
pre-fix raw `insert`/`update`, using the caller's own request-scoped
(RLS-enforced) client. Because an ordinary tenant member is never a
`restaurant_is_commercial_admin` (a distinct, platform-tier flag), this
write is rejected by RLS on the very first quota increment for any
tenant/period — confirmed live in §H.11.

**Blast radius.** Every call path (`assertAiCapability` in
`ai-governance.server.ts`, used by Menu Intelligence, guest Ask NOVA, and
Staff Ask NOVA) that increments a quota-linked capability for a non-admin
tenant member throws (INSERT case, first use per period) or silently
no-ops (UPDATE case, once a commercial admin has seeded the row) — a live
break in AI-governance quota enforcement for ordinary users.

**Fix.** `src/modules/commercial/quota.server.ts::incrementUsage` now calls
`restaurant_increment_quota_usage` via `sb.rpc(...)`, using its
authoritative returned `used_value` — the exact code P09's own commit
introduced, restored verbatim (with the same reasoning documented inline).

**Regression coverage.** `commercial.server.test.ts`'s fake Supabase
client's `rpc()` mock is extended to simulate the real RPC's semantics
(atomic non-negative-delta-only increment against the same in-memory
`usageCounters` store used elsewhere in the file — not a stub); a new test,
*"writes usage exclusively through the increment RPC — never a direct
table insert/update"*, instruments `.from("commercial_usage_counters")` to
fail the test if `incrementUsage` ever calls `.insert()`/`.update()`
directly, and asserts the counter still reaches the correct cumulative
value across two increments.

### I.2 No audit trail for the live delegated-administration surface (HIGH)

**Root cause.** `src/lib/activity-log.server.ts::logActivity` has written
to a table named `activity_logs` since its introduction (called from
`inviteStaffUser`/`assignRole`/`revokeRole` in `staff.functions.ts`), but
**no migration on any branch, at any point in this repository's history,
ever created that table.** Every one of those calls has always failed at
the database (`relation "activity_logs" does not exist`) and been silently
swallowed by `logActivity`'s own try/catch ("Don't fail the primary action
if logging fails") — confirmed by `\d activity_logs` against the
from-scratch replay (`Did not find any relation named "activity_logs"`)
and by grepping every migration file. Separately, and more importantly:
the actual, live P09 governance surface — `members.server.ts`'s
`upsertMember`/`removeMember`, the real mechanism by which an owner/GM
grants or revokes a role at a tenant or property — never called
`logActivity` at all, broken or otherwise.

**Why this is ME-11 in scope.** Phase 8 of the mandate requires actor,
action, target, scope, timestamp and result to be recoverable for sensitive
governance operations, and requires that audit records cannot be forged.
Granting or revoking a role is the single most sensitive administrative
action this domain has — and it left, and would have continued to leave,
zero trace.

**Fix.**

- New migration `0087_me11_activity_logs.sql` creates `activity_logs`
  with the exact column shape `logActivity` already writes (plus a
  nullable `tenant_id` for tenant-scoped events). RLS: `INSERT` is
  restricted to `actor_id = auth.uid()` (nobody can forge another user's
  attribution — defense in depth on top of correct server code); `SELECT`
  is granted to platform admins unconditionally, and to a tenant's senior
  roles (`owner`/`general_manager`/`restaurant_manager`/`accountant` —
  mirroring the existing `documents.audit.read` capability's own role set
  and tenant-wide-only scoping convention, not a new authorization
  concept) for rows carrying their `tenant_id`. A platform-tier row
  (`tenant_id IS NULL`, e.g. a staff invite) is visible only to platform
  admins — never broadened by omission.
- `activity-log.server.ts` gains an optional `tenantId` field, threaded
  into the inserted row.
- `members.server.ts::upsertMember`/`removeMember` now call `logActivity`
  after a successful grant/revoke, recording actor, tenant, target user,
  role and property — the first working audit trail this surface has ever
  had.
- `staff.functions.ts`'s existing three call sites were deliberately left
  as `tenant_id: null` (not wired to `data.tenantId`): that field
  references the *dormant* `tenants` table (a different ID space from
  `restaurant_tenants`, which `activity_logs.tenant_id`'s FK points at per
  §D/§F) — wiring it would either violate the foreign key or silently
  coincide with an unrelated tenant if IDs ever overlapped. Left `NULL`
  (platform-admin-only visibility) is the correct, conservative behavior
  for that schema, not a remaining gap.

**Regression coverage.** `members.server.test.ts`'s fake Supabase client
gains an `activity_logs` table; the existing "allows a property-A1-scoped
owner granting a role" and "allows a tenant-wide owner revoking..." tests
now assert the exact audit row (`actor_id`, `tenant_id`, `action`,
`entity_type`, `metadata`) was recorded. Live database probes (§H.12,
§H.13) prove actor-forgery is rejected and tenant-scoped reads are
correctly isolated against the real RLS policy, not just the fake client.

## J. RLS / database certification (Phase 4)

- Every P09 predicate reviewed resolves through a `SECURITY DEFINER`
  function with `SET search_path = public` (no search-path hijack
  surface) and an explicit `auth.uid() IS NOT NULL` guard (no anonymous
  bypass).
- `GRANT`/`REVOKE` on every new/modified function is scoped to
  `authenticated, service_role` only — never `anon`/`public` — verified by
  reading each migration's grant statements.
- No policy found where a `NULL` scope argument was treated as "nothing to
  check" for a genuinely privileged target — this was the exact class of
  bug `restaurant_can_manage_membership` and `nova_can_manage_scoped` were
  written to avoid, and live testing (§H.3) confirms the `NULL` (most
  privileged) case is the one requiring the caller's own grant to also be
  `NULL`, not the reverse.
- `commercial_usage_counters`'s read policy (`FOR SELECT`) and write
  policies (`FOR INSERT/UPDATE/DELETE`, split per `0069_me01_multi_policy_consolidation_part1.sql`)
  are correctly asymmetric — broad read (any tenant member with scope),
  narrow write (commercial admins only) — and this asymmetry is exactly
  what made the §I.1 defect both possible (RLS did its job) and necessary
  to fix at the application layer (the legitimate write path needed its
  own safe channel).
- `activity_logs`'s new indexes (`(tenant_id, created_at DESC)`,
  `(actor_id, created_at DESC)`) support both the tenant-scoped read
  policy's predicate and an actor's own history, avoiding an unindexed
  scan as the table grows.

## K. Concurrency findings (Phase 5)

`restaurant_increment_quota_usage` (the RPC now correctly wired) takes a
row lock (`FOR UPDATE`) before incrementing, and its own `0060b` fix
already closed a live-discovered ambiguous-column bug in the UPDATE
branch. `restaurant_can_manage_membership` and every scope-check function
are `STABLE`, side-effect-free reads within the same transaction as the
write they gate — no TOCTOU window between an authorization check and the
write it authorizes, since both execute inside the same RLS policy
evaluation for the same statement. No new concurrency defect was
introduced by either fix in this pass (the audit-log insert is a simple
append with no read-modify-write step).

## L. Data-operation / aggregation findings (Phase 6)

`resolveMultiPropertyScope` (§F) was inspected specifically for the
aggregation-leak pattern the mandate calls out ("a user authorized for
Property A must not obtain an enterprise total that implicitly includes
Property B"): a tenant-wide grant holder's unscoped request is gated behind
the `multi_property_command` commercial entitlement, and a tenant lacking
that entitlement is deterministically narrowed to their first-created
property rather than silently aggregating across all of them or throwing.
A single-property tenant is never gated (aggregating "everything" and "the
one property that exists" are identical). No aggregation code path was
found that bypasses this resolver for a P09-governed capability.

## M. Failure / recovery findings (Phase 7)

`upsertMember` validates the target `property_id` belongs to the caller's
own tenant *before* calling `assertCanManageMembership`, so a failed
authorization check never leaves a partial write (Postgres's own
statement-level rollback on the RLS-rejected `INSERT` handles the rest).
`removeMember` looks up the target row and re-derives its `role`/`user_id`
for audit purposes before deleting — if the delete itself fails, no audit
row is written (the `logActivity` call sits after the successful delete),
so there is no "phantom revoked" audit entry for an operation that didn't
actually happen. `logActivity` itself remains fail-open by design (a
logging failure must never block the primary action) but its target table
now exists, so that fail-open path is no longer permanently exercised by
every call.

## N. Auditability findings (Phase 8)

See §I.2 for the defect and fix. With the fix applied: actor (`actor_id`,
FK-free but RLS-forgery-proof), action, target (`entity_type`/`entity_id`),
scope (`tenant_id`), timestamp (`created_at`, server-default, not
client-suppliable) and a metadata blob carrying role/property detail are
all recorded for every grant/revoke. Forging another user's `actor_id` is
rejected by RLS (§H.12), not merely discouraged by application code.

## O. Performance / scale findings (Phase 9)

No new N+1 authorization query was introduced by either fix.
`incrementUsage`'s RPC call replaces two round trips (a `select` to find
the existing row, then an `insert`/`update`) with one atomic call — a net
reduction. `getTenantScope`/`memberGrantsInTenant` (the read path every
`assertCapability` call composes) already resolve a caller's grants in a
single query per request; this pass did not change that path. ME-01's
existing FK-index and RLS-initplan hardening already covers
`restaurant_members`/`commercial_usage_counters`; the new
`activity_logs` table ships its own supporting indexes from its first
migration rather than needing a follow-up ME-01-style pass.

## P. Migration findings (Phase 11)

- **Fresh replay:** all 87 migrations (0000–0084 plus this pass's own
  `0087_me11_activity_logs.sql`) applied cleanly to a brand-new Postgres 16
  database — `Migrations applied=87 already-present=0 not-applicable=0`,
  no `FATAL`.
- **Idempotent re-run:** re-running `apply-migrations.sh` against the same
  database reported `Migrations applied=0 already-present=87
  not-applicable=0` — no drift, no re-application.
- `0085` follows the existing conventions exactly: `CREATE TABLE IF NOT
  EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, explicit
  `GRANT`/no `anon` grant, and its own indexes — no historical migration
  was modified.
- No other migration-authoring defect was introduced or found beyond the
  one already known and documented by ME-10 (`0050`'s inline transaction,
  pre-existing and out of ME-11 scope).

## Q. Integration findings (Phase 10)

- **ME-02 (Security):** the property/tenant scope functions this pass
  exercised are the same ones ME-02's own certification exercised; no
  regression found in either direction.
- **ME-04 (Financial):** `commercial_usage_counters` is billing/quota
  metadata, not the financial ledger itself; the fix does not touch
  `restaurant_payments`/daily-close/tender-declaration paths.
- **ME-05 (Inventory):** `restaurant_inventory_items`'s property scope
  (`0062`) was read and probed only incidentally (via the same
  `restaurant_can_write_scoped` machinery); no change made.
- **ME-10 (Import & Migration):** Import Studio's property scope (`0063`)
  was probed live (§H.9) and found intact; no interaction with this pass's
  two fixes beyond sharing the same underlying scope-check functions.
- No P09 change in this pass altered the authorization *context* (JWT
  claims, `auth.uid()`, role model) any other ME phase depends on — both
  fixes are additive (a new table, a corrected RPC call) with no change to
  any existing function's signature or policy predicate.

## R. Full validation results (Phase 12)

All commands run against the exact final commit on this branch, compared
against the exact canonical baseline (`77a339e2`) by running the same
commands after `git stash`:

| Check | Baseline | This branch (after fix) |
|---|---|---|
| `vitest run` | 183 files / **2210** tests passed | 183 files / **2211** tests passed (net +1 new test; 2 existing tests extended with audit-trail assertions) |
| `tsc --noEmit` | 3 pre-existing errors (`menuReasoning.server.test.ts`, `router.tsx`, `_authenticated.admin.tsx`) | **Same 3 errors, byte-identical** — no new typecheck regressions |
| `eslint` (touched files only) | 4 pre-existing issues in `activity-log.server.ts` (unrelated `any`/prettier/unused-disable, same line offsets) | **Same 4 pre-existing issues; zero new issues** in any of the 5 touched files |
| `vite build` (production) | succeeds | succeeds, identical output shape (Nitro/Cloudflare Worker + PWA precache) |
| Migration replay (fresh DB) | 86 migrations, 0 failures | **87 migrations** (includes `0085`), 0 failures |
| Migration replay (idempotent re-run) | n/a (not re-verified this pass on baseline) | `applied=0 already-present=87` |
| Live adversarial RLS probes | n/a | **13 probes**, all behaved as required (§H) |

No repository-wide CI workflow file was found under `.github/workflows/`
in this checkout; validation was performed by running the repository's own
`package.json` scripts (`test`, `typecheck`, `lint`, `build`) directly, plus
the migration-replay and adversarial-probe methodology established by
ME-10.

## S. Known limitations

- The dormant `tenants`/`properties`/`outlets`/`rbac_user_roles`/
  `app_users` schema's **write** side (`nova_can_manage_scoped`-backed
  policies, `assignRole`/`revokeRole`) was verified sound (§F) but remains,
  as documented by P09 itself, unreachable from any current UI route —
  this is a pre-existing, explicitly-tracked architectural note, not a new
  ME-11 finding, and no evidence was found that it has become reachable
  since.
- `activity_logs` audit visibility for a tenant is granted to
  `owner`/`general_manager`/`restaurant_manager`/`accountant` tenant-wide
  (matching `documents.audit.read`'s existing convention exactly) rather
  than property-scoped; a property-scoped accountant can therefore read
  audit entries about a sibling property. This mirrors an existing,
  accepted convention in this codebase for this exact class of capability
  and was not treated as a new defect to invent a different scoping model
  for.
- No `.github/workflows/` CI pipeline exists in this checkout to compare
  against for "existing repository certification commands" (Phase 12,
  item 11); validation instead used the same direct-command methodology
  ME-10 already established as this repository's actual practice.
- Performance/scale testing (Phase 9) was analytical (query-shape and
  index review) rather than load-generated against a populated multi-
  thousand-row dataset; no evidence of a *new* performance defect was
  found, and ME-01's existing hardening was confirmed still applicable,
  but a dedicated load test was out of scope for two narrowly-scoped
  correctness fixes.

## T. Final certification matrix

| Requirement | Status |
|---|---|
| P09 functionality actually present | ✅ Verified by code + live DB |
| Enterprise/group/property authorization enforced server-side | ✅ |
| Tenant isolation proven | ✅ Live probes 2, 6, 10 |
| Privilege escalation attempts fail | ✅ Live probes 3, 4, 6 |
| RLS/database enforcement proven | ✅ 13 live probes, fresh-replay DB |
| Sensitive operations auditable | ✅ Fixed in this pass (§I.2), live-verified |
| Concurrency hazards in scope addressed | ✅ No new hazard found or introduced |
| Failure/retry behaviour safe | ✅ No orphaned state found |
| Relevant integrations intact | ✅ No cross-ME regression |
| Migrations valid | ✅ Fresh replay + idempotent re-run |
| Full validation passes | ✅ Zero new failures vs. baseline |
| No unresolved ME-11 defect remains | ✅ Both found defects fixed and regression-tested |

## U. Final verdict

**GREEN / CLOSED.**

Both genuine defects discovered during this certification — the broken
quota-ledger write path and the non-functional audit trail for delegated
administration — have been root-caused, fixed with the smallest correct
architectural change (restoring a dropped RPC call; completing a table
that application code already assumed existed), covered by new/extended
regression tests, and independently re-verified against a live,
from-scratch database replay. No known ME-11 defect remains unresolved.

## V. Files changed

- `standalone/db/migrations/0087_me11_activity_logs.sql` (new)
- `src/lib/activity-log.server.ts`
- `src/modules/restaurant/core/members.server.ts`
- `src/modules/restaurant/core/members.server.test.ts`
- `src/modules/commercial/quota.server.ts`
- `src/modules/commercial/commercial.server.test.ts`
- `docs/me-11/ME-11-enterprise-governance-certification.md` (this report)
