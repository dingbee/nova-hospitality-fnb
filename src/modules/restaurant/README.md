# Restaurant & Bar OS

A **commercial, multi-tenant hospitality module** inside NOVA Hospitality F&B. It is a
product surface in its own right (hotels, lodges, restaurants, bars, resorts,
groups), not a property-specific feature.

## Boundaries

```
core/          tenancy, contracts, permissions, access guards
menu/          menus, versions, categories, items
inventory/     units, categories, stock items
suppliers/     suppliers + supplier product catalogues
purchasing/    purchase orders and lines
costing/       recipe components → recipe costs
sales/         Phase 2 — POS ingestion contracts
operations/    Phase 2 — shifts, waste, daily close contracts
events/        canonical restaurant event contracts + emitter
intelligence/  provider registration + context provider
```

## Rules

- **The Intelligence Core is never modified.** Restaurant OS integrates through
  three seams only: canonical *events*, a *context provider*, and (Phase 2)
  *execution adapters*. No AI logic lives in this module.
- Every row carries `tenant_id`; property and location are optional narrowing.
  All access is enforced in Postgres via RLS + `restaurant_can_read/write`.
- Nothing is hard-coded: menus, categories, units, tax rules, service charge and
  workflows are all rows or per-tenant `settings` JSON.
- Server functions live in `*.functions.ts`; implementations in `*.server.ts`.

## Commercial readiness

`restaurant_tenants` + `restaurant_subscriptions` carry plan, seats and a
`features` map, so plan-gating, tenant onboarding and usage metering can be
layered on later without a schema rewrite. Billing is deliberately out of scope.