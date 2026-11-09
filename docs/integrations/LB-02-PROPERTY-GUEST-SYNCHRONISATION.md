# LB-02 — Property, Outlet, Guest Reference & Stay Synchronisation

Status: Architecture and contract preparation only
Dependency: LB-01 secure reciprocal connection, approval and service-authentication certification
Production changes, deployments, data migration and live event publication: PROHIBITED

## 1. Objective

Define a tenant-safe, privacy-preserving synchronisation boundary so one StayNas property can be paired with the corresponding LexiBite property, F&B outlets can be referenced across products, and an eligible in-house guest/stay can be recognised by LexiBite without merging guest databases.

This is a platform capability, not an Mtoni-specific implementation. Pairings are explicit and approved. No automatic tenant/property creation or name-based matching is allowed.

## 2. Authority and data ownership

| Domain | System of record | Other product may retain |
|---|---|---|
| Organisation, tenant and accommodation property | StayNas | Opaque mapped identity and connection metadata |
| Rooms, reservations and stay lifecycle | StayNas | Minimal guest-stay reference and status projection |
| Accommodation guest identity and PII | StayNas | Opaque guest reference only; no name, email, phone, address, ID or DOB |
| F&B outlet and outlet operational fields | LexiBite | Mapped outlet ID and approved display projection |
| Restaurant-only customers and POS records | LexiBite | Remain LexiBite-local; never merged with StayNas guest identities |
| Cross-product mappings and delivery evidence | Each product's own integration schema | Product-local mapping/delivery metadata only |

No shared database, cross-project database credentials, direct database reads, guest identity merge, or automatic PII matching.

## 3. Scope and sequence

### LB-02.01 — Property identity and tenant mapping
- Reuse LB-01's reciprocal connection and property mapping identifiers; do not create a second mapping authority.
- Enforce one active mapping for each local property / remote property pair within a connection.
- Verify active connection, dual approval and matching correlation ID before any sync.
- Property rename, status, timezone or currency changes are events, not identity changes. Native IDs remain immutable.
- Unpairing, suspension or revocation blocks new delivery and marks remote projections stale; historical evidence is retained.

### LB-02.02 — F&B outlet mapping
- LexiBite is authoritative for outlets and outlet operational fields. Implementation must use the active restaurant_tenants → restaurant_properties → restaurant_locations tenancy tree; the older tenants/properties/outlets schema is not the live operating model. Treat restaurant_locations as the current operational outlet/location identity and inspect its exact constraints before designing the mapping FK.
- Each outlet must belong to the mapped LexiBite property; cross-property outlet mapping is rejected.
- Mapping is explicit and admin-approved. No silent matching by name or code.
- StayNas receives only approved fields: opaque outlet ID, mapped property ID, display name, outlet type, public description, guest-visible service status and published service hours.
- Do not replicate POS terminals, menus, prices, recipes, stock, employee data, orders, payments or revenue in LB-02.

### LB-02.03 — Privacy-preserving guest references
- StayNas creates a random, non-semantic guest reference scoped to the integration connection and property. StayNas's canonical source is the guests record linked to bookings through guest_id; do not use booking snapshots (guest_name/guest_email) as a cross-product identity. It must not be derived from a guest ID, email, phone, name or hash of PII.
- LexiBite stores that opaque reference with mapped property/outlet scope and the minimum state needed to recognise an eligible in-house guest.
- No PII in event payloads, logs, retries, dead-letter records or observability labels.
- LexiBite standalone restaurant customer profiles remain separate. No email/phone matching, automatic linking or profile merge.
- Reference rotation/revocation and retention/deletion rules must be defined before runtime activation. Expired or revoked references cannot establish in-house status.

### LB-02.04 — Guest-stay status projection
- StayNas is the sole authority for accommodation stay status.
- Direction: StayNas to LexiBite only. LexiBite cannot create, check in, check out, extend or cancel an accommodation stay.
- Initial vocabulary: expected, checked_in, checked_out, cancelled, no_show, departed_early.
- Events carry status version, occurred-at UTC timestamp, effective time where applicable, opaque guest reference, mapped property identity and correlation/idempotency keys.
- Duplicate, stale and out-of-order events are processed idempotently and cannot regress the current projection.
- A guest is eligible for in-house recognition only while the latest accepted StayNas status is checked_in and the reference is active.

### LB-02.05 — Event delivery and operational controls
- Transactional outbox at source; durable inbox/idempotency ledger at receiver.
- Signed transport reuses LB-01's authenticated service channel; no second credential mechanism.
- At-least-once delivery with idempotent processing, bounded exponential backoff with jitter, and explicit retryable vs terminal errors.
- Dead-letter records retain only event metadata, opaque references and redacted failure codes. No PII or credentials.
- Admin-controlled replay requires active connection, valid mapping and schema compatibility; replay cannot bypass tenant/property checks.
- Reconciliation compares mapping and event sequence watermarks, not guest PII.
- Per-connection/property health, lag, retry counts and DLQ depth are observable without exposing guest identity.

## 4. Canonical event contracts

Reuse LB-01 envelope, connection identity and signed transport. LB-02 adds typed events:
- property.profile_published.v1
- property.status_changed.v1
- outlet.published.v1
- outlet.status_changed.v1
- guest.reference_issued.v1
- guest.reference_revoked.v1
- guest.stay_status_changed.v1

Required envelope metadata: eventId, schemaVersion, eventVersion, sourceProduct, nativeTenantId, integrationPropertyId, aggregateId, occurredAt, publishedAt, correlationId, causationId and idempotencyKey.

Payloads are strict allow-listed schemas. Unknown fields are rejected. No guest PII or credentials.

## 5. Tenant, property and security invariants

1. Resolve tenant/property scope from the authenticated LB-01 connection, never from caller-controlled payload alone.
2. Validate every outlet belongs to the mapped LexiBite property.
3. Validate every guest reference belongs to the mapped StayNas property and active connection.
4. Enforce composite foreign keys and scoped unique constraints.
5. RLS denies browser-side writes to integration state; writes use authenticated server functions and narrowly scoped service-role RPCs.
6. A tenant cannot enumerate another tenant's properties, outlets, guest references, stay statuses, event payloads or DLQ records.
7. Suspension/revocation blocks new events immediately; reactivation requires explicit admin action and mapping revalidation.
8. No production schema, membership, tenant or guest data is changed by this workstream.

## 6. Proposed product-local persistence

Exact names/columns are subject to repository schema inspection before migrations.

StayNas:
- lb02_guest_reference_registry: opaque reference, local guest relation, property, state, expiry/revocation metadata. PII stays in the canonical StayNas guest domain.
- lb02_outbox_events: event envelope, sequence, delivery state, attempt count and timestamps.
- lb02_delivery_attempts: redacted attempt evidence and retry schedule.
- Reuse LB-01 connection/property mapping tables; do not duplicate credentials.

LexiBite:
- lb02_outlet_property_mappings: explicit local outlet to remote StayNas property mapping.
- lb02_guest_stay_projections: opaque guest reference, mapped property, status/version/effective timestamps and expiry.
- lb02_inbox_events: durable event ID/idempotency ledger and processing outcome.
- lb02_dead_letter_events: redacted terminal failures and controlled replay metadata.

## 7. Acceptance matrix

| Gate | Evidence required |
|---|---|
| Property mapping | Same tenant/property identity on both sides; mismatch, duplicate and cross-tenant attempts denied |
| Outlet mapping | Explicit approval; wrong-property mapping denied; rename/status updates propagated idempotently |
| Guest privacy | Payload/logs contain no PII; opaque reference is random, scoped and non-reversible |
| Guest reference lifecycle | Issue, revoke, expiry and cross-property isolation tests pass |
| Stay lifecycle | Check-in, check-out, cancel, no-show and early departure; stale events cannot regress state |
| Delivery reliability | Duplicate, timeout-after-commit, retry, backoff, DLQ, replay and reconciliation tests pass |
| Security | Wrong tenant/property, revoked credential, inactive connection, tampering and replay denied |
| Operations | Per-connection lag/error/DLQ observability and operator runbook accepted |
| UAT | Reciprocal tests using Nolmark CDMA UAT tenant and synthetic guest records only |

## 8. Explicit exclusions

POS orders/transactions, payments, folio posting, inventory/stock, menus/recipes/pricing, revenue sharing, unified customer profiles, cross-product subscriptions, data migration, unified dashboards and NoVA runtime dependency are outside LB-02.

## 9. Execution gates

Architecture and schema inspection may proceed while LB-01 deployment checks are pending. Runtime implementation, event publication, live credential exchange and UAT handshake remain blocked until LB-01 security certification and matching current-head deployments are available. No production promotion without a separate release decision.


## LexiBite implementation responsibility

LexiBite owns outlet data and consumes approved StayNas property/stay projections. It publishes outlet metadata to StayNas and stores only opaque in-house guest references/status. Standalone restaurant customer records remain isolated.
