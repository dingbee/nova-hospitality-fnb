# P09 Architectural Reconciliation Required — Parallel Tenancy Schema

**Status: OPEN. This is a P09/architecture-ownership decision, not a P11 implementation task.**
P11 identified this during live-database audit, verified it does not currently
cause a cross-tenant data leak (see §5), and is reporting it rather than
resolving it — per P11's own mandate not to merge, delete, migrate, or
invent an architectural workaround for another workstream's schema.

---

## 1. The two models

**Model A — canonical operational model** (`restaurant_*` prefix, 149 tables):

```
restaurant_properties → restaurant_locations → restaurant_members → (orders, payments,
  inventory, menu, purchasing, fiscal, reconciliation, ~140 more tables)
```
Enforced by `restaurant_can_read_scoped` / `restaurant_can_write_scoped` (and
the `_scoped_strict` / `_transfer` variants), which resolve a row's
tenant/property via `restaurant_members` membership. This is the model every
real business table's RLS policy, every `*.property-scope.test.ts` file, and
every UI panel (`PropertiesPanel.tsx`, `LocationsPanel.tsx`, POS, inventory,
purchasing, etc.) is built on.

**Model B — foundational identity model** (bare names):

```
tenants → properties → outlets → app_users → rbac_user_roles → roles → role_permissions
```
Enforced by `nova_has_permission` / `nova_permissions_for` / `has_any_role` /
`is_any_staff` / `is_staff_of_tenant` (all `SECURITY DEFINER`). This model
backs the **global permission gate** (`requirePermission()` /
`assertPermission()` in `src/lib/rbac/rbac.server.ts`) and the staff-admin
CRUD API (`src/lib/staff.functions.ts`, which reads/writes `app_users` and
`rbac_user_roles` directly).

## 2. Origin — corrected from the initial P11 pass's characterization

The initial closure pass characterized Model B as something the concurrent
P09 workstream "introduced." That was imprecise and is corrected here: Model
B's tables, functions, RLS policies, and grants were created in
**`standalone/db/migrations/0003_tenancy_rbac.sql`**, dated 2026-08-24 — the
same day as Model A's own foundational migration
(`0001_fnb_core_part1`–`part5`) and **weeks before any P09 work**. `0003`'s
own header states its purpose plainly: *"NOVA Hospitality F&B independent
identity model... This migration makes the standalone product
self-sufficient: it owns its tenancy, its users and its authorisation
rules, and depends on no external hospitality platform."* — language that
reads as the product's Mtoni-independence effort, consistent with this
repository's CLAUDE.md mandate to never depend on Mtoni OS.

**What P09 actually did** (migrations `0057`–`0063`, live in production,
not yet in `main` — read from the live database only, per this pass's
isolation instructions, not from the P09 branch): added *new* RLS policies
and *new* tables (`is_staff_of_tenant`, `nova_can_manage_scoped`,
`nova_property_tenant`, `restaurant_can_manage_membership`,
`restaurant_increment_quota_usage`, plus import-workspace/config-governance/
inventory-items property-scope helpers) that **read from and extend Model
B** — i.e., P09 is actively building out a schema that had sat present,
RLS-enabled, and granted, but essentially unused for tenant/property-scoped
authorization, since day one. P09 also appears to have seeded the two-tenant
UAT fixture (`uat-tenant-a` / `uat-tenant-b`) into Model B's `tenants` table
that Model A's `restaurant_properties` has never had.

**Correct classification**: Model B is not new, but P09's migrations are the
first work in this repository's history to meaningfully activate it beyond
the global permission gate. The reconciliation question is real regardless
of which workstream is currently building on it.

## 3. Tables using each model

| Model A (canonical operational) | Model B (foundational identity) |
|---|---|
| `restaurant_properties`, `restaurant_locations`, `restaurant_members` | `tenants`, `properties`, `outlets` |
| ~146 further `restaurant_*` tables (orders, payments, inventory, menu, purchasing, fiscal, reconciliation, commercial_*, …) | `app_users`, `rbac_user_roles`, `roles`, `permissions`, `role_permissions`, `rbac_legacy_role_map` |
| New P09 tables scoped via Model A's `restaurant_can_write_scoped` (e.g. `restaurant_import_sources`, `restaurant_import_field_mappings`, `restaurant_menu_items`/recipe tables) | New P09 tables scoped via Model B (`commercial_usage_counters` via `restaurant_increment_quota_usage`, which itself authorizes via `restaurant_can_read_scoped` — see §6 nuance) |

## 4. FK relationships (live-queried, `pg_constraint`)

```
properties.tenant_id     → tenants.id       (ON DELETE CASCADE)
outlets.property_id      → properties.id    (ON DELETE CASCADE)
app_users.tenant_id      → tenants.id       (ON DELETE SET NULL)
rbac_user_roles.tenant_id   → tenants.id    (ON DELETE CASCADE)
rbac_user_roles.property_id → properties.id (ON DELETE CASCADE)
rbac_user_roles.outlet_id   → outlets.id    (ON DELETE CASCADE)
```
No FK, trigger, or view connects any Model B table to any Model A table.
`restaurant_properties.tenant_id` (e.g. `cebda97b-...`) and `tenants.id`
(e.g. `02c721ca-...`) are disjoint UUID spaces — confirmed live, not the
same rows under different names.

## 5. Application code paths — which model each actually gates (live-verified via grep, not assumed)

- **Every real production call site of `assertPermission`/`hasPermission`/
  `requirePermission`** (`rbac.server.ts`, `intelligence/core/access.server.ts`,
  and every module that imports them) **passes no scope argument.** `grep`
  for `tenantId:`/`propertyId:` as an argument to these functions matches
  **only test files** (`rbac.test.ts`, `authorization-gate.test.ts`) —
  never a real `.server.ts` call site. Since `nova_has_permission`'s own
  logic treats a `NULL` scope argument as "matches any grant," Model B's
  `tenant_id`/`property_id`/`outlet_id` columns are **live in the schema and
  RLS-enforced, but functionally inert as a scope boundary in current
  production application code** — every real permission check today is a
  global "does this user hold this permission at all" gate, not a
  per-tenant one.
- **Every real business table's actual row-level tenant/property boundary**
  (orders, payments, inventory, menu, purchasing — everything a customer's
  data lives in) is enforced by Model A's `restaurant_can_read_scoped` /
  `restaurant_can_write_scoped`, which this pass and every prior P11 pass
  has adversarially verified directly.
- **No application code reads Model B's `tenants`/`properties`/`outlets`
  tables directly** (`grep` for `.from("tenants")` / `.from("properties")` /
  `.from("outlets")` returns zero matches in `src/`). Only `app_users` and
  `rbac_user_roles` are read/written directly, exclusively from
  `src/lib/staff.functions.ts` (the staff-admin API, itself gated by
  `ADMINISTRATION:ADMIN`/`STAFF:ADMIN`).

**Conclusion: no production transaction currently depends on Model B for
tenant/property data isolation.** It currently functions as (a) a
global staff/permission flag and (b) the backing store for the staff-admin
CRUD screen. The one real person with a Model B role
(`599d7ea7-...`, `OWNER` of `tenants.id = 02c721ca-...`) is the same human
who is also the real owner in Model A (`restaurant_members`, tenant
`cebda97b-...`) — two unrelated membership rows in two unrelated tables for
one real business.

## 6. Does any P09 functionality depend on Model B for real authorization?

Yes, partially, and inconsistently — this is the crux of the conflict:

- `is_staff_of_tenant`, `nova_can_manage_scoped`, `nova_property_tenant` and
  the three new Model-B RLS policies (`tenants_read_scoped`,
  `properties_read_scoped`, `outlets_read_scoped`) **do** use Model B's
  `tenant_id`/`rbac_user_roles` as a genuine per-row scope boundary — live
  adversarially verified this pass (both directions, read+write, PASS).
- But `restaurant_increment_quota_usage` — also new from P09 — authorizes
  its caller via **Model A**'s `restaurant_can_read_scoped(_tenant_id,
  _property_id)`, called with `_tenant_id`/`_property_id` arguments that,
  by every other P09 table this function touches
  (`commercial_usage_counters.tenant_id`), are **Model A** tenant/property
  ids, not Model B's. So a single P09 feature area already mixes both
  models' id spaces across sibling functions.
- If any future code path passed a Model B `tenants.id` into a Model-A-scoped
  check (or vice versa) — an easy mistake given both are named `tenant_id`/
  `_tenant_id` throughout — the check would silently evaluate against the
  wrong tenant, either denying a legitimate caller or (worse) granting
  based on a coincidentally-matching id in the wrong space. This has not
  been observed in the code paths checked, but the two identically-named,
  differently-scoped id spaces are the exact shape of that class of bug.

## 7. Exact conflict with the canonical architecture (CLAUDE.md)

CLAUDE.md: *"invent new transactional models where an existing canonical
model exists"* and *"create duplicate RBAC systems"* are both listed under
Absolute Boundaries. Model A is the de facto canonical model — it is what
every real business table, every property-scope regression test, and every
UI screen is built on. Model B is a second, independently-FK'd
tenant→property→outlet→role graph that predates today's finding but that
P09's current migrations are the first to meaningfully build new,
RLS-enforced authorization logic on top of. Continuing to build P09
features against Model B, in parallel with Model A remaining canonical for
everything else, **is** the duplicate-model shape CLAUDE.md prohibits,
regardless of which migration first created the tables.

## 8. Is Model B active, dormant, transitional, or orphaned?

**Active-but-narrow**, not dormant: it has been continuously exercised in
production since `0003` as the backing store for the global permission gate
and the staff-admin API — real, if narrow, functionality depends on it
today. It is **not orphaned**. Whether it is **transitional** (an intended
future replacement for Model A, now being built out by P09) or an
**accidental duplicate** that should be retired in favor of Model A is
exactly the open question this note cannot answer from inside P11 — it
requires whoever set the original `0003` "independent identity model"
direction, or whoever owns the current P09 roadmap, to say which.

## 9. Recommended canonical model (recommendation only — not enacted)

Model A (`restaurant_properties`/`restaurant_locations`/`restaurant_members`)
is the stronger candidate for sole canonical status: it is what 149 tables,
every regression test, and every UI screen already depend on, and retiring
it would touch far more surface than retiring Model B. If Model B's
`tenant_id`/`property_id`/`outlet_id` scoping is genuinely wanted at the
permission-gate layer (not just as a staff-admin backing store), the lower-
risk path is likely to point Model B's `tenants`/`properties`/`outlets`
rows at Model A's via a bridging FK (or replace Model B's tenancy tables
with views over Model A's) rather than maintaining two independently-
seeded graphs. This is a recommendation for the human/engineering-lead
decision this note exists to trigger — not a plan P11 is executing.

## 10. Migration/deprecation implications (if Model A is chosen canonical)

- `app_users`/`rbac_user_roles`/`roles`/`permissions`/`role_permissions` would
  need to either be re-pointed at Model A's tenant/property ids or kept as a
  platform-wide (non-tenant-scoped) staff directory, decoupled from
  per-tenant data entirely.
- `tenants`/`properties`/`outlets` would need either deletion (after
  confirming zero remaining reads — currently true) or repurposing as a
  read-only projection of Model A, never independently written.
- Every P09 function/policy built directly on Model B
  (`is_staff_of_tenant`, `nova_can_manage_scoped`, the three new
  `*_scoped` RLS policies) would need to be re-pointed at Model A's
  predicates instead.
- This is real migration work with real blast radius (touches auth-adjacent
  code on every request) and belongs to a dedicated, reviewed pass — not a
  side effect of a P11 security-hardening PR.

---

**P09 ARCHITECTURAL RECONCILIATION: OPEN.** No schema, data, or FK change
was made by this note or this P11 pass. Human/engineering-lead decision
needed on whether Model B is a sanctioned transitional layer or should be
retired in favor of Model A.
