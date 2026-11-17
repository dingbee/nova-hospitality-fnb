# NOVA Hospitality F&B — Engineering Constitution

## Product identity

NOVA Hospitality F&B is an independent hospitality Restaurant & Bar
Operating System.

This repository is the canonical source of truth.

GitHub:
dingbee/nova-hospitality-fnb

## Absolute boundaries

DO NOT:

- modify Mtoni OS
- import Mtoni OS code
- introduce Mtoni runtime dependencies
- rebuild the product from scratch
- replace the existing architecture without evidence
- add features merely because they appear desirable
- weaken authentication, RBAC, RLS or tenant isolation
- bypass server authorization
- create UI-only security
- create duplicate authentication systems
- create duplicate RBAC systems
- invent new transactional models where an existing canonical model exists

## Development principle

BEFORE changing code:

1. inspect the existing implementation
2. trace the actual execution path
3. identify the authoritative source of truth
4. reproduce the problem
5. make the smallest correct change
6. add regression coverage
7. run the relevant tests
8. run the full quality gate when appropriate

NO GUESSING.

A filename, route, UI label, comment or type definition is NOT proof
that functionality works.

Functionality must be verified through executable code, database
behavior, integration tests or end-to-end behavior.

## Architecture

Canonical authorization:

user
→ role
→ permission
→ tenant/property/outlet scope

Never introduce a parallel role/permission system.

Canonical transactional principle:

all business mutations must be server-authorized and transactionally
consistent.

RLS is part of the security boundary.

## Restaurant

Canonical POS lifecycle:

Table
→ Order
→ Production
→ Service
→ Bill
→ Payment
→ Receipt
→ Closed

## Production routing

Production routing must remain server-enforced.

Food normally routes to KITCHEN.

Beverage/bar work normally routes to BAR.

Mixed orders must split correctly.

Never fix routing only in the UI.

## Inventory

Inventory-affecting operations must use the canonical stock movement
ledger.

Never modify inventory by directly manipulating derived quantities
unless the existing architecture explicitly requires it.

## Intelligence

NOVA Intelligence and external AI are separate concepts.

Do not replace deterministic business intelligence with an LLM merely
because an LLM is available.

## Database

Never modify production data casually.

Never weaken RLS to make a test pass.

Never expose service-role credentials to client code.

Prefer migrations over ad-hoc schema changes.

Every schema change requires appropriate regression coverage.

## Testing

Before declaring work complete:

- relevant unit tests
- relevant integration tests
- authorization tests
- database/RLS tests where applicable
- typecheck
- lint
- production build
- bundle verification

A failing test is evidence.

Do not delete or weaken tests to obtain a green result.

## Change discipline

For every task report:

1. root cause
2. files changed
3. behavior changed
4. tests added/changed
5. tests executed
6. remaining failures
7. deployment status

Do not claim success without evidence.

## Current priority

Prove and harden the existing product before adding new functionality.

The product is already substantially implemented.

The objective is NOT "build more."

The objective is:

PROVE → HARDEN → COMPLETE → DEPLOY.
