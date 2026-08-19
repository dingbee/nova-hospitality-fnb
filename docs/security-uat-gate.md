# NOVA Hospitality F&B — Standalone Security + UAT Gate

Scope: `export/nova-fnb/` only. Mtoni OS was not modified (verified: zero
changes outside this directory). No features added, no UI redesign, no deploy,
no commit.

## 1. Authorization model — single authority

The authoritative chain is now, without exception:

```text
USER (app_users, status='active')
  -> rbac_user_roles  (scoped: tenant / property / outlet)
    -> rbac_roles
      -> rbac_role_permissions
        -> rbac_permissions  (DOMAIN:ACTION)
```

`has_any_role`, `has_role` and `is_any_staff` survive only as **compatibility
shims**. Migration `0004_rbac_canonicalisation.sql` rewrites their bodies so
they translate a legacy role name through `rbac_legacy_role_map` and then
answer from the canonical tables. The previous fallback

```sql
OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles))
```

is gone, and `public.user_roles` is revoked from `authenticated` and `anon`, so
it is no longer reachable through the Data API and cannot be a second source of
truth. Frozen transactional business logic was left alone; only the resolution
underneath it changed.

Authorization is never inferred from email address, user metadata, or any
client-supplied field. Tests assert this at the SQL-body level.

## 2. Bootstrap

`public.nova_grant_owner(uuid, text, text)` is the only way an OWNER comes into
existence. It is idempotent (`ON CONFLICT` on every insert), refuses to mint a
second owner on replay, never creates or deletes an account, and is revoked
from `public`/`anon`/`authenticated` — only `service_role` may execute it. The
appliance installer (`local/sql/post/10-nova-local.sql`) and the demo seed both
call it instead of writing a legacy role row.

## 3. Endpoint surface

262 server functions were inventoried. 261 carry `requireSupabaseAuth`. The one
exception, `receipts/delivery.functions.ts#getSharedReceiptFn`, is a guest
receipt link scoped by an unguessable token rather than by identity — that is
its contract, and the test suite pins it as the *only* permitted exception so a
second unauthenticated endpoint fails the build.

Closed this pass:

| Surface | Before | After |
| --- | --- | --- |
| Document audit trail | authenticated only | `assertTenantRead` + `documents.audit.read` capability |
| Folio room charge (post) | `is_any_staff` | `POS:WRITE` |
| Folio read / validate / status | `is_any_staff` | `POS:READ` |
| Intelligence Core | legacy role strings | `REPORTS:READ` / `REPORTS:WRITE` |

No server function accepts a role, permission or admin flag from the client;
grant and revoke live in `staff.functions.ts` behind `ADMINISTRATION:ADMIN`.

## 4. UI is presentation only

`usePermissions` derives from the server principal and touches no browser
storage. No component decides access from `localStorage`/`sessionStorage`.
Every hidden button has a server-side twin that refuses the same call made
directly against the RPC endpoint.

## 5. Regression gate

`src/lib/rbac/authorization-gate.test.ts` (35 tests) fails the build on:
reintroduction of the legacy fallback, an email/metadata-derived decision, a
missing scope comparison, a non-idempotent or publicly executable bootstrap, an
unauthenticated server function, client-supplied role input, storage-derived UI
authorization, and a folio or document seam that drops back to a bare
signed-in check. Revocation is asserted to take effect on the next call — no
cached or claim-embedded privilege.

## 6. Clean-checkout build

The product was copied to a directory with no Mtoni repository on disk, then
built from zero (`bun install` -> typecheck -> tests -> production build).

This surfaced one genuine defect that a dirty-tree build had hidden:
`src/components/ui/carousel.tsx` imported `embla-carousel-react`, which is not
in this product's `package.json` — it had been resolving from the parent
repository's `node_modules`. The component was unreferenced, so it was removed
rather than adding a dependency the product does not use.

## 7. Runtime independence

The source tree contains zero runtime references to the legacy product. The
only matches are one test fixture (`independence.test.ts`, which exists to
detect reintroduction) and this document.

The *bundle*, however, is a separate question: Vite inlines
`import.meta.env.VITE_SUPABASE_URL` at build time, so a build run in a shell
that still exports another project's backend credentials bakes that origin into
the artefact while the source stays clean. A build in this repository's sandbox
did exactly that. Built with a clean environment, the bundle contains no
hosted backend origin and no foreign product reference at all.

Because "clean source" does not imply "clean artefact", `bun run verify:bundle`
(`scripts/verify-bundle-origin.ts`) now reads the built output and fails on any
20-character hosted project origin or foreign product string. It is verified in
both directions: it passes a clean build and rejects a deliberately poisoned
one. The appliance keeps its own stricter gate.

The standalone runtime starts from the clean build and serves traffic:
`/` -> 307 to `/auth`, `/auth` -> 200. There is no raw HTTP API surface
(`src/routes/api/` does not exist), so server functions are the only server
entry points, and `requireSupabaseAuth` refuses any call with a missing,
non-bearer, or invalid token.

## Verdict

Clean checkout, no legacy repository on disk:

- `bun install`: 875 packages, no undeclared dependency
- `tsgo --noEmit`: 0 errors
- `vitest run`: 251 passed / 20 files
- `bun run build`: success
- `bun run verify:bundle`: clean
- runtime start: serving

**PASS** — the standalone product resolves every authorization decision
through one model.
