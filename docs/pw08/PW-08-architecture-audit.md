# PW-08 — Supplier Invoice Reconciliation Architecture Audit

**Baseline:** PW-07 certified commit `7f6c781a579f40842ffc0e15b9eb46c964a24c6c` (9 commits ahead of `main`; PR #186 remains unmerged and draft). PW-08 is developed on top of that certified integration branch. No production deployment or production database write is authorised or performed.

## Existing assets verified

- `restaurant_supplier_invoices` and `restaurant_supplier_invoice_items` already exist in the core schema.
- `invoices.server.ts` already records invoices, performs a basic PO/receipt/invoice match, emits events, writes procurement audit entries, and records invoiced supplier price observations.
- Existing invoice line schema supports optional PO-line and receipt-line references, quantity, unit price, and tax.
- Existing variance engine supports quantity, price, tax and invoice variances.
- Procurement permissions already include `invoice.manage` and `variance.manage`.
- Reconciliation exception engine already consumes invoice match status and outstanding invoice amounts.
- Operational Cost Intelligence already computes profitability from stock movements and operational expense allocations; it does not yet have an auditable supplier-invoice accrual/credit adjustment feed.

## Confirmed implementation gaps

1. **Fail-open reads:** PO, receipt, and line-query errors in the current matcher are not consistently checked; incomplete evidence can be mistaken for a match.
2. **Weak three-way linkage:** invoice receipt-line references are not validated against posted receipts and the exact PO line; missing or foreign references can be skipped.
3. **Currency integrity:** invoice, PO and receipt currencies are not compared before monetary values are compared.
4. **Tax integrity:** invoice header subtotal/tax/total is not reconciled against its lines; the current matcher compares invoice gross total to PO/accepted values without separating tax.
5. **Partial billing:** matching treats invoice quantity against cumulative accepted quantity as a binary comparison, without a clear pending/partial/mismatch distinction.
6. **Supplier/PO integrity:** invoice supplier and PO supplier relationship is not verified at record time.
7. **Payment integrity:** payment status and amount paid can diverge; amount paid is not bounded by invoice total and status is not derived from the balance.
8. **Credit notes:** no first-class supplier credit-note document, application history, or credit-balance treatment exists.
9. **Atomicity and audit reliability:** invoice header and lines are inserted in separate calls; audit helper logs and suppresses failures, so a partially recorded document is possible.
10. **Test gap:** no dedicated `invoices.server.test.ts` was present on the inspected baseline; the existing invoice matching path had no focused regression suite.

## PW-08 implementation sequence

- PW08.01: deterministic reconciliation calculator with explicit evidence, currency, tax, quantity and price outcomes; pure unit tests.
- PW08.02: server-side three-way matching rewritten to fail closed on missing/error evidence, validate tenant/supplier/PO/receipt linkage, and persist only evidence-backed status/variance outcomes.
- PW08.03: payment balance invariants and audit coverage.
- PW08.04: credit-note lifecycle, application limits, immutable source references and audit trail.
- PW08.05: Operational Cost Intelligence bridge for verified net supplier costs, tax separation and credit adjustments without double-counting inventory receipts.
- PW08.06: UI workflow, tenant/property isolation, end-to-end tests, migration verification and consolidated CI certification.

## Guardrails

- No FX conversion or implicit currency substitution. A currency mismatch is an exception, never a guessed conversion.
- Invoice tax remains separate from net procurement cost.
- Only posted receipts count as accepted delivery evidence.
- A mismatch is surfaced, never auto-approved.
- Credit notes reduce payable balances only when explicitly applied and never rewrite historical invoices, receipts or stock movements.
- Production data, roles, migrations and deployments remain untouched during this phase.
