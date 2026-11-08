# LB-01 — StayNas × LexiBite Integration Foundation

Status: **LB-01.02 database verification passed; LB-01.03 secure-auth primitives implemented, reciprocal exchange not yet certified**
Contract version: **1.0.0**
Scope: architecture, canonical identity, durable mapping, signed service-auth primitives and contract schemas. No production operational integration is enabled.

## Product boundaries

StayNas remains the accommodation operating system and system of record for reservations, rooms, guest stays and folios. LexiBite remains the F&B operating system and system of record for outlets, POS orders, payments, menus and inventory.

Each product retains its own Supabase project, authentication, authorization, tenant model, operational data, subscription/entitlement records, deployment lifecycle and release controls. No shared operational database, direct cross-project database access, tenant merging, or dependency for ordinary operations is permitted.

Nolmark CDMA owns commercial governance. StayNas and LexiBite independently own their subscription, invoice, payment and entitlement records. Founder-only platform governance is separate from tenant administration.

## Canonical identity and mapping

Canonical integration identifiers are opaque UUIDs. They are not derived from, copied from, or interchangeable with either product's native identifiers.

Each product stores its own side of a reciprocal mapping. The mapping associates:
- canonical integration tenant ID;
- canonical integration property ID;
- local native tenant ID and property ID;
- remote product and remote native tenant/property IDs;
- mapping state, request/approval evidence, timestamps and correlation ID.

Mapping states: pending, active, suspended, revoked. Revocation is terminal for a connection; a new authorization creates a new connection/mapping history record. Suspension preserves the mapping but blocks use. Reactivation requires an authorized action and audit evidence.

A mapping is activated only after both product sides independently authorize the pairing. Equal native UUIDs never imply shared identity. One tenant may own many mapped properties; a LexiBite property may contain many outlets. Standalone LexiBite properties and StayNas-only properties remain valid and need no counterpart. No tenant or property is automatically created in the other product.

LB-01 contract schemas describe the mapping proposal and identity shape. Durable mapping persistence and RLS policies are gated on explicit verification of the exact production helper contracts and isolated database tests; no production schema is changed by this milestone.

## Product-specific implementation seams

- StayNas: native organisation/property/membership model (staynas_organisations, staynas_properties, staynas_property_members); its distribution connections and webhook inbox remain DC-specific and are not repurposed as generic cross-product records.
- LexiBite: native restaurant tenancy/property/location model and P08 API platform. Reuse P08's credential, scope, idempotency, webhook signing and delivery patterns where suitable; do not create a competing credential platform or broaden P08 business endpoints without a separate contract.

## Contract catalogue (v1)

| Contract | Owner | Purpose | LB-01 behavior |
|---|---|---|---|
| Property Registry | StayNas / LexiBite | Native property identity exchange | Schema only |
| Tenant Mapping | Both | Reciprocal tenant association | Schema only |
| Outlet Registry | LexiBite | Outlet identity under a mapped property | Schema only |
| Guest Reference | StayNas | Minimized cross-product guest reference | Reserved |
| Guest Stay Status | StayNas | Stay lifecycle reference | Reserved |
| Folio Authorization | StayNas | Future room-charge eligibility | Reserved |
| Folio Posting | StayNas | Future financial posting | Reserved |
| Transaction Reconciliation | Both | Compare external transaction references | Reserved |
| Integration Health | Both | Connection and delivery health | Descriptor schema |
| Event Exchange | Event producer | Versioned event envelope | Schema implemented |

All contracts require authenticated service identity, tenant/property authorization, correlation IDs, explicit error semantics and audit evidence. Mutating requests require idempotency keys. Financial outcomes are accepted, rejected or pending; HTTP success alone is never proof of posting. Financial references carry an ISO 4217 currency code, integer minor-unit amount, unique external reference and explicit reversal/adjustment references. No folio operation is implemented.

## Event envelope and delivery standard

The shared Zod schema requires event ID, event type, event version, schema version, source product, native tenant ID, canonical integration property ID, aggregate ID, occurrence and publication timestamps, correlation ID, optional causation ID, optional idempotency key and payload.

Initial event vocabulary:
- StayNas: property.created, property.updated, guest.checked_in, guest.checked_out, guest.stay_status_changed, folio.updated.
- LexiBite: outlet.created, outlet.updated, order.completed, order.voided, pos.transaction.completed, inventory.updated.

Events are definitions only; this release does not publish production events.

Delivery is at-least-once. Consumers deduplicate by event ID and idempotency key. Retries use bounded exponential backoff with jitter; exhausted deliveries enter a dead-letter state. Ordering is guaranteed only within a documented aggregate/partition. Replay preserves the original event ID and records the replay action. Schema changes are additive within a major version; breaking changes require a new major version.

## Security and lifecycle requirements

- Credentials are generated and stored server-side only; never expose secrets to browser code or logs.
- Prefer P08's hashed bearer credentials, one-time secret disclosure, expiry, rotation and revocation behavior.
- Authenticate the calling product instance before resolving tenant/property scope.
- Derive tenant and property identity from the authenticated connection, never from untrusted request fields.
- Authorize each requested capability and property on every request; deny by default.
- Sign requests (HMAC over timestamp, nonce and raw body); reject stale timestamps and replayed nonces.
- Apply least-privilege database grants and RLS. No service-role key is exposed to either product's client.
- Audit connection creation, approval, capability changes, suspension, rotation, revocation, request outcome and replay.
- Founder administration governs platform-wide connections; tenant administrators may manage only explicitly delegated connections.
- No AI configuration or platform-wide governance is exposed to ordinary property administrators.

## Deferred by design

No live POS integration, room-charge execution, folio posting, guest synchronization, inventory synchronization, combined analytics, SSO, unified UI, subscription bundling, production event publication, customer migration or NoVA runtime dependency is introduced. NoVA integration remains LB-06.

## Verification and release gate

Contract schema tests are included in the product repositories. These tests do not prove database isolation, service authentication, live HTTP delivery or credential revocation. Those require isolated integration fixtures and security tests before LB-01 closure.

No production migrations, data writes, role changes, deployments or operational connections are authorized by this document. Production database work requires a separate migration review, isolated PostgreSQL verification, negative cross-tenant tests and explicit promotion approval.

Execution order: inspect → design → implement → test → verify → report → approval → promote.


## LB-01.02 — durable connection lifecycle

The LB-01 branch now adds a product-local connection registry and append-only audit history in each product database. The registries share canonical integration tenant/property UUIDs while retaining each product's own native tenant/property identifiers. One integration tenant can own multiple property mappings; each native property can have only one non-revoked mapping at a time; revoked history remains immutable and a fresh authorization can create a new mapping with new canonical identifiers.

The lifecycle is pending → active, with suspension/resumption and terminal revocation. A mapping cannot become active until the local administrator approval and remote service-confirmed approval timestamps both exist. Human request, approval, suspension, resumption and revocation actions are written to the local audit ledger. Remote approval is accepted only through a service-role-only database function; the future HTTP adapter must verify the signed service request and bind its authenticated credential to the expected remote tenant/property before invoking it.

Authenticated users receive read-only access to mappings visible within their own property scope. All writes go through SECURITY DEFINER RPCs that perform explicit property-scoped owner/manager authorization. Service-role execution is limited to the remote-approval RPC. No service-role key is exposed to browser clients.

Verification is provided by isolated PostgreSQL scripts and CI workflows. These tests do not apply migrations to production databases. The reciprocal HTTP transport, HMAC verification/nonce store, credential issuance and rotation UI, and end-to-end two-product approval exchange remain follow-on implementation gates; LB-01 is not release-certified until those are implemented and tested.


## LB-01.03A — signed service-authentication primitives

Both products now implement the same versioned request-signing canonicalization using HMAC-SHA256 over the protocol version, timestamp, nonce, uppercase HTTP method, request path and SHA-256 digest of the exact raw request body. The shared header names are `x-lb01-timestamp`, `x-lb01-nonce` and `x-lb01-signature`; signatures use the `v1=<hex>` form. Secrets must decode to exactly 32 bytes and are supplied to these pure helpers by server-side callers only.

Verification rejects malformed signatures, malformed nonces, invalid secrets and timestamps outside a five-minute clock-skew window. StayNas uses Web Crypto; LexiBite uses Node crypto. The protocol canonicalization and test vectors are aligned across both repositories. Unit tests cover valid signatures, body/method/path tampering, invalid secrets, malformed values and stale/future timestamps.

**Security boundary:** signature verification by itself does not prevent replay. LB-01.03B now supplies the durable unique nonce ledger and a service-role-only atomic claim RPC. The HTTP receiver must call the claim RPC after HMAC verification and before any approval RPC or business operation.

### Remaining LB-01.03 acceptance gates

- Durable nonce storage, atomic replay rejection and expiry/cleanup.
- Server-side credential issuance, secret hashing/storage, one-time disclosure, rotation and revocation, bound to one authorized product/tenant/property mapping.
- HTTP sender/receiver adapters using the exact raw body and protocol headers.
- Reciprocal approval exchange that derives tenant/property identity from the authenticated credential and invokes only the opposite product's service-role approval RPC.
- End-to-end tests across both product adapters, including wrong tenant/property, revoked/expired credentials, replay, clock skew, signature tampering and idempotent retry.
- Security review and current-head CI acceptance.

No production migration, live credential, tenant-data change, deployment or PR merge is included in LB-01.03A/B. The PRs remain draft pending full LB-01.03 acceptance.


## LB-01.03B — durable service credentials and replay ledger

Each product now has a server-only credential registry bound by foreign key to its local product-connection record. Only a 24-hex lookup prefix and 32-byte SHA-256 digest are stored; the raw bearer secret is never stored. Credential rows carry active/revoked state, expiry, creator and revocation evidence, with at most one active credential per connection.

A separate nonce ledger has a unique constraint on (credential ID, nonce). The service-role-only claim function atomically inserts a nonce and returns false for replay, expired credentials, unknown credentials, malformed nonce values, invalid expiry windows or a connection that is not active. A bounded cleanup RPC removes expired nonce rows using `FOR UPDATE SKIP LOCKED`. Both tables have RLS enabled and no anon/authenticated table privileges; only the backend service role can access them.

Server-side issue/rotation/revocation RPCs enforce local property-administrator authority, one active credential per connection, 32-byte hash-only storage, expiry limits and append-only credential audit evidence. Server-only application helpers generate 256-bit bearer secrets, disclose each secret once, hash the decoded secret bytes, verify incoming credentials in constant time, validate the HMAC request, derive scope from the credential-bound connection and atomically claim the nonce before returning an authenticated connection context.\n\nIsolated PostgreSQL verification exercises authorized issue, rotation, revocation, audit evidence, first-use nonce acceptance, duplicate replay rejection, revoked/expired/unknown credential rejection, active-mapping enforcement, cross-tenant denial and denial of authenticated-user reads. No live credential is issued and no production migration is applied.

### Remaining LB-01.03 acceptance gates

- Server-side credential issuance, one-time disclosure, rotation and revocation application workflow, bound to the human-approved local connection.
- HTTP sender/receiver adapters that validate signatures against the stored credential hash, atomically claim nonces, derive tenant/property scope from the credential-bound connection and invoke only the service-role approval RPC.
- End-to-end tests across both products, including wrong tenant/property, revoked/expired credentials, replay, clock skew, signature tampering and idempotent retry.
- Security review and current-head CI acceptance.
