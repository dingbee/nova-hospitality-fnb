# NOVA Hospitality F&B — Restaurant & Bar OS

An independent, self-hosted operating system for restaurants and bars:
point of sale, orders and kitchen, inventory and stock control, procurement
and three-way matching, recipes and costing, pricing and tax, receipts and
reconciliation, plus advisory intelligence.

This repository is the whole product. It has no runtime dependency on any
other application, deployment, hotel, lodge or vendor account.

## Run it locally (the appliance)

```bash
cp standalone/.env.example standalone/.env   # edit the generated secrets
./nova up                                    # database, schema, seed, gateway
```

The terminal is then served at `https://localhost:8443`. Other commands:
`./nova status`, `./nova logs`, `./nova seed`, `./nova down`, `./nova reset`.

The appliance runs PostgreSQL in Docker, applies `standalone/db/migrations`
in order, issues its own ES256 tokens, and serves the built UI over TLS on the
LAN. It never contacts a hosted backend; `./nova` refuses to start if any
configured URL points at one.

## Run it as a hosted app

```bash
bun install
cp .env.example .env      # point at your own Postgres/PostgREST-compatible API
bun run dev
```

## Access control

Roles and permissions are declared once, in `src/lib/rbac/permissions.ts`, and
seeded from there into `standalone/db/migrations/0003_tenancy_rbac.sql`. A test
fails if the two ever drift.

Roles: OWNER, GENERAL_MANAGER, RESTAURANT_MANAGER, BAR_MANAGER, CHEF, WAITER,
BARTENDER, CASHIER, STOREKEEPER, PROCUREMENT, FINANCE, AUDITOR.

Enforcement is server-side. `requirePermission("INVENTORY:WRITE")` resolves
`public.nova_has_permission` in SQL against the caller's own token, and RLS
applies the same rule to the tables. Hiding a button in the UI is presentation
only; calling the endpoint directly is refused by the same check.

Tenancy is data: Tenant → Property → Outlet. Permission grants are scoped to
any level of that tree.

The first account to sign in can be promoted to OWNER once, idempotently, via
`public.nova_bootstrap_owner()` (set `NOVA_BOOTSTRAP_OWNER_EMAIL` to target a
specific address).

## Optional, WAN-dependent capabilities

Email, WhatsApp and AI advisory are configured per deployment
(`src/lib/notifications/adapters.server.ts`, `src/lib/ai-gateway.server.ts`).
When nothing is configured the feature reports itself unavailable — it never
claims a message was delivered. An appliance with no internet is a supported
configuration.

## Verify

```bash
bun run typecheck   # 0 errors
bun run test        # includes RBAC enforcement and independence checks
bun run build
```

`src/lib/independence.test.ts` fails the build if any file reintroduces a
foreign product name, backend project ref, hosted origin or platform runtime
dependency.
