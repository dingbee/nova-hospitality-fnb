# P08-A — External HTTP Entry-Point Architecture Decision

## 1. Decision

**Option A: native mechanism at the currently pinned framework versions.** LexiBite gains a
custom server entry file, `src/server.ts`, which is the framework's own documented override
point for the request handler. No dependency was upgraded, downgraded, or pinned differently to
reach this result.

## 2. What was audited, and why the original P08 NO-GO was wrong

The original P08 audit grepped `node_modules/**/*.d.ts` for `createServerFileRoute` /
`ServerRoute` and found nothing, concluding no external-HTTP mechanism existed at these versions.
That grep target doesn't exist in this framework generation. A full audit of
`@tanstack/start-server-core`'s export surface and of `@tanstack/start-plugin-core`'s
`resolve-entries.js` / `planning.js` shows the real mechanism: the Vite plugin resolves a server
entry via `resolveEntry({ defaultEntry: "server", required: false })`, searching
`src/server.{ts,js,mts,mjs,tsx,jsx}` before falling back to an internal virtual module
(`virtual:tanstack-start-server-entry`). This is an intentional, documented extension point, not
an internal implementation detail — `createStartHandler`'s and `RequestHandler`'s own JSDoc
document the exact usage pattern this ADR implements.

## 3. Runtime and deployment target

Nitro's build preset for this project is `cloudflare-module` (confirmed in
`.output/nitro.json`), producing `.output/server/index.mjs` as a Cloudflare Worker module
(`export default { fetch(request, env, ctx) }`) plus `.output/server/wrangler.json`. It is **not**
a `node-server` preset and the built artifact cannot be run with plain `node`. This was
independently rediscovered during this spike (see §9 below) after an initial plain-`node`
attempt against `.output/server/index.mjs` produced no output and exited immediately — the
module was being evaluated with nothing to keep the process alive, because it exports a Worker
object, not an HTTP server that calls `.listen()`.

## 4. Framework versions actually installed (resolved, not range-pinned)

| Package | Resolved version |
|---|---|
| `@tanstack/react-start` | 1.168.49 |
| `@tanstack/react-router` | 1.170.32 |
| `@tanstack/start-server-core` | 1.169.31 |
| `@tanstack/start-plugin-core` | 1.171.39 |
| `@tanstack/react-start-server` | 1.167.37 |
| Nitro | 3.0.260603-beta |
| Wrangler (dev-only, local Worker runtime) | 4.125.0 |

No version in this table was changed by this spike.

## 5. The endpoint

`GET /api/v1/health` → `200` JSON `{ ok, service, version, timestamp }`. Any other method on that
path → `405` with an `Allow: GET` header. No auth, no tenant data, no secrets, no domain logic.

## 6. Mechanism shape

`src/server.ts` default-exports a Fetch-API object `{ fetch(request: Request): Promise<Response> }`.
It checks `url.pathname === "/api/v1/health"` first; every other request is delegated unchanged to
`createStartHandler(defaultStreamHandler)(request)` — the framework's own handler, which still
serves every existing page route and every existing `createServerFn` RPC call exactly as before.
This is additive, not a replacement: one new branch, checked first.

## 7. Relationship to the pre-existing `src/start.ts`

`src/start.ts` (pre-existing, from the original scaffold) configures `createStart`'s
`functionMiddleware` — this is TanStack Start's middleware pipeline for `createServerFn` RPC
calls specifically (e.g. `attachSupabaseAuth`). It operates one layer below `server.ts`: `server.ts`
is the raw HTTP entry the deployed runtime invokes for *every* request; `start.ts` only governs
what happens once a request is recognized as a `createServerFn` RPC call and routed into
`createStartHandler`. There is no naming collision or architectural conflict — `/api/v1/health`
is intercepted before it would ever reach the RPC/middleware pipeline, and every existing RPC call
continues to flow through `start.ts`'s middleware unchanged (confirmed by the full regression
suite passing, §18 below).

## 8. Why not Option B (framework upgrade)

Not evaluated further than confirming it's unnecessary: Option A works at the pinned versions
with zero dependency changes. Upgrading anything to "make the sprint look complete" was explicitly
prohibited by the spike's own instructions and would have been unjustified scope creep.

## 9. Why not Option C (separate HTTP API service)

Not needed. The pinned framework already exposes a genuine Fetch-API `fetch(request)` entry point
that can answer plain external HTTP requests without any RPC wrapper. A separate service would
duplicate deployment/runtime surface for no benefit and would risk duplicating business logic
outside the existing authoritative domain modules — explicitly forbidden by this spike's own
architectural-discipline requirement (§19 of the master prompt).

## 10. Evidence status: dev server vs. production artifact

Two independent proofs were gathered, both against a real HTTP client (`curl`), never through
LexiBite's frontend, TanStack client helpers, or `createServerFn`:

- **Dev server** (`npm run dev`, Vite dev middleware): genuine curl proof of 200/405/404/307
  behavior, query-string handling, and zero regression to the app root.
- **Actual built production artifact** (`.output/server/index.mjs`, the same file Nitro emits for
  Cloudflare deployment): run under `npx wrangler dev` against the built `.output` directory —
  i.e. the real `workerd` runtime executing the real bundled Worker module, not a Node
  reimplementation and not the Vite dev server. See Evidence Pack item B.

## 11. Known environment limitation — honestly disclosed

This sandboxed environment has no configured Cloudflare account/deploy target, so a truly
internet-reachable `*.workers.dev` or custom-domain URL was not obtained and is not claimed. What
**was** obtained is strictly stronger than a "curl against my own frontend" proof: the literal
built Worker artifact, executed by the literal target runtime (`workerd` via Wrangler, the same
engine Cloudflare's edge runs), answering real, unmodified `curl` requests over a real TCP/HTTP
connection to `localhost:8787` with no application code, TanStack client runtime, or RPC layer
involved on either side. The only missing link to a fully deployed proof is DNS/edge placement,
not the mechanism itself.

A local tooling gap was hit and resolved along the way: the build's auto-generated
`compatibility_date` (today's date, `2026-09-11`) exceeded what the locally installed Wrangler
4.125.0's `workerd` binary supports (max `2026-08-27`), so the first `wrangler dev` attempt failed
to start with `service core:user:...: This Worker requires compatibility date "2026-09-11"...`.
This was resolved by passing `--compatibility-date=2026-08-27` to the **local dev-runtime
invocation only** — nothing in the build output, `wrangler.json`, or source was changed. This is a
sandbox/tooling-currency artifact (the environment's system clock vs. a slightly older pinned
Wrangler release), not a defect in the mechanism, and does not affect a real Cloudflare deployment
(the platform's own edge runtime is kept current independently of the local `wrangler` CLI
version).

## 12. Webhook compatibility (architectural proof, not implementation)

The `fetch(request: Request)` handler in `server.ts` receives the complete, unmodified Fetch API
`Request` object for every method — this is inherent to the Cloudflare Workers `fetch` contract
and is not something LexiBite's code constructs or could restrict before its own code runs. This
was verified at runtime, not just asserted from types: a genuine `curl -X POST` with a JSON body,
a `X-Webhook-Signature` header, and a custom provider header, sent to the real built Worker
(`wrangler dev` instance), was correctly read (`request.method === "POST"`, causing the existing
405 branch to fire) with no crash and no effect on subsequent requests (Evidence Pack item G).
Reading `request.headers`, awaiting `request.json()`, and returning a signed/validated response are
all therefore reachable from this same entry point. None of that was built in this spike — no
webhook registry, no signature verification, no persistence — this section only establishes that
the mechanism does not need to change shape to support it later.

## 13. Authentication / tenant-identity boundary — decision, not code

Non-negotiable rules for any future P08 endpoint built on this mechanism, to be enforced in code
at that time, not now:

1. Tenant identity, property scope, and outlet scope **must** be derived from a verified
   credential (an API key or token looked up server-side against a `commercial_*`-style table, or
   equivalent) — **never** from `tenant_id`/`property_id`/`outlet_id` in the request body, query
   string, or any client-supplied header. This mirrors the existing rule already enforced for
   `assertTenantRead`/`assertCapability` in `core/access.server.ts` and must not be weakened for
   the external-API surface.
2. Every future API branch must call through to the existing `assertEntitled` /
   `resolveEntitlement` commercial-entitlement resolver — no API-specific entitlement shortcut.
3. Every future API branch must reuse the existing domain server modules
   (`*.server.ts`) for all reads/writes — no direct Supabase/database access from API route code,
   no duplicated business rules.
4. Rate limiting, request signing/verification, and audit logging (via the existing
   `commercial_audit_log` pattern) are P08 concerns, to be designed once real endpoints exist to
   protect — this spike deliberately does not create placeholder security that could be mistaken
   for production authentication.

## 14. What remains for P08 to build (explicitly out of scope here)

API keys/credential issuance, OAuth or equivalent, scopes, a webhook registry/dispatcher, an
integration/adapter registry, developer-facing tooling or docs, and any external write endpoint
(orders, inventory, payments, customers). None of these were built, stubbed, or scaffolded in this
spike.

## 15. Verdict

**GO for the mechanism.** `src/server.ts` is the correct, minimal, framework-native override
point at the pinned versions, proven end-to-end against the real dev server and the real built
Cloudflare Worker artifact via genuine external HTTP requests, with zero regressions across 1957
existing tests and zero new TypeScript or lint errors. P08 (auth, scopes, webhooks, integrations)
may proceed on top of this foundation.
