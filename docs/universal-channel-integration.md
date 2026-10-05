# Universal Channel Integration Layer

## Purpose

LexiBite must not contain provider-specific marketplace logic in the restaurant core.

The channel layer provides a stable boundary. The product model has two deliberately separate identities:

- **Channel** — the customer-facing external channel/deployment a tenant connects (for example, Uber Eats, Glovo, or another approved channel).
- **Provider adapter** — the transport/API implementation used to reach that channel.

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

The developer-controlled provider catalogue lives in:

`src/modules/api-platform/channel-catalog.ts`

It contains adapter metadata only: provider identity, capabilities, setup fields and documentation.

Customer-facing channel identities live in the database table `api_channel_definitions` and are managed by platform Commercial Administration. A supported channel can therefore be enabled, renamed, ordered or retired without changing LexiBite POS/core code.

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

Adding a supported channel follows this pattern:

```
1. Implement/register the provider adapter once.
2. Add the customer-facing channel definition in Commercial Administration.
3. Enable the channel.
4. Tenant selects it in Universal Channel Centre.
5. No POS/core change.
```

Adding another channel backed by an already-registered adapter is configuration only.

## Channel/provider boundary

There is no first or default customer-facing channel in LexiBite. The product does not assume any external channel is part of the business.

The provider adapter registry is developer-controlled. The customer-facing channel catalogue is platform-controlled data. A tenant sees only enabled channel definitions and connects them to its own property or tenant scope.

Example:

```
Commercial Administration
  -> channel definition: Uber Eats
  -> provider adapter: <registered Uber adapter>

Tenant Universal Channel Centre
  -> selects Uber Eats
  -> enters provider-approved connection details
  -> tests and activates the connection
```

A channel definition is not a provider key, and no external channel is embedded into the LexiBite operational core.

`src/modules/api-platform/channel-catalog.server.ts` owns the server-side catalogue boundary. `api_channel_definitions` contains no credentials or transport endpoints.

## GTM rule

The product UI controls tenant configuration. Platform/commercial administration may govern which provider definitions are offered, but tenant connection state, credentials and property scope are operational tenant controls.

No provider credential is hardcoded into source, migration files, frontend code, or environment variables.
