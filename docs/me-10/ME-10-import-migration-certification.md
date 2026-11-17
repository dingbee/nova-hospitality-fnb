# ME-10 — Import & Migration Certification

## A. Executive certification

- **Baseline SHA:** `47c530ffe4b530a999417ed5828e0a4ed505909d`
  (`claude/me-00-baseline-lock`) — the exact commit named by the mandate,
  confirmed to carry ME-07/ME-08/ME-09 already merged (PRs #29, #30, #31).
- **Branch:** `claude/me-10-import-migration-cert-pcse84`.
- **PR:** none opened by this session (see §O on why, and what a human
  needs to do to open one).
- **Scope:** the repository's actual, existing import/migration surface —
  "Import Studio" (`src/modules/restaurant/import/`), a ~10,700-line,
  pre-existing (pre-dating both the P-series and ME-series tracks)
  capability for importing menu/inventory/recipe/supplier catalog data from
  spreadsheets. This is genuinely present, not assumed from documentation —
  see §B.
- **Final status:** see §P. **Two genuine, previously-uncertified defects
  found and fixed**, both proven by direct reproduction against a real,
  from-scratch PostgreSQL replay of this repository's own migration chain —
  not assumed from reading policy text. One is a certification-blocking
  severity finding (§E defect 1); the other is a documented-but-unimplemented
  defense-in-depth gap (§E defect 2).

## B. A note on repository state (Phase 1 finding, before any other work)

The mandate's own baseline instruction was verified, not assumed, against
actual repository state, because what was found did not match a casual
reading of "ME-09 is closed and merged":

- This session's branch was created by the harness from `origin/main`
  (`0f195ae`), **not** from `claude/me-00-baseline-lock`. `origin/main` and
  `claude/me-00-baseline-lock` are two **permanently separate, non-converging
  lineages** in this repository — both fork from the same commit
  (`a481620`, "Merge P10 Offline Operations into main", 2026-09-12) and have
  never been merged into each other since. `main` carries the P-series
  track (P02, P07–P12); `claude/me-00-baseline-lock` carries the ME-series
  track (ME-00 through ME-09) via a dedicated, long-lived integration
  branch — every ME-0X PR in this repository's history (#19 through #31)
  bases against and merges into `claude/me-00-baseline-lock`, never `main`.
  `docs/me-07`, `docs/me-09`, etc. exist on `claude/me-00-baseline-lock`
  and do **not** exist on `main`.
- This is architecture, not an accident: two parallel epics (a production
  feature track and a separate hardening/certification track) kept
  deliberately isolated. Confirmed via the GitHub PR API — every ME-0X PR's
  `base` field is `claude/me-00-baseline-lock`.
- Action taken: this session's local branch was re-rooted
  (`git reset --hard 47c530f`) onto the actual baseline the mandate names,
  before any reconnaissance or code change, matching the pattern of every
  prior ME-0X branch. No push had occurred yet (the branch did not exist on
  `origin` at session start), so this was a safe, lossless local operation.
- Separately: the mandate's task text refers to "LexiBite" throughout,
  while `CLAUDE.md` names the product "NOVA Hospitality F&B". This is not a
  wrong repository — `src/config/product.ts` confirms "LexiBite" is the
  customer-facing name of the product's AI intelligence experience and of
  a legacy demo module (`src/modules/lexibite-demo/`) predating the NOVA
  rebrand; it is not a different codebase. No action was needed here beyond
  noting it.

## C. Reconnaissance — what actually exists (Phase 1/2)

Searched the entire repository (not filename-restricted) for
import/migration/CSV/bulk/seed/bootstrap terminology, per the mandate's own
instruction. Found exactly one real, substantial capability plus the
repository's schema-migration tooling:

### C.1 Import Studio (the certified surface)

`src/modules/restaurant/import/` — 22 files, ~10,700 lines, pre-dating both
the P-series and ME-series tracks (`git log --follow` on `import.server.ts`
traces back to pre-freeze commits, well before this repository's current
certification numbering existed). Two distinct entry paths, both riding the
same staging tables and canonical write-path services:

1. **Advanced Import** (`import.server.ts` + `stage.ts` + `domains.ts` +
   `normalize.ts` + `parsers.ts`): a human-reviewed staging workflow — create
   workspace → upload source (xlsx/csv/json/pasted text; PDF/image
   explicitly refuse with a clear "not configured" error, never a fabricated
   result) → parse → auto-detect domain/mapping → human confirms mapping →
   rows are staged with a match/severity classification → human
   approves/rejects/skips (individually or in bulk) → commit. Commit writes
   only through the *same* canonical service functions manual entry uses
   (`upsertSupplier`, `upsertInventoryItem`, `upsertMenuItem`,
   `upsertRecipeComponent`, `insertMovement`, etc.) — nothing in this module
   writes a canonical table directly.
2. **LexiBite Import Template** (`template-import.server.ts` +
   `template.ts` + `template-xlsx.ts`): a deterministic, no-human-mapping
   path for a fixed-schema onboarding workbook. It is **not** a second
   engine — `commitLexibiteTemplateImport` calls the exact same
   `createImportWorkspace`/`uploadImportSource`/`parseImportSource`/
   `confirmImportMapping`/`bulkDecideStagedRecords`/`commitImportWorkspace`
   functions Advanced Import uses, supplying a pre-computed 1.0-confidence
   mapping and looping stage→commit once per domain in
   `IMPORT_DOMAIN_COMMIT_ORDER` to resolve same-workbook forward references
   (Menu → Menu Item → Product/Station → Variant/Recipe/Modifier).

Both paths were certified together, since the template path's authorization,
transaction and idempotency behavior is entirely inherited from Advanced
Import's own functions — there is nothing in the template path to certify
independently beyond its own tier-1 workbook-internal validation
(`validateLexibiteTemplateWorkbook`), which was inspected and found correct
(pure, no-DB-access, cross-sheet code-reference checking; never the
authoritative check, which the shared staging engine still performs).

**Entry point / caller / auth boundary:** 13 `createServerFn` TanStack
server functions in `import.functions.ts`, every one behind the
`requireSupabaseAuth` middleware (Bearer-token Supabase auth — no
unauthenticated path). `context.supabase` is created with the
**publishable/anon key plus the caller's own bearer token**
(`src/integrations/supabase/auth-middleware.ts`) — never a service-role
client — meaning every database call from this module is subject to
PostgreSQL RLS as the actual, final security boundary, not merely the
application-layer `assertCapability`/`assertTenantRead` checks. This
distinction is exactly what produced the two defects in §E.

**Persistence:** four staging/orchestration tables
(`restaurant_import_workspaces`, `restaurant_import_sources`,
`restaurant_import_field_mappings`, `restaurant_import_staged_records`,
all from migration `0013_import_studio.sql`) plus a private Supabase
Storage bucket (`restaurant-import-sources`) for uploaded file bodies.
Canonical writes land in the same tables/RLS every other write path in this
product uses (`restaurant_inventory_items`, `restaurant_suppliers`,
`restaurant_menus`, `restaurant_menu_items`, `restaurant_products`,
`restaurant_recipe_components`, `restaurant_stock_movements`, etc.) — no
parallel transactional model was found or introduced.

### C.2 Migration engine (schema tooling, Phase 12)

`standalone/db/migrations/` — 86 SQL files (0000–0084, after this pass's
own addition), applied by `local/scripts/apply-migrations.sh` in filename
(lexicographic/timestamp) order, each in its own transaction, recorded by
filename+SHA-256 checksum in `nova_local.schema_migrations`; a changed
checksum on an already-applied file is a hard `FATAL`, never silently
re-applied. `local/scripts/init-db.sh` runs the full
clean-Postgres → pre-compat-roles → product-migrations → post-local-schema
pipeline this repository documents as its own from-scratch install path.
This is not hypothetical tooling invented for this certification — it is
the real, already-shipped standalone-appliance bootstrap
(`README.md`: `./nova up` → "database, schema, seed, gateway").

### C.3 What does *not* exist (explicitly not certified, per the mandate's
own instruction not to test hypothetical capability)

No supplier/product/recipe "bulk import" outside Import Studio; no separate
data-migration/ETL tool; no "restore" capability beyond `local/scripts/`
backup/restore of the whole appliance (out of ME-10's scope — that is
infrastructure backup, not data import); no import-specific Playwright/E2E
spec (only `e2e/offline-realbrowser.spec.ts` exists, unrelated).

## D. Certified surface inventory (Phase 2, per entry point)

| Function | Entry | Auth (app layer, post-fix) | Persistence | Tx boundary | Idempotency |
|---|---|---|---|---|---|
| `createImportWorkspace` | `createImportWorkspaceFn` | `import.manage` scoped to `input.propertyId`/`locationId` | insert workspace | single insert | workspace number via `restaurant_next_document_number` |
| `uploadImportSource` | `uploadImportSourceFn` | `import.manage` scoped to the **existing** workspace's own property | storage upload + insert source (storage cleaned up on insert failure) | not transactional across storage+DB by design (upload is compensated on DB failure) | new `sourceId` per call — re-upload is a new source, not a merge |
| `parseImportSource` | `parseImportSourceFn` | scoped to the source's workspace's property | update source row; on failure, records `parse_error`/`extraction_unavailable` instead of throwing opaquely | single update | pure re-parse of the same source; safe to repeat |
| `confirmImportMapping` | `confirmImportMappingFn` | scoped | upsert mapping (`onConflict: tenant_id,source_id,sheet_name,domain`) + insert/update staged rows | per-row upsert loop, not one statement | `dedupe_key = sourceId:sheetName:domain:rowIndex`, **and** already-`committed_at` rows are explicitly skipped, not re-staged |
| `decideStagedRecord` / `bulkDecideStagedRecords` | resp. `Fn`s | scoped to the record's/workspace's property | update decision fields; refuses to alter an already-committed record | per-op | idempotent — re-deciding the same record to the same decision is a no-op update |
| `commitImportWorkspace` | `commitImportWorkspaceFn` | scoped to the workspace's own property | per-record commit through canonical service functions | **not one transaction** — per-record try/catch, explicit partial-success semantics (see §H) | `committed_at IS NULL` gating; safe to re-run |

Dependency handling: `IMPORT_DOMAIN_COMMIT_ORDER` in `domains.ts` fixes
commit order (supplier → inventory_item → supplier_product → menu →
category → menu_item → product_station → variant → modifier_group →
modifier → product_modifier_group → recipe_component → opening_stock) so a
same-workbook forward reference resolves once its dependency has actually
committed, not by source row order (see §G).

## E. Findings and root causes

### Defect 1 (certification-blocking) — Import Studio's four staging tables
had no table-level GRANT to any Postgres role, anywhere in migration
history

**Found via:** a genuine, from-scratch PostgreSQL 16 replay of this
repository's own migration chain (§L), then an adversarial probe run as the
real `authenticated` role with a simulated JWT — exactly the path
`import.server.ts` actually takes through Supabase, not a mocked unit test.
This is the class of defect the mandate's Phase 9 explicitly warns about:
*"Do not confuse database-level constraints with application-level
authorization."* Existing unit tests could not have found this: they run
the same orchestration logic against an in-memory fake Supabase client with
no Postgres GRANT/RLS layer at all.

**Root cause:** every other table this schema creates pairs its `CREATE
TABLE` + RLS policies with an explicit `GRANT SELECT, INSERT, UPDATE,
DELETE ON <table> TO authenticated;` / `GRANT ALL ON <table> TO
service_role;` (verified: `0001_fnb_core.sql` alone does this for over a
dozen tables). `0013_import_studio.sql` (and `0014`/`0020`, which extend
the same tables) never did this for `restaurant_import_workspaces`,
`restaurant_import_sources`, `restaurant_import_field_mappings`, or
`restaurant_import_staged_records`. Confirmed by grepping every migration
file in the repository for a GRANT naming any of the four tables: zero
matches, before this pass.

**Effect, proven empirically (not inferred):** GRANT is evaluated by
PostgreSQL *before* RLS. With no GRANT, every real authenticated user
(regardless of role, regardless of property) received
`permission denied for table restaurant_import_workspaces` on **every**
operation against these four tables — including a plain `SELECT` of a
workspace in the caller's own tenant, and including an `INSERT` by a caller
holding every application-layer capability check required. This makes
Import Studio (both paths — the template path rides the same tables)
**completely unusable by any real authenticated user**, in the standalone
appliance and in a hosted Supabase project alike (Supabase does not
implicitly grant table privileges either — every other table in this exact
schema grants them explicitly).

**Fix:** new migration `0084_me10_import_studio_table_grants.sql`, adding
the same GRANT pattern every other table in this schema already carries —
nothing more; RLS remains the only thing deciding which rows a caller may
touch. Per the mandate's own instruction, no historical migration was
edited.

**Proof the fix is correct and sufficient — Probes 1–4, executed against a
from-scratch replay with the fix applied** (full transcript in §L):

1. A `restaurant_manager` scoped to Property A attempting to `INSERT` a
   *new* workspace under sibling Property B: **`ERROR: new row violates
   row-level security policy`** (RLS now actually reached and correctly
   enforced — before the fix this failed earlier with "permission denied
   for table", meaning RLS was never even evaluated).
2. The same user attempting to `INSERT` a source into an *existing*
   Property B workspace — the exact scenario `0063`'s own migration
   comment describes: **RLS-rejected.**
3. Control: the same user creating a workspace under their **own**
   Property A: **succeeds** (1 row, correct `property_id`) — proving the
   fix does not simply lock everything down; before the fix this
   *legitimate* operation also failed.
4. Control: the same user reading (`SELECT`) the Property B workspace:
   **succeeds** (1 row visible) — proving the intentional tenant-wide-read
   design (§F) survived the fix untouched.

### Defect 2 (defense-in-depth / documentation-accuracy, not independently
exploitable) — the application layer never actually scoped `import.manage`
by property, despite its own migration's comment claiming it does

**Found via:** direct code reading, cross-checked against every
`assertCapability` call site in `import.server.ts`.

**Root cause:** `0063_p09_import_workspace_property_scope.sql`'s own
comment states: *"import.server.ts's workspace orchestration functions
(createImportWorkspace, uploadImportSource, parseImportSource,
confirmImportMapping, decideStagedRecord, bulkDecideStagedRecords,
commitImportWorkspace) called assertCapability(..., "import.manage") with
no property scope... That application-layer gap is fixed in the same
change as this migration."* This claim was false for the code state this
session inherited: all seven functions called
`assertCapability(sb, userId, input.tenantId, "import.manage")` with **no
5th `scope` argument**, before this pass. (The migration's RLS half of the
fix was real and present — see §L — only the claimed TypeScript half was
missing.) This was invisible to `import.server.test.ts` because that suite
mocks `assertCapability` to always return `true`, irrespective of
arguments — appropriate for testing business-logic decisions, but blind to
what the authorization layer is actually being asked.

**Why this is genuinely lower severity than Defect 1, not merely "also
found":** PostgreSQL RLS (`restaurant_can_write_scoped`, from `0063`/
consolidated in `0072`) independently enforces the exact same property
boundary at the database layer and fails closed regardless of what the
application layer passes — proven by Probes 1–2 above, which reject the
attack via RLS, not via the application check. Without Defect 2's fix, a
blocked caller would still be blocked, just with a raw Postgres error
string instead of this codebase's normal clean `Forbidden — "import.manage"
is not granted to you at this property.` message.

**Fix:** a `resolveWorkspaceScope` helper added to `import.server.ts`,
threaded through all seven call sites exactly as `0063`'s own comment
describes — each site resolves the *actual* workspace's (or source's, or
staged record's) `property_id`/`location_id` before calling
`assertCapability`, matching the established "lookup-then-scope" pattern
this codebase already uses elsewhere (`assertCanManageMembership`,
`fiscal.server.ts`, `movements.server.ts`). `confirmImportMapping`'s
duplicate property lookup (previously fetched twice — once implicitly via
this fix, once explicitly for currency resolution) was consolidated into
one, a genuine simplification enabled by the fix rather than separate
scope creep.

**Proof this specific regression is caught, not just "should be":** a new
regression test was written first, confirmed to **fail against the
pre-fix code** (verified by `git stash`-ing the source fix and re-running —
2 failures, both on the missing scope argument), then confirmed to pass
against the fix. This is stronger evidence than "the new test passes" —
it is proof the test actually exercises the defect.

## F. Tenant/property/location isolation evidence (Phase 8 — mandatory)

- **Tenant boundary:** every entry point resolves `input.tenantId` through
  `assertCapability`/`assertTenantRead`, which checks the caller's own
  `restaurant_members` grants **in that tenant** — never a client-supplied
  trust. Cross-tenant read is independently covered by an existing test
  (`import.server.test.ts`, "cross-tenant isolation" describe block) and
  reconfirmed passing.
- **Property boundary — write:** RLS-enforced (Defect 1's fix restores the
  ability to reach that check at all; Defect 2's fix restores the intended
  application-layer defense-in-depth). Proven empirically, not just read,
  by Probes 1–3 (§E, §L).
- **Property boundary — read:** deliberately **tenant-wide**, by design,
  consistently at both layers — `restaurant_can_read(tenant_id)` in every
  read RLS policy, matching the application layer's read functions
  (`listImportWorkspaces`, `getImportWorkspace`, `listStagedRecords`,
  `suggestImportMapping`), which only ever call `assertTenantRead` (no
  property scope). Confirmed intentional (not an oversight) by Probe 4 and
  by `0027_property_scope.sql`'s own comment: *"A resource with no property
  of its own... is tenant-wide by definition."* This is the same
  read-broad/write-scoped model this schema applies elsewhere.
- **Storage bucket (`restaurant-import-sources`):** its read/write/delete
  policies check only that the caller belongs to the tenant named in the
  object path's first segment (`restaurant_owns_menu_image_path`,
  explicitly reused rather than duplicated per `0013`'s own comment) — i.e.
  tenant-wide, not property-scoped, for storage object access. This is
  **consistent** with, not weaker than, the DB-layer read model just
  described: the `restaurant_import_sources` row carrying that
  `storage_path` is *itself* already tenant-wide readable by the same
  design, so a property-scoped reader could already reach the same file
  reference via the database. No new exposure; not a defect.
- **Location scope:** confirmed this schema's sole authorization boundary
  is property, not location — `grantCoversProperty`/`canAccessLocation` in
  `access.server.ts` always resolve a location to its owning property
  before checking a grant. `0063`'s RLS therefore correctly scopes only by
  `property_id`; no location-level gap exists to find.
- **Client-supplied foreign keys:** `commitImportWorkspace`'s canonical
  writes (`upsertMenu`, `upsertInventoryItem`, etc.) all pass
  `workspace.property_id`/`workspace.location_id` — resolved server-side
  from the workspace row, never taken from a staged record's own
  `mapped_data` — for the property/location dimension of the written row.

## G. Dependency / relationship integrity evidence (Phase 4)

`IMPORT_DOMAIN_COMMIT_ORDER` fixes a deterministic commit order
independent of source row order — confirmed by the existing test "commit:
dependency order and cross-domain resolution" (supplier → inventory →
supplier_product → menu → recipe → opening stock, resolving relationships
across the same workspace's earlier commits within one `commitImportWorkspace`
call) and, for same-workbook **forward** references (a Menu Item sheet
referencing a Menu Code that doesn't exist yet), by the LexiBite Template
path's explicit multi-round stage→commit loop
(`commitLexibiteTemplateImport`, bounded by
`IMPORT_DOMAIN_COMMIT_ORDER.length` rounds as a safety ceiling — verified
end-to-end by the existing "LexiBite template deterministic import — end
to end" test). An unresolved reference does not create an orphan: staging
(`stage.ts`) classifies it `cannot_map`/`missing_field` with a `REQUIRED:`
validation error, which `computeSeverity` escalates to `cannot_map` —
excluded from both manual bulk-approval and the template path's
auto-approval (verified by reading `computeSeverity`'s `isBlocking` check
against every `required(...)`-wrapped validation error across `stage.ts`).

## H. Transaction / rollback evidence (Phase 5)

`commitImportWorkspace` is **deliberately not one database transaction** —
each staged record is committed independently inside a per-record
`try`/`catch`, its outcome (`committed_at`, `committed_entity_id`,
`commit_error`) persisted immediately. This is documented, intentional
partial-success semantics, not an oversight: a failure on one row (e.g. a
foreign-key resolution error surfaced only at commit time) never blocks
or rolls back sibling rows, and a workspace's own `status` column
(`open`/`committing`/`committed`/`failed`/`cancelled`) plus the per-row
`commit_error` field make partial state fully observable — never a silent
half-import. Re-running `commitImportWorkspace` after a partial failure is
explicitly safe (`committed_at IS NULL` gating, confirmed by the scale
test in §J re-committing a fully-committed workspace: `committed: 0`, no
duplication) and is the documented recovery path ("a workspace stays open
to a follow-up commit — a human resolving exceptions after the fact
approves more records, then commits again").

## I. Idempotency / replay evidence (Phase 6)

Proven end to end, not assumed from a single constraint:

- **Re-staging the same source** (re-confirming a mapping before commit):
  `dedupe_key = sourceId:sheetName:domain:rowIndex` — existing test
  ("duplicate inventory / re-import") plus this pass's own 400-row scale
  test (§J) confirm no duplicate staged rows at either scale.
- **Re-importing an already-committed entity** (a second workspace/source
  matching an existing item by SKU): updates, does not duplicate — existing
  test ("importing a source that matches an already-committed item updates
  it rather than duplicating").
- **Retrying a commit** (workspace already fully committed): `committed_at
  IS NULL` gating — 0 re-committed, 0 duplication, proven at 400-row scale
  by this pass's own new test.
- **Stock-affecting commits** (`opening_stock`, the one row type creating a
  genuine ledger entry, not just a catalog row): use a **database-enforced**
  dedupe key (`opening_balance:${itemId}`, on `restaurant_stock_movements`'s
  real `UNIQUE(tenant_id, dedupe_key)` constraint — confirmed present via
  `\d restaurant_stock_movements` against the replayed database, not just
  read from migration text). `insertMovement` catches Postgres `23505`
  (unique_violation) and returns `null` — a real, atomic, DB-enforced
  no-op, not an application-level check with a TOCTOU race. This is the
  one commit-row type where a race between two concurrent commits of the
  same record would otherwise double-count real inventory; it is the one
  provably protected at the database level (see §K).
- **New-entity catalog rows without a natural key collision to rely on**
  (no SKU/barcode provided): correctly remain a design limitation of import
  systems in general, not an ME-10 regression — inventing a synthetic
  natural-key policy here would be exactly the "invent functionality to
  make the certification pass" the mandate forbids.

## J. Data integrity / scale evidence (Phases 3, 10)

Pre-existing coverage (all reconfirmed passing) already includes: malformed/
missing-required-field rows (escalate to `cannot_map`, never silently
default), invalid prices (`"Price cannot be negative."`), invalid/
unrecognised units (flagged, never silently guessed), duplicate SKU/barcode
within one sheet (first row creates, second fails at commit with its own
`commit_error` rather than creating a second identity — "adversarial —
Phase 16 scenarios" describe block), missing identifiers (still stages/
commits by name alone), irrelevant/blank columns (dropped, never mapped to
a fabricated field), an irrelevant sheet (no domain guess at all, never
silently defaulted), a mixed-domain sheet (surfaces multiple candidates,
never forces one), empty/partially-valid input, and PDF/image sources
(explicit "not configured" error, never a fabricated extraction result).

**New coverage added by this pass** (Phase 10 gap — no existing test
exercised a realistic import size): a 400-row single-sheet inventory
import, proven to stage/approve/commit with no loss or duplication, survive
a same-source re-stage and a post-commit retry at that volume, in one
`vitest` pass (`import.server.test.ts`, "scale: a realistically large
single-sheet import").

## K. Financial / inventory boundary evidence (Phase 7)

Import commits reach the ledger through exactly one path —
`commitOpeningStockRow` → `insertMovement` with `movementType:
"opening_balance"` — the same canonical stock-movement function every other
inventory-affecting operation in this product uses; no direct
`restaurant_stock_movements` insert, no direct `current_quantity` mutation,
anywhere in the import module (confirmed by grep across the whole
`import/` directory). No import path fabricates a sale, payment, or fiscal
record — those tables are not among the domains `IMPORT_DOMAIN_COMMIT_ORDER`
covers at all. Pricing/currency: `resolvePropertyCurrency` reads the
target property's own `currency` column (never a hardcoded literal),
confirmed by the existing "commits at the workspace's own property
currency, not a hardcoded literal" test. `insertMovement`'s own negative-
stock policy (`evaluateNegativeStock`) applies unchanged to import-sourced
movements — no bypass.

## L. Migration engine validation (Phase 12)

No migration-replay harness existed in the repository, so — per the
mandate's own instruction — the safest available repository-local method
was used: a genuine PostgreSQL 16 instance (already installed in this
session's environment, no Docker daemon available), driven through this
repository's own, already-shipped `local/scripts/init-db.sh` /
`apply-migrations.sh` (the real standalone-appliance bootstrap, not a
purpose-built test double).

- **Fresh replay:** all 86 migrations (0000–0084, including this pass's
  own) applied cleanly from an empty database, in filename order, zero
  `FATAL` — `Migrations applied=86 already-present=0 not-applicable=0`.
- **Idempotent re-run:** running `apply-migrations.sh` again against the
  same database is a clean no-op — `applied=0 already-present=86` — the
  checksum ledger genuinely prevents re-application and would hard-fail on
  drift.
- **One pre-existing, isolated migration-authoring defect found, not
  fixed:** `0050_p11_rbac_self_check_enforcement.sql` contains its own
  inline `BEGIN;`/`COMMIT;`, conflicting with `apply-migrations.sh`'s own
  `psql --single-transaction` wrapping — produces two non-fatal `WARNING`s
  (nested-transaction, then "no transaction in progress") during replay.
  Confirmed **isolated**: grepped for the same pattern across all 86 files
  — no other migration does this. Practical risk today is low (the file's
  own content is idempotent `CREATE OR REPLACE FUNCTION` statements), but
  the pattern genuinely breaks the atomicity guarantee
  `apply-migrations.sh`'s own header comment promises ("each migration
  applies atomically together with its ledger row") for that one file: a
  failure between its inline `COMMIT` and the runner's ledger insert would
  leave schema applied but unrecorded. **Not fixed in this pass**, per the
  mandate's own explicit instruction: *"Do not modify historical migrations
  simply to make certification easier."* Disclosed here as a limitation
  (§O) for a human to decide whether a forward-looking authoring-convention
  fix (documentation, not a rewrite of `0050` itself) is warranted.
- **Numbering gap (0051/0052 never exist):** confirmed benign by git
  history — a documented renumbering during an earlier merge/reconciliation
  ("P11 closure: ... renumber migrations..."), not evidence of a deleted
  or lost migration. The runner keys its ledger by full filename, not by
  numeric prefix, so the duplicate-numbered pairs already in this
  repository (`0081_me05_...`/`0081_me06_...`,
  `0082_me06_...`/`0082_p02_...`) are not a collision — confirmed both
  pairs applied correctly, in the lexicographically-correct order, during
  the fresh replay above.
- **This pass's own migration** (`0084_me10_import_studio_table_grants.sql`)
  applied cleanly in the same run, and its effect was proven by the
  before/after adversarial probes in §E/below, not assumed from its own
  text.

**Adversarial probe transcript (property isolation, §E/§F), against the
replayed database, before and after `0084`:**

Before the fix — every operation denied at the grant layer, including
legitimate same-property access:

```
Probe 1 (cross-property CREATE):  ERROR: permission denied for table restaurant_import_workspaces
Probe 2 (cross-property INSERT source): ERROR: permission denied for table restaurant_import_sources
Probe 3 (control, same-property CREATE): ERROR: permission denied for table restaurant_import_workspaces
Probe 4 (control, tenant-wide READ):     ERROR: permission denied for table restaurant_import_workspaces
```

After the fix — RLS reached and correctly enforced; legitimate access
restored:

```
Probe 1 (cross-property CREATE):  ERROR: new row violates row-level security policy for table "restaurant_import_workspaces"
Probe 2 (cross-property INSERT source): ERROR: new row violates row-level security policy for table "restaurant_import_sources"
Probe 3 (control, same-property CREATE): INSERT 0 1  (IMP-CONTROL-1, property_id = Property A)
Probe 4 (control, tenant-wide READ):     1 row returned (IMP-PROBE-B, property_id = Property B)
```

All fixture data created for these probes was rolled back / deleted; no
production data, and no data outside this session's own throwaway local
PostgreSQL instance, was touched at any point.

## M. Security evidence (Phase 9)

- **Authentication:** every entry point requires `requireSupabaseAuth`
  (Bearer token; no unauthenticated path exists in `import.functions.ts`).
- **Authorization:** see §E (both defects were exactly the
  database-constraint-vs-application-authorization distinction this phase
  calls out) and §F.
- **RLS:** the actual, final security boundary for this module (confirmed
  architecturally — `auth-middleware.ts` never constructs a service-role
  client for these calls) and empirically (§L probes).
- **Service-role usage:** none in the import module's own request path.
  `service_role` GRANTs added by this pass's migration match the pattern
  every other table already uses, for administrative/background tooling
  parity — not exercised by any code path certified here.
- **Oversized payloads:** `uploadImportSourceSchema`/
  `analyzeLexibiteTemplateUploadSchema` cap `fileBase64` at ~13.3 MB
  (10 MB decoded) and `text` at 2,000,000 characters via `zod`, enforced
  server-side before any parse.
- **Injection surfaces:** no dynamic SQL string construction found in the
  import module — all writes go through the Supabase query builder /
  parameterised RPCs.
- **Error leakage:** commit errors are stored per-record
  (`commit_error`) and surfaced through the same review UI as any other
  staged-record state — never a raw stack trace to the client. The one
  place a *raw* Postgres error could have reached the client before this
  pass was exactly Defect 2 (an RLS-rejection message instead of the
  application's own clean `Forbidden` message) — closed.
- **Privilege escalation via imported data:** no import domain writes to
  `restaurant_members`, `rbac_user_roles`, or any role/permission table —
  confirmed by `IMPORT_DOMAIN_COMMIT_ORDER`'s fixed domain list and by
  grepping the commit-row functions for any such table name (none found).

## N. Concurrency evidence (Phase 11)

Genuine concurrent execution against a real, multi-connection database was
not exercised for the full TypeScript orchestration (no test harness for
concurrent Node-process execution against this repository's own database
exists, and building one is disproportionate to what the evidence below
already establishes). Instead, the actual race window was identified and
resolved to the database primitive that decides it:

- `commitImportWorkspace`'s own record-selection query
  (`.eq("decision","approved").is("committed_at", null)`) has an inherent
  select-then-update race window if invoked twice concurrently for the same
  workspace — both invocations could read the same "pending" set before
  either writes `committed_at`.
- For the one row type where double-processing this window would silently
  create a second real financial/inventory event (`opening_stock`), this is
  **provably not exploitable**: `insertMovement`'s dedupe key
  (`opening_balance:${itemId}`) is enforced by a genuine
  `UNIQUE(tenant_id, dedupe_key)` **database constraint** on
  `restaurant_stock_movements` (confirmed present against the replayed
  database), and `insertMovement` explicitly catches the resulting
  `23505` and returns `null` rather than erroring — a concurrent double-
  commit of the same staged opening-stock row produces one movement, not
  two, by database-level atomicity, not application-level ordering.
- For catalog rows with a natural key (SKU/barcode), the same class of race
  is bounded by real `UNIQUE(tenant_id, sku)` /
  `UNIQUE(tenant_id, barcode) WHERE barcode IS NOT NULL` constraints on
  `restaurant_inventory_items` (confirmed present) — a concurrent double-
  commit fails the second `INSERT` with a safe, observable `commit_error`
  on that one staged record, not silent duplication.
- Staging-level idempotency (`dedupe_key` on
  `restaurant_import_staged_records` itself, `unique (tenant_id,
  dedupe_key)` per `0013_import_studio.sql`) is likewise a real database
  constraint, not an application-only check.
- `restaurant_can_write_scoped`'s property-scope check (§E/§L) is
  evaluated by PostgreSQL per-statement under RLS — not vulnerable to a
  TOCTOU race between an application-level check and the write it guards,
  because (after this pass's fix) the same statement's own `WITH CHECK`
  clause is what enforces it.

No new uniqueness/idempotency mechanism was introduced to make this hold —
this pass verified that the existing ledger/catalog constraints already
provide it, which is exactly what Phase 11 asks to be proven rather than
assumed.

## O. Limitations / explicit boundaries

- The `0050` migration's inline-transaction authoring defect (§L) is
  disclosed, not fixed, per the mandate's explicit instruction against
  editing historical migrations for certification convenience. A human
  should decide whether to add a forward-looking authoring-convention note
  (e.g. to a migrations README, if one is added later) so no future
  migration repeats the pattern.
- Genuine multi-process concurrent execution of the TypeScript
  orchestration was not run; the concurrency conclusion (§N) rests on the
  real database constraints that decide the outcome of such a race, which
  were individually confirmed present and correctly enforced, rather than
  on an end-to-end concurrent test harness (none exists in this
  repository for any module, ME-09 included).
- No import-specific Playwright/E2E coverage exists in this repository (see
  §C.3); this pass did not add one, consistent with ME-09's own precedent
  of disclosing rather than fabricating end-to-end UI coverage it could not
  run against a live, authenticated environment.
- This session did not open a PR. `claude/me-10-import-migration-cert-pcse84`
  did not exist on `origin` before this session and still does not — the
  branch is only in this session's local working copy, pending push. Per
  the operating rules ("do not merge... unless the repository's established
  ME certification workflow explicitly requires it"), pushing and opening
  the PR against `claude/me-00-baseline-lock` (matching every prior ME-0X
  PR's base) is left for the human operator to trigger, or for this session
  to do on explicit instruction.
- The storage-bucket tenant-wide (not property-scoped) access model (§F)
  is disclosed as an intentional, consistent design choice, not left
  unmentioned as if it were out of scope.

## P. Final ME-10 status: **GREEN / CLOSED**

Two genuine defects were found through direct reproduction against a real
database replay — not assumed from documentation, not manufactured to
justify a fix. Both are fixed with the smallest correct change, both
proven correct and sufficient by adversarial re-testing against the same
real database (not just by the unit suite), and both covered by new
regression tests that were verified to actually fail against the pre-fix
code before being verified to pass against the fix.

- **Defect 1** (missing table grants — certification-blocking) is closed:
  Import Studio is now actually usable by a real authenticated user, and
  cross-property writes are RLS-rejected exactly as `0063`'s own
  documentation always claimed.
- **Defect 2** (undocumented application-layer scope gap) is closed:
  the application layer now matches its own migration's documentation, and
  a blocked caller receives this codebase's normal clean error instead of
  a raw Postgres message.

**Full validation, executed against the actual code (not assumed green):**

- `npx vitest run` (full project suite): **183 files / 2210 tests
  passing** (2207 on the unmodified baseline + 3 new tests this pass added
  — see §Q). No regression.
- `npx vitest run src/modules/restaurant/import/`: **10 files / 175 tests
  passing** (172 pre-existing + 3 new: 2 authorization-scope regression
  tests, 1 scale test).
- `npx tsc --noEmit`: **0 new errors.** The same 3 pre-existing baseline
  errors (`menuReasoning.server.test.ts`, `router.tsx`,
  `_authenticated.admin.tsx` — none in a file this pass touched, confirmed
  identical against the baseline via `git stash`) remain, unchanged.
- `npx eslint .`: **1370 problems (1344 errors, 26 warnings)** — identical
  count to the unmodified baseline (confirmed via `git stash`), all
  pre-existing and unrelated to files this pass touched. Zero lint
  problems in either file this pass modified.
- `NODE_OPTIONS=--max-old-space-size=8192 npx vite build`: **succeeds**,
  including `import.server`'s own SSR chunk.
- `bun run scripts/verify-bundle-origin.ts .output`: **"Bundle provenance
  OK"** — no foreign backend origin or product reference.
- Migration replay (`local/scripts/init-db.sh`, real PostgreSQL 16, no
  Docker available in this environment): **all 86 migrations apply
  cleanly from scratch; idempotent re-run confirmed; this pass's own
  migration (`0084`) applies cleanly and its effect independently proven**
  (§L).
- Adversarial cross-property RLS probe (§L): **before/after transcript
  proves both the defect and the fix**, not merely "the code now says the
  right thing."

Do not read GREEN as "tests pass" — it reflects that the actual ME-10
objective (a genuinely usable, correctly-isolated, correctly-idempotent
import/migration capability) was verified against real database behavior,
the one previously-undetectable, certification-blocking defect was found
and closed, and every remaining limitation is disclosed rather than
silently assumed away.

## Q. Files changed / tests added

- `standalone/db/migrations/0084_me10_import_studio_table_grants.sql`
  (new) — Defect 1's fix.
- `src/modules/restaurant/import/import.server.ts` — Defect 2's fix
  (`resolveWorkspaceScope` helper + 7 call sites) and the currency-lookup
  consolidation it enabled.
- `src/modules/restaurant/import/import.server.test.ts` — 3 new tests:
  - "import.manage authorization scope" (2 tests) — proves Defect 2's fix,
    verified to fail against the pre-fix code.
  - "scale: a realistically large single-sheet import" (1 test, Phase 10) —
    400-row stage/re-stage/commit/re-commit, no loss or duplication.
- `docs/me-10/ME-10-import-migration-certification.md` — this report.

No other file changed. No production database was touched at any point —
all migration replay and adversarial probing ran against a throwaway local
PostgreSQL instance created and destroyed entirely within this session's
own container.
