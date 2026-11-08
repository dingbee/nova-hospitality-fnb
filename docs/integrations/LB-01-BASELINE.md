# LB-01 — StayNas × LexiBite Integration Foundation

Status: **Engineering implementation — review and verification pending**
Contract version: **1.0.0**
Scope: architecture, canonical identity, contract and event schemas only. No production operational integration is enabled.

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
