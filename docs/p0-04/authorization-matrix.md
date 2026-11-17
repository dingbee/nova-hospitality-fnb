# P0-04 Authorization Baseline — LexiBite Procurement

**Repository:** `dingbee/nova-hospitality-fnb`  
**Baseline source:** `src/modules/restaurant/core/permissions.ts` and `src/modules/restaurant/core/access.server.ts`  
**Status:** Implementation baseline; operational verification remains in progress.

## Canonical role vocabulary

The repository does not define separate `tenant_administrator`, `group_procurement_officer`, `property_general_manager`, `storekeeper`, `receiving_officer`, or `auditor` roles. Do not introduce these as aliases. The canonical roles are:

`owner`, `general_manager`, `restaurant_manager`, `chef`, `kitchen_manager`, `bartender`, `inventory_manager`, `purchasing_officer`, `accountant`, `viewer`, `api_service`.

Role labels do not determine scope. Scope comes from the member grant's `property_id`:
- `property_id IS NULL`: tenant-wide membership.
- `property_id = X`: property-scoped membership for property X only.

A property-scoped general manager is not a tenant-wide administrator. A group procurement officer is represented by a `purchasing_officer` grant with `property_id IS NULL`, not by a new role.

## Capability matrix

The following is the canonical application capability map. It is not a statement that a role has tenant-wide authority; every grant remains constrained by its property scope.

| Capability | Roles allowed by the canonical map |
|---|---|
| `inventory.manage` | owner, general_manager, restaurant_manager, inventory_manager, kitchen_manager, chef, bartender |
| `location.manage` | owner, general_manager, restaurant_manager |
| `purchasing.manage` | owner, general_manager, restaurant_manager, purchasing_officer, inventory_manager, accountant |
| `purchasing.approve` | owner, general_manager, restaurant_manager |
| `receiving.manage` | owner, general_manager, restaurant_manager, inventory_manager, purchasing_officer, kitchen_manager, chef |
| `invoice.manage` | owner, general_manager, restaurant_manager, accountant, purchasing_officer |
| `variance.manage` | owner, general_manager, restaurant_manager, accountant, purchasing_officer |
| `transfer.manage` | owner, general_manager, restaurant_manager, inventory_manager, kitchen_manager, chef, bartender |
| `transfer.approve` | owner, general_manager, restaurant_manager, inventory_manager |
| `stocktake.manage` | owner, general_manager, restaurant_manager, inventory_manager, kitchen_manager, chef, bartender |
| `stocktake.approve` | owner, general_manager, restaurant_manager, inventory_manager, accountant |
| `intelligence.read` | owner, general_manager, restaurant_manager, chef, kitchen_manager, inventory_manager, purchasing_officer, accountant, bartender |

## Scope invariants

| Operation | Required effective scope |
|---|---|
| Property inventory read/write | Matching capability plus membership grant covering the item's property |
| Property storage location management | `location.manage` grant covering that property |
| Tenant central-store read | Matching capability plus explicit tenant-wide membership |
| Tenant central-store write/manage | Matching capability plus explicit tenant-wide membership; database RLS independently restricts central-store writes to tenant-wide owner/general_manager |
| Central-to-property transfer | Transfer capability at both endpoints; central endpoint requires tenant-wide grant |
| Property-to-central transfer | Transfer capability at both endpoints; central endpoint requires tenant-wide grant |
| Property-to-property transfer | Transfer capability at both endpoints; a property-only member must hold scope at both properties |
| Transfer approval | `transfer.approve`, both endpoint scopes, and maker-checker when approval is required |
| Stocktake approval/posting | `stocktake.approve`, the stocktake's property/location scope, and an independent approver |
| Procurement variance resolution | `variance.manage`, variance property/location scope, and an actor independent of the recorded variance creator |
| Supplier invoice three-way reconciliation | `invoice.manage`, invoice property/location scope, and an actor independent of the invoice recorder |

## Special identities and entitlements

- `viewer` has no write capabilities in the canonical map. Read access remains subject to tenant membership and RLS.
- `api_service` has only `sales.manage`; it does not inherit inventory, purchasing, receiving, transfer or approval capabilities.
- `inventory_agent` is a commercial entitlement, not an operational role or approval capability. It does not confer purchasing approval, transfer approval, dispatch or receipt authority.
- The repository has no distinct storekeeper or receiving-officer role. Operational access is granted through the existing inventory/receiving capabilities and scoped canonical roles.

## P0-04 implementation deltas

- `assertCapability` now validates location ownership using both `tenant_id` and location ID. Tenant-central locations require a matching tenant-wide capability grant.
- Location-management writes now pass explicit property or tenant-wide scope.
- Transfer approval now enforces maker-checker for approval-required transfers.
- Stocktake posting now checks both property/location scope and creator/counter separation.
- Purchase-order approval now routes through the configurable approval-rule engine after the capability check.
- Procurement variances now record immutable creator attribution; resolution checks scope and rejects self-resolution.
- Database migrations 0137–0140 add tenant-composite transfer-line references, active-location write guards, immutable variance creator attribution, and immutable supplier-invoice recorder attribution.
- Invoice recording no longer auto-runs the three-way match; a separate authorized user must perform reconciliation.

## Verification still required

The matrix must be exercised through real server-function calls and isolated PostgreSQL identities. Static capability membership is not a passing security test. Transfer partial-receipt idempotency/concurrency and full RLS adversarial coverage remain outstanding until their persisted tests pass.
