# Universal Channel Integration Layer

## Purpose

LexiBite must not contain provider-specific marketplace logic in the restaurant core.

The channel layer provides a stable boundary:

```
External channel
  -> provider adapter
  -> universal channel contract
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
- enable or disable a connection.

Provider secrets are encrypted server-side and are never returned after issuance.

The tenant does **not** need to edit Supabase tables or configuration directly.

## Provider-neutral design

The browser-safe provider catalogue lives in:

`src/modules/api-platform/channel-catalog.ts`

It contains metadata only: provider identity, capabilities, setup fields and documentation.

The universal connection contract is in:

`src/modules/api-platform/channel-contracts.ts`

It deliberately does **not** define provider-specific fields such as a project ID, business ID, endpoint URL or authentication mechanism.

Provider-specific runtime configuration validation and transport live in adapter modules:

`src/modules/api-platform/adapters/`

The adapter registry is:

`src/modules/api-platform/adapters/index.server.ts`

The universal runtime boundary is:

`src/modules/api-platform/channel-connectors.server.ts`

That layer resolves an adapter by provider key and delegates to it. It contains no provider-specific conditional transport code.

Adding a provider therefore follows this pattern:

```
1. Add provider metadata to the catalogue.
2. Implement the provider adapter.
3. Register the adapter.
4. Add provider-specific tests.
5. No POS/core change.
```

## First provider

Ordering.co is the first registered adapter.

Its provider-specific configuration is defined by its adapter and catalogue metadata. The universal channel layer does not know that the provider uses a project ID, business ID or API key.

The adapter owns:

- endpoint selection;
- authentication headers;
- provider-specific configuration validation;
- provider-specific connection testing;
- provider-specific error interpretation.

The transport endpoint is **not tenant-configurable**. This prevents tenant input from becoming an arbitrary outbound URL.

## Piki architecture

Piki is represented by its Ordering.co deployment/project configuration, not as a provider key.

Therefore:

```
Correct:
LexiBite
  -> Universal Channel Layer
  -> Ordering.co adapter
  -> Ordering.co project
  -> Piki deployment

Incorrect:
LexiBite Core
  -> Piki-specific business logic
```

The same boundary can host future marketplace, delivery, ordering-platform and aggregator adapters without changing the restaurant core.

## GTM rule

The product UI controls tenant configuration. Platform/commercial administration may govern which provider definitions are offered, but tenant connection state, credentials and property scope are operational tenant controls.

No provider credential is hardcoded into source, migration files, frontend code, or environment variables.
