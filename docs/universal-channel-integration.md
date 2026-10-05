# Universal Channel Integration Layer

## Purpose

LexiBite must not contain provider-specific marketplace logic in the restaurant core.

The channel layer provides a stable boundary:

```
External channel
  -> provider connector
  -> canonical channel contract
  -> LexiBite Core
  -> POS / Kitchen / Inventory / Payments / Intelligence
```

A provider is an adapter, not a product feature embedded in POS.

## Tenant control boundary

Normal tenant operations are performed from:

`/admin/restaurant/integrations`

Tenant owners and general managers can:

- connect an approved provider;
- scope a connection to the tenant or a property;
- store/rotate the provider credential;
- test the connection;
- disable a connection.

Provider secrets are encrypted server-side and are never returned after issuance.

The tenant does **not** need to edit Supabase tables or configuration directly.

## Provider-neutral design

The provider catalogue is browser-safe metadata in:

`src/modules/api-platform/channel-catalog.ts`

Runtime provider resolution is isolated in:

`src/modules/api-platform/channel-registry.server.ts`

Provider transport logic lives behind the connector boundary:

`src/modules/api-platform/channel-connectors.server.ts`

Adding a new marketplace/provider therefore does not require changing POS, kitchen, inventory or intelligence modules.

## First provider: Ordering.co

Ordering.co is the first connector because Piki Tanzania is an Ordering.co deployment.

The tenant connects:

- Ordering.co Project ID
- optional Business ID
- Ordering.co API key

The connector uses the provider-owned API endpoint and `X-Api-Key` authentication. The transport URL is deliberately **not tenant-configurable**; provider endpoints are controlled by the adapter.

The current connection test uses the documented Ordering.co orders endpoint. It verifies credential/project access without writing orders.

## Piki architecture

Piki is represented as an Ordering.co project, not as a provider key.

Therefore:

```
Correct:
LexiBite -> Universal Channel Layer -> Ordering.co -> Piki project

Incorrect:
LexiBite Core -> Piki-specific business logic
```

This allows a future Uber Eats, Glovo, Deliverect or other channel connector to use the same boundary.

## GTM rule

The product UI controls tenant configuration. Platform/commercial administration may govern which provider definitions are offered, but tenant connection state, credentials and property scope are operational tenant controls.

No provider credential is hardcoded into source, migration files, frontend code, or environment variables.
