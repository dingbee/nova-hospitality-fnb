# LexiBite Demo Access — Nolmark/Lovable integration contract

P02.2 (Demo Identity & Registration) + P02.3 (Verification & Demo Session) +
P02.4 (Demo Authorization & Security).

This document defines the **implemented** API, not a proposal. It is the
one thing Nolmark/Lovable needs to build against.

## 0. What this is, in one paragraph

A visitor on the Nolmark/Lovable marketing site registers for a LexiBite
demo through a public HTTP endpoint. LexiBite emails them a Supabase-issued
verification link (reusing Supabase Auth's own email-confirmation
mechanism — no new verification system). Clicking it authenticates them as
a brand-new, individual Supabase Auth user and lands them on a LexiBite
page that grants them a real, least-privilege (`viewer`) membership on the
**existing, real** "LexiBite Demo Restaurant" tenant (Kilimanjaro Grill /
Kilimanjaro Grill West), then sends them into the actual product. Nolmark
never receives a session token, a tenant id, or any credential — the
verification link always lands on LexiBite's own origin.

## 1. Existing architecture reused (nothing new was invented)

| Concern | Reused mechanism |
|---|---|
| Authentication | Supabase Auth (`supabase.auth.admin.generateLink`, the same identity system every other user in this product uses) |
| Email verification | Supabase Auth's own signed, single-use, expiring action links — no custom token table |
| Email delivery | `src/lib/notifications/adapters.server.ts`'s existing generic webhook adapter (`NOVA_EMAIL_WEBHOOK_URL`) — the same path commercial notifications and receipts already send through |
| Tenancy | The real, existing `restaurant_tenants → restaurant_properties → restaurant_locations` tree (not the barely-used fine-grained `tenants/properties/outlets` tree — see the architecture note in migration `0082`) |
| Canonical demo environment | The **already-existing** UAT tenant fixed by migration `0039_branding_sprint_identity_hierarchy_repair.sql` — tenant `cebda97b-33b1-43bf-932e-d7fee992a6c3` ("LexiBite Demo Restaurant"), property `d6674bdc-ebe2-4bb7-801a-54b1b8dfc218` ("Kilimanjaro Grill"), location `fb15e245-b2bf-4d07-abb6-213bbeafa584` ("Kilimanjaro Grill West"). Nothing was provisioned — this data already exists in production. |
| Demo role | The existing `viewer` role in `restaurant_role` — it holds **zero** entries in `CAPABILITY_ROLES` (`src/modules/restaurant/core/permissions.ts`), so it is already, by construction, read-only everywhere in the product. No new role/permission system was added. |
| Demo controlled write | The existing, already-public, already-safe guest self-order flow (`src/modules/restaurant/selforder/*`, entry route `/order/$tableId`) — scoped by an unguessable table/session id exactly as it is for a real walk-in guest today. |
| Commercial-admin gate (reset) | The existing `commercial_administrators` allow-list / `assertCommercialAdmin` (`src/modules/commercial/access.server.ts`) — the same mechanism every other platform-level operation in this codebase uses. |
| P05/P06 intelligence | Unmodified. A demo `viewer` sees whatever P05/P06 capability the canonical demo tenant's commercial plan entitles any tenant member to see (`assertTenantRead` + `assertEntitled`), exactly like any other tenant member. |

New surface added: two tables (`lexibite_demo_registrations`,
`lexibite_demo_sessions`), one bookkeeping table
(`lexibite_demo_reset_state`), and two SECURITY DEFINER SQL functions
(`restaurant_grant_demo_session()`, `restaurant_reset_demo_environment()`)
— see `standalone/db/migrations/0082_p02_lexibite_demo_access.sql`.

## 2. Registration

**`POST /api/public/demo/register`**

Raw HTTP (not a TanStack Start server function — Nolmark is a different
origin and cannot address this app's RPC protocol). Implemented in
`src/modules/lexibite-demo/http.server.ts`, wired in `src/server.ts`.

Request body (JSON):

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "workEmail": "ada@example.com",
  "company": "Acme Hospitality",
  "role": "Operations Director",
  "country": "TZ",
  "phone": "+255700000000",
  "source": "LEXIBITE_DEMO"
}
```

`phone` is optional. `source` must be exactly `"LEXIBITE_DEMO"` (validated,
not defaulted silently on a wrong value — a caller sending anything else
gets a 400).

Response (`200`, or `422` when `status` is `"error"`):

```json
{ "status": "verification_required", "registrationId": "…uuid…", "message": "Check your email to verify and launch your LexiBite demo." }
```

`status` is one of `verification_required | already_registered | error`
(the `accepted` state in the mandate collapses into `verification_required`
here, since verification is always required — there is no unverified
"accepted" state). No internal database detail is ever exposed.

- **Auth**: none (public). **Authorization**: none — registration only ever
  creates a low-privilege lead record and an unconfirmed Supabase Auth
  user; it never grants product access.
- **Rate limiting**: max 5 registrations per IP-hash per hour (IP is SHA-256
  hashed, never stored raw); duplicate `work_email` (case/whitespace
  normalized) short-circuits to `already_registered` rather than creating a
  second row.
- **CORS**: see §6.
- **Errors**: `400` invalid payload, `422` `{status:"error"}` business
  rejection (rate-limited, email send failure), `500` unexpected failure.

## 3. Resend verification

**`POST /api/public/demo/resend`**

```json
{ "workEmail": "ada@example.com" }
```

Same response shape as registration. Deliberately does **not** reveal
whether an email is registered (avoids account enumeration — the same
message is returned either way). Capped at 5 resends per registration and
a 60-second minimum interval between sends.

## 4. Registration status (optional polling)

**`GET /api/public/demo/registration/{registrationId}`**

```json
{ "status": "pending_verification" }
```

`404` if the id doesn't exist. No PII is returned. Public, unauthenticated,
read-only — safe for Nolmark to poll if it wants a "waiting for
verification" UI state without embedding an iframe.

## 5. Verification & session (P02.3/P02.4)

There is no separate verification API for Nolmark to call — verification
happens by the visitor clicking the emailed link, which is entirely a
LexiBite-hosted flow:

1. The email (sent via the existing `sendEmail()` adapter) contains a
   Supabase-issued `action_link` (`type: "invite"` on first send, `type:
   "magiclink"` on resend), redirecting to
   `{LEXIBITE_APP_ORIGIN}/lexibite/demo/activate`.
2. That page (`src/routes/lexibite.demo.activate.tsx`) is a normal LexiBite
   route. supabase-js's default `detectSessionInUrl` establishes a real
   Supabase Auth session from the link — this is the verification proof:
   reaching an authenticated state was only possible by possessing that
   single-use, expiring, Supabase-signed token.
3. The page calls the authenticated server function
   `activateDemoSessionFn` (`src/modules/lexibite-demo/session.functions.ts`),
   which (`src/modules/lexibite-demo/session.server.ts`):
   - looks up the caller's own `lexibite_demo_registrations` row (by
     `auth_user_id`, never anything client-supplied),
   - flips it from `pending_verification` to `verified`,
   - calls `restaurant_grant_demo_session()` **through the caller's own
     authenticated Supabase client** (never the service-role client, which
     has no `auth.uid()` and would be rejected by the function itself).
4. `restaurant_grant_demo_session()` (migration `0082`) is a
   `SECURITY DEFINER` SQL function that takes **zero arguments**. Every
   value that matters for authorization — tenant id, property id, location
   id, role (`'viewer'`) — is a hardcoded literal inside the function body,
   not a parameter. It:
   - rejects an unauthenticated caller,
   - rejects a caller with no `verified`/`session_active` registration,
   - inserts (idempotently) a `restaurant_members` row: canonical tenant,
     canonical property, the caller's own `auth.uid()`, role `'viewer'`,
   - upserts a `lexibite_demo_sessions` row (4-hour expiry),
   - returns the session id/tenant/property/location/role/expiry.
5. The activation page redirects the visitor into the product — either the
   guest self-order flow for a demo table (if one exists at the demo
   location) or the normal authenticated app root, which resolves the
   visitor's one tenant membership automatically.

There is no JSON response Nolmark ever sees for this step — the entire
exchange happens on LexiBite's own origin, which is the point: **no session
token, tenant id, or credential of any kind ever reaches Nolmark.**

## 6. Nolmark security boundary

- Nolmark is treated as an untrusted public client throughout. It never
  receives a Supabase key of any kind (publishable or service-role), a
  LexiBite credential, or a session token.
- `POST /api/public/demo/register` and `/resend` accept CORS from an
  explicit allow-list only: set `NOLMARK_ALLOWED_ORIGIN` (comma-separated)
  to enable direct browser calls from Nolmark's site. With it unset, no
  `Access-Control-Allow-Origin` header is added — a server-to-server call
  from Nolmark's backend still works (no browser CORS enforcement applies),
  but a browser-direct call from an unlisted origin is refused by the
  browser itself. **Preferred integration**: call `/register` from
  Nolmark's own server, not its client bundle.
- Every request body is treated as untrusted and validated with the same
  zod schemas used everywhere else in this codebase
  (`src/modules/lexibite-demo/contracts.ts`). None of these schemas has a
  `tenantId`, `role`, or any other authorization-relevant field — there is
  no field for a caller to forge that would matter.

## 7. Sales handoff / CRM

**No CRM, lead table, or Nolmark/Lovable integration point existed in this
codebase before this change** (confirmed by repository-wide search — zero
hits for `nolmark`, `lovable`, `lead`, `crm`, `waitlist`). This mandate
establishes the *boundary*, not a CRM: `lexibite_demo_registrations` is the
one record of a prospect, tagged `source = 'LEXIBITE_DEMO'`.

No outbound webhook/event stream to an external CRM exists yet. If Nolmark
needs `demo_registered` / `demo_email_verified` / `demo_session_started` /
`demo_contact_sales` events pushed somewhere, that requires a genuine
outbound integration (a webhook URL, or reusing whatever CRM Nolmark
already has) — **explicitly out of scope for this pass** and not
fabricated. The registration and session tables carry every fact such an
integration would need (timestamps, status transitions); wiring an actual
outbound event is the next action for whoever owns the Nolmark side (see
§10).

## 8. Shared demo state & isolation

Every visitor gets their **own** Supabase Auth identity and their own
`restaurant_members`/`lexibite_demo_sessions` row — never a shared
account, and never a new tenant per visitor (per the mandate's explicit
"do not create a tenant per visitor" / "do not share one account").

- `lexibite_demo_sessions` RLS: `select` only where `auth.uid() = user_id`
  — a visitor can never see another visitor's session row. Proven live
  (see §9, check 10).
- All visitors share the same underlying tenant data (menu, tables, prior
  orders) — this is the accepted tradeoff for "one canonical demo
  environment," documented explicitly in the mandate.
- The one write surface a `viewer` can reach (guest self-order,
  `/order/$tableId`) is the same surface a real walk-in guest uses,
  scoped by an unguessable table/session id — one visitor's order does not
  expose or corrupt another's.

## 9. Reset strategy

**Never a public or unrestricted-admin action.**
`resetDemoEnvironmentFn` (`src/modules/lexibite-demo/reset.functions.ts`)
requires an authenticated caller who passes `assertCommercialAdmin` — the
existing, narrow, platform-wide allow-list
(`src/modules/commercial/access.server.ts`) — checked again inside
`restaurant_reset_demo_environment()` itself at the SQL level (defense in
depth).

Scope, precisely:

- **Purged** (rows created since the last reset, in the canonical demo
  tenant only): `restaurant_orders`, `restaurant_order_items`,
  `restaurant_payments`, `restaurant_kitchen_tickets` — i.e. exactly what
  the guest self-order write surface can create, since that is the only
  write surface a `viewer` can reach.
- **Revoked**: the demo `viewer` `restaurant_members` grant for any visitor
  whose `lexibite_demo_sessions` row has expired.
- **Never touched**: the tenant/property/location rows themselves, the two
  real pre-existing UAT members already on this tenant (owner,
  purchasing_officer — their user ids never appear in
  `lexibite_demo_sessions`, so they are structurally excluded), and
  inventory stock movements.
- **Known limitation**: an order that completes and triggers recipe-based
  stock consumption is not reversed. A fully ledger-accurate rollback
  (replaying/reverting `restaurant_stock_movements` entries per CLAUDE.md's
  canonical-stock-ledger rule) is a materially larger piece of work and is
  explicitly **not** implemented in this pass rather than done
  approximately. Until it exists, the demo location's inventory can drift
  from repeated demo orders — an operational/ops-content concern for
  whoever curates the demo menu, not an authorization or security gap.
- Supports `dryRun` (default `true`) — returns counts without deleting
  anything, so an operator can preview before running for real.

## 10. Known limitations / explicit next actions

1. **Inventory ledger reset** (above) — not implemented.
2. **CRM/event push to an external system** — no outbound integration
   exists; the registration/session tables have everything needed, but
   nothing pushes it anywhere yet.
3. **Demo table/menu content readiness** — the canonical tenant/property/
   location exist, but this pass did not curate specific demo menu items or
   guarantee a table exists at the demo location for the self-order link;
   `activateDemoSessionFn` degrades gracefully (`selfOrderUrl: null`) if
   none is found. That is a content/ops task, not an authorization gap.
4. **Nolmark has not been connected to this API** — this document makes
   LexiBite *ready to provide* the contract; the marketing site itself was
   explicitly out of scope for this mandate and has not been touched.

## 11. Testing evidence

- **Live validation against a real Postgres instance** (the full
  migration chain, `0000` → `0082`, applied from scratch —
  `local/scripts/verify-demo-access.sql`): proves `anon` has no execute
  grant on the function at all; an unauthenticated caller is rejected
  inside it; an unverified registration is rejected; a verified visitor is
  granted exactly `viewer` on the exact canonical tenant/property/location
  (never anything else, since nothing is a parameter); re-activation is
  idempotent (no duplicate membership/session rows); a demo viewer cannot
  write a `restaurant_orders` row (RLS denies it); a demo viewer reads zero
  rows from every tenant except the canonical demo tenant; the reset
  function is denied for a non-commercial-admin and succeeds (dry run) for
  a genuine one; and two visitors' session rows are mutually invisible
  (RLS self-read). All synthetic fixtures this script creates are deleted
  by its own cleanup section — confirmed zero residual rows afterward.
- **Unit tests** (`vitest`, 19 new tests across
  `src/modules/lexibite-demo/*.test.ts`): email normalization, IP hashing
  (never stores the raw IP), duplicate-registration handling, forged-field
  rejection, per-IP rate limiting, resend caps/cooldown, verification
  status transition, RPC argument shape (never forwards a client-supplied
  value), reset-function admin gating, and — reusing the *existing*
  capability map rather than inventing a new authorization check — a
  direct proof that the `viewer` role holds none of `RESTAURANT_CAPABILITIES`
  at all.
- **Full existing suite**: 2171 tests across 179 files, all passing after
  this change (zero regressions).
- **Typecheck/lint/production build**: all clean (three pre-existing,
  unrelated typecheck errors in files this change never touches are the
  only findings).
