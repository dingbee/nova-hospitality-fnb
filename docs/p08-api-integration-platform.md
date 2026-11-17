# P08 — API Access + Integration Platform

## 1. Status

**GREEN for the scope actually built.** External API credentials, a
tenant/property-scoped `/api/v1/*` surface (locations, menus, orders),
the Integration Registry, the outbound webhook engine, and generic
idempotency are implemented, tested at the unit level, and pass
typecheck/lint/production build. Live HTTP/database certification against
a running standalone Postgres + PostgREST + `wrangler dev` stack was
**not obtainable in this sandboxed session** (§12) — the same class of
disclosed limitation the P08-A ADR already recorded for lack of a
Cloudflare deploy target. This is not claimed as done; see §12 and the
implementation report for exact evidence.

This document is the P08 implementation/certification record. It
supersedes nothing in `docs/p08-a-external-http-entry-point-adr.md`,
which remains the authority on the raw HTTP entry-point mechanism this
builds on.

## 2. API architecture

```
Cloudflare Worker fetch(request)          <- src/server.ts (P08-A)
  ├─ GET /api/v1/health                   <- P08-A, unchanged
  ├─ POST /api/v1/_internal/dispatch      <- P08, internal only (§9)
  ├─ /api/v1/*                            <- P08, this document
  └─ everything else                      <- createStartHandler (pages, createServerFn RPCs)
```

`src/modules/api-platform/router.server.ts`'s `handleApiV1Request` owns
the entire external surface. It never queries a business table directly —
every resource handler in `src/modules/api-platform/resources/*.ts` is a
thin wrapper that authenticates/scopes the request and then calls the
SAME canonical domain server modules the authenticated web app itself
uses (`src/modules/restaurant/sales/pos.server.ts`,
`sales.server.ts`, `menu/menu.server.ts`,
`inventory/locations.server.ts`) — no duplicated business or
authorization logic, per the ADR's §13 mandate.

Request pipeline, every request:

1. Correlation id (`x-request-id` response header; also the `request_id`
   on the `api_request_log` row always written in the response path's
   `finally` block, success or failure).
2. Authentication (§3).
3. Commercial entitlement (§4) — `assertEntitled(tenantId, "api_access")`.
4. Rate limit + daily quota (§7).
5. Request validation (zod, per endpoint — §6).
6. Idempotency, POST endpoints only (§8).
7. Dispatch to a resource handler.
8. One JSON envelope shape for every response (§6).

## 3. Authentication model

A credential is a bearer token: `nova_v1_<12-hex-prefix>_<256-bit-base64url-secret>`,
presented as `Authorization: Bearer <token>`.

- **Generation**: `crypto.randomBytes` — 96 bits of prefix entropy (for
  the O(1) lookup key), 256 bits of secret entropy.
- **Storage**: only `sha256(secret)` and the prefix are persisted
  (`api_credentials.key_hash`/`key_prefix`). The raw token is returned to
  the caller exactly once, at issuance (`issueCredential`'s response) or
  at explicit rotation — never again, never logged, never included in any
  audit row.
- **Verification**: `credentials.server.ts`'s `resolveCredential` looks
  the row up by prefix, then compares `sha256(presented secret)` against
  the stored hash with `crypto.timingSafeEqual` (`hashesEqual`). A
  missing prefix, a wrong secret for a real prefix, a `revoked` status, or
  a past `expires_at` are all indistinguishable failure modes from the
  caller's side — every one of them yields the same `401 unauthorized`,
  so the API surface itself cannot be used to enumerate which credentials
  exist or why one stopped working.
- **Identity derivation**: `resolveCredential` returns
  `{ id, tenantId, propertyId, serviceUserId, scopes }`. `tenantId`/
  `propertyId` come ONLY from the credential row — never from the
  request body, query string, or any client-supplied header, per the
  ADR's §13. There is no code path in `router.server.ts` or any
  `resources/*.ts` handler that reads a tenant/property id from client
  input.

### Why a credential, not OAuth

The P08 mandate's capability list treats "OAuth or equivalent" as
acceptable; a bearer API key was chosen because LexiBite's integration
consumers are server-to-server (POS/PMS adapters, a tenant's own backend,
a webhook receiver) — there is no third-party user ever redirected
through a consent screen, so the extra moving parts of a full OAuth
authorization-code flow (redirect URIs, refresh token rotation, a
consent UI) would be unjustified scope creep for this sprint, per
CLAUDE.md's "add features merely because they appear desirable" rule.
Nothing here forecloses adding OAuth later as an additional
authentication mode alongside credentials.

## 4. Authorization model

Two independent, additive layers — neither is a parallel authorization
system; both extend the canonical `user -> role -> permission ->
tenant/property scope` chain CLAUDE.md requires:

**Layer 1 — credential scope.** A fixed, closed vocabulary
(`src/modules/api-platform/contracts.ts`'s `API_SCOPES`):
`locations:read`, `menus:read`, `orders:read`, `orders:write`. A
credential declares a subset at issuance; `scope.server.ts`'s
`requireScope` rejects anything outside it with `403 forbidden` before
any domain call is made.

**Layer 2 — the existing domain guards, unmodified.** Every credential
is backed by one synthetic `restaurant_members` row (created atomically
with the credential in `credentials.server.ts`'s `issueCredential`),
keyed to a generated `service_user_id` that has no Supabase Auth user
behind it (`restaurant_members.user_id` carries no foreign key — see
`0058`'s header comment, decision #3). Its `role` is chosen by scope:

| Credential scopes contain | Service-account role | Capabilities that role carries |
|---|---|---|
| only `*:read` scopes | `viewer` | none — `assertTenantRead` still passes (tenant membership is enough for a read) |
| any `*:write` scope | `api_service` (new, P08) | **exactly** `sales.manage` — see `standalone/db/migrations/0085_p08_api_service_role.sql` and `permissions.ts`'s own comment on the grant |

Calling into `openPosOrder`/`addPosLines`/`transitionOrder` etc. with
`(supabaseAdmin, credential.serviceUserId, ...)` means their own,
pre-existing `assertCapability`/`assertTenantRead` calls run for real —
if a bug ever let a read-only credential reach a write endpoint, the DB
layer's role check would independently refuse it. `api_service` was
added as one new enum value and one new `CAPABILITY_ROLES["sales.manage"]`
entry — nothing else in the RBAC catalogue changed, and it is provably
excluded from the human staff-assignment path (`ASSIGNABLE_RESTAURANT_ROLES`,
enforced in the `upsertMemberSchema` zod validator, not just the UI
picker — see `src/modules/restaurant/core/api-service-role.test.ts`).

**Property scope**, closing a gap this work found: two existing domain
functions used by this API (`getOrder`, `transitionOrder`) validate
tenant membership only, not property — safe for a human caller because
Postgres RLS is the backstop behind them. This API's request path uses
the service-role admin client (bypasses RLS by necessity, since a
credential has no Supabase JWT), so `resources/orders.ts` adds the
missing property check itself (`assertCredentialCoversProperty`) using
only the credential's own `propertyId` — never a client-supplied one —
before returning any order data or applying a status transition.

**Commercial entitlement**, a third, independent gate: every request
(and every credential/integration/webhook admin action) calls
`assertEntitled(tenantId, "api_access")` /
`assertEntitled(tenantId, "advanced_integrations")` — capability codes
that already existed as `coming_soon` placeholders in the commercial
catalogue (`0034_p01_commercial_architecture.sql`) specifically for this
sprint. `0058` flips them to `active` and tiers them (Core: unavailable,
Pro: limited/preview, Enterprise: advanced for `api_access`; Enterprise-
only for `advanced_integrations`).

## 5. Scopes reference

| Scope | Grants |
|---|---|
| `locations:read` | `GET /api/v1/locations` |
| `menus:read` | `GET /api/v1/menus`, `GET /api/v1/menus/:menuId/items` |
| `orders:read` | `GET /api/v1/orders`, `GET /api/v1/orders/:orderId` |
| `orders:write` | `POST /api/v1/orders`, `POST /api/v1/orders/:orderId/status` |

## 6. Endpoints, request/response conventions

All endpoints require `Authorization: Bearer <credential>`. All
responses are `application/json`, carry `x-request-id`, and use one of
two envelope shapes:

```jsonc
// success
{ "ok": true, "data": { /* endpoint-specific */ } }
// error — never a stack trace, never an internal message verbatim
{ "ok": false, "error": { "code": "forbidden", "message": "...", "details": { } }, "requestId": "..." }
```

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/api/v1/health` | none | P08-A, unchanged |
| GET | `/api/v1/locations` | `locations:read` | |
| GET | `/api/v1/menus` | `menus:read` | published menus only |
| GET | `/api/v1/menus/:menuId/items` | `menus:read` | |
| GET | `/api/v1/orders` | `orders:read` | `?status=&limit=` |
| GET | `/api/v1/orders/:orderId` | `orders:read` | |
| POST | `/api/v1/orders` | `orders:write` | requires `Idempotency-Key`; `201` on create, `200` on idempotent replay |
| POST | `/api/v1/orders/:orderId/status` | `orders:write` | requires `Idempotency-Key` |

Error codes: `unauthorized` (401), `forbidden` (403), `not_entitled`
(402), `not_found` (404), `method_not_allowed` (405),
`validation_failed` (422), `conflict`/`idempotency_conflict` (409),
`rate_limited`/`quota_exceeded` (429), `internal_error` (500 — generic,
by design; see §10).

**Resource surface deliberately excluded from this pass**: inventory and
guest/customer-facing endpoints ("where appropriate" per the mandate).
Menus/orders/locations are the commercially meaningful minimum; adding
more read-only resources later is additive (a new `resources/*.ts` file
+ router branch), not a redesign.

## 7. Rate limiting and quota

Two independent bounds, both fail closed:

- **Quota** (`commercial_quota_definitions` code `api_requests_daily`,
  unit `api_calls`, scope `tenant`, `overage_behavior: block`) — the
  EXISTING quota engine (`src/modules/commercial/quota.server.ts`),
  not a new one. Pro: 2,000/day, Enterprise: 20,000/day (admin-editable,
  same as every other quota in the system).
- **Rate** (`audit.server.ts`'s `assertWithinRateLimit`) — a sliding
  60-second window per credential, counted directly off `api_request_log`
  (no separate counter store): 120 requests/minute.
- **Rate, unauthenticated** (`audit.server.ts`'s
  `assertIpWithinAuthFailureRateLimit`, added during ME-12 certification)
  — the limiter above only ever runs after a credential has already
  resolved, so a flood of requests with a missing/invalid/malformed bearer
  token had no throttling at any layer, forcing unbounded authentication-
  lookup load. This runs BEFORE credential resolution, keyed by source IP,
  counting only requests that never resolve a credential (`credential_id
  IS NULL` in `api_request_log`) — a shared IP's genuine authenticated
  traffic is unaffected: 60 requests/minute per IP.

All three run before request validation and before any domain call.

## 8. Idempotency

`src/modules/api-platform/idempotency.server.ts`. Every mutating
endpoint (`POST /orders`, `POST /orders/:id/status`) REQUIRES an
`Idempotency-Key` header (≥6 characters) — its absence is itself a
`422 validation_failed`, not an optional nicety.

Semantics:

- **Key + request fingerprint** (`sha256(method\npath\nbody)`) are
  checked together. Same key + same fingerprint -> the original,
  persisted response is replayed verbatim; the handler never re-runs.
  Same key + a different fingerprint -> `409 idempotency_conflict`.
- **Concurrency**: a second request racing a never-seen key loses the
  unique-index insert and is told `409 conflict` ("already being
  processed") rather than double-executing.
- **Failure**: a handler exception clears the `in_progress` marker so a
  genuine retry (not a duplicate) can proceed.
- **Retention**: `api_idempotency_records.expires_at` defaults to 24h;
  `public.api_purge_expired_idempotency_records()` (SQL function,
  service-role only) deletes expired rows — invoked by the internal
  dispatch route (§9), not a fixed in-process timer.
- **Belt-and-braces on order creation specifically**: `POST /orders`
  additionally derives a deterministic `clientRequestId` from the
  caller's own `Idempotency-Key`
  (`sha256(idempotencyKey).slice(0,32)`, bounded to
  `openPosOrderSchema`'s 80-char limit) and passes it into
  `openPosOrder`, which has its own native, pre-existing
  `client_request_id`-based idempotency (P10). Two independent
  mechanisms agreeing is not redundant — it means a retry is safe even
  if it somehow bypassed the router's own wrapper.

Proof this actually prevents duplicate transactional records:
`src/modules/api-platform/idempotency.server.test.ts` — a same-key/
same-body retry is asserted to run the handler exactly once and return
byte-identical data both times; a same-key/different-body retry is
asserted to be rejected; cross-tenant key reuse is asserted independent.

## 9. Webhook engine

`src/modules/api-platform/webhooks.server.ts`.

- **Registration**: `POST`-equivalent `registerWebhookEndpoint` (owner/
  general_manager only, `advanced_integrations` entitled). HTTPS-only,
  SSRF-checked (below). Returns the raw signing secret exactly once
  (`whsec_...`); only `secret_prefix` (6 chars) is ever shown again.
- **Subscriptions**: `events: WebhookEventType[]` per endpoint —
  `order.created`, `order.status_changed`, `order.payment_recorded`
  (the last reserved for when a payment endpoint is added; not currently
  emitted since no payment-recording endpoint exists yet in this pass).
- **Scoped ownership**: tenant + optional property. A property-scoped
  endpoint receives only that property's events; a tenant-wide endpoint
  (`property_id NULL`) receives all.
- **Signing**: Stripe-style. `Nova-Webhook-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`
  over `${timestamp}.${rawBody}`. The recipient re-derives the HMAC with
  their own copy of the secret to verify authenticity, and can enforce
  their own replay window against `t`.
- **Delivery records**: one `api_webhook_deliveries` row per (endpoint,
  event) — `event_id` is stable across retries of the SAME logical event
  (idempotent for the recipient's own dedup).
- **Concurrency-safe claim** (added during ME-12 certification): there is
  no in-repo cron scheduler, so an external one drives the internal
  dispatch route and can legitimately fire overlapping invocations.
  `deliverWebhookDelivery` claims a row with an atomic conditional
  `UPDATE ... WHERE status IN ('pending','failed')` to `'in_flight'`
  before doing anything else, so two overlapping invocations can never
  both pick up and deliver the same due row. A row stuck `in_flight` from
  a genuine mid-delivery process crash is recovered the same way a
  `dead_letter` is: `replayWebhookDelivery` resets it to `pending`.
- **Retry**: exponential backoff, `30s * 2^attempt` capped at 6h, plus
  up-to-1s jitter. `max_attempts` defaults to 8; the attempt after that
  marks the row `dead_letter` instead of retrying forever.
- **Replay**: `replayWebhookDelivery` (owner/general_manager) resets a
  `dead_letter`/`failed`/`delivered` row back to `pending`, attempt
  count 0, same `event_id`.
- **Secrets**: AES-256-GCM (`crypto.server.ts`), key from
  `NOVA_API_PLATFORM_ENCRYPTION_KEY` (32 bytes, base64), never persisted
  in the database, never returned by any admin/API response after
  issuance/rotation. Encryption/decryption fails closed (throws) if the
  key isn't configured — there is no plaintext fallback.
- **SSRF**: `assertPublicHttpsUrl` — HTTPS-only, rejects embedded
  credentials, rejects a literal-address/hostname match against
  loopback/private/link-local ranges (RFC1918, `127.0.0.0/8`,
  `169.254.0.0/16` including the cloud metadata IP, `::1`, ULA `fc00::/7`,
  `.local`/`.internal`/`localhost`). Checked BOTH at registration and
  again at every delivery attempt — an endpoint is never trusted just
  because it passed once. See §12 for what this check does not cover
  (DNS rebinding).

## 10. Security model

- **No secret leakage**: raw API credential secrets and webhook/
  integration secrets are returned exactly once, at issuance/rotation,
  and never again — proven in `crypto.server.test.ts` (tamper detection,
  fail-closed on missing/wrong-length key) and by code review of every
  `SAFE_COLUMNS`/`ENDPOINT_SAFE_COLUMNS` select list in
  `credentials.server.ts`/`integrations.server.ts`/`webhooks.server.ts`,
  none of which include `key_hash`/`secret_ciphertext`/`secret_iv`/
  `secret_tag`.
- **No stack traces / internal error leakage**: `errors.ts`'s
  `toApiErrorBody` maps any non-`ApiError` exception to a generic
  `internal_error` with no message from the original error — proven in
  `errors.test.ts` (a forged error containing a fake secret/stack
  frame/Postgres constraint name is asserted absent from the serialized
  response).
- **Cross-tenant isolation**: every domain call is scoped by
  `credential.tenantId`, which comes only from the resolved credential
  row. There is no endpoint that accepts a tenant id from the client.
- **Cross-property isolation**: `assertCredentialCoversProperty`,
  independently proven in `scope.server.test.ts` and exercised by
  `resources/orders.ts`'s own property check ahead of every order read/
  status write, and by `resources/menus.ts`'s check of the referenced
  menu's own property before `GET /menus/:menuId/items` returns anything
  (§4). The menu check was added during ME-12 certification: the
  collection endpoint (`GET /menus`) was already property-filtered, but
  the single-menu-items endpoint accepted a `menuId` directly from the
  caller with no check that it belonged to the credential's own property
  — a property-scoped credential could read another property's menu
  items by ID substitution until fixed.
- **Privilege escalation**: a read-scoped credential's service-account
  role (`viewer`) carries zero capabilities — `scope.server.test.ts`
  and `api-service-role.test.ts` together prove a write scope can only
  ever reach `sales.manage`, nothing broader, and can never be obtained
  by a human through the ordinary staff-management path.
- **Replay/duplicate requests**: §8.
- **Forged webhook signatures**: the recipient's own verification
  responsibility, made possible by a real HMAC over a real secret they
  received exactly once — this repo does not (and structurally cannot)
  verify a signature it computed for someone else.
- **Unauthorized webhook/integration/credential management**: gated by
  `assertCapability(..., "tenant.manage")` — owner/general_manager only,
  the same RestaurantCapability already used for tenant settings.

## 11. Integration lifecycle

`src/modules/api-platform/integrations.server.ts`. `api_integrations` is
a generic identity/config/status/secret/audit record — provider- and
type-agnostic strings (`provider`, `integration_type`), non-secret
metadata in `config` (jsonb), an optional encrypted `secret`. States:
`active` / `disabled` / `error` (the last set by a future provider
adapter via `last_error`/`last_synced_at`, not by this sprint — no
provider-specific logic was written here, per CLAUDE.md). A webhook
endpoint may optionally reference one integration (`integration_id`) to
associate it with a connected provider.

## 12. Operational limitations — honestly disclosed

- **No live HTTP/database certification in this session.** This sandbox
  has no reachable Docker registry (`docker pull postgres:17-alpine`
  returned a `403 Forbidden` from the org egress policy) and the
  standalone appliance (`standalone/docker/docker-compose.yml`) requires
  it, so the real Postgres + PostgREST + `wrangler dev` proof the P08-A
  ADR obtained for the health endpoint was not repeatable here for the
  full credentialed surface. What WAS obtained: a clean `vite build`
  producing the real Cloudflare Worker artifact
  (`.output/server/wrangler.json`) that `src/server.ts`'s new branches
  compile into without error, and a full unit-test suite exercising
  every security-relevant code path against in-memory fakes (the same
  testing convention every other module in this codebase uses — see
  `docs/security-uat-gate.md`). Live cross-tenant/cross-property/replay
  HTTP proof against a running instance remains outstanding and should
  be the first thing a session with registry/Docker access performs.
- **No in-repo cron scheduler.** `wrangler.json` is generated at build
  time (`.output/server/wrangler.json`), not source-controlled, so a
  Cloudflare Cron Trigger cannot be committed here. Webhook retries and
  idempotency-record purging are exposed as
  `POST /api/v1/_internal/dispatch` (bearer-secret-gated via
  `NOVA_API_PLATFORM_DISPATCH_SECRET`) — an external scheduler (a
  Cloudflare Cron Trigger configured post-deploy, or any periodic caller)
  must invoke it. Until that's configured, a failed webhook delivery
  sits `pending`/`failed` rather than being retried automatically.
- **SSRF protection is literal-address matching, not DNS-rebinding-proof.**
  `assertPublicHttpsUrl` blocks the common private/loopback/metadata
  ranges by hostname/literal-IP pattern, re-checked at every delivery.
  It does not resolve DNS itself (Cloudflare Workers' `fetch()` has its
  own additional restrictions on requests to internal address space at
  the platform level, which this sandboxed environment has no way to
  independently verify or claim credit for).
- **Payment recording is not exposed.** `order.payment_recorded` exists
  in the webhook event vocabulary for forward compatibility but nothing
  currently emits it — no `/api/v1/orders/:id/payments` endpoint was
  built in this pass (kept the resource surface to the mandate's
  "minimum commercially meaningful" set).
- **No admin UI.** The credential/integration/webhook lifecycle is fully
  implemented as server functions (`admin.functions.ts`) an admin UI
  would call — no UI was built in this pass (not requested, and CLAUDE.md
  prioritizes proving/hardening the existing product over building more).
- **OAuth is not implemented** — see §3 for why a bearer credential was
  chosen instead for this sprint.

## 13. Certification evidence

See the implementation report delivered alongside this document (exact
test counts, typecheck/lint/build status, final commit SHA). This
document records design and behavior; that report records the specific
run results it was validated against.
