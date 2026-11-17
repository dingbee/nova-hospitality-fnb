# LB-04 — LexiBite analytical contract

Status: implementation branch only; not deployed. Live-tenant inspection is read-only. UAT acceptance and production promotion remain separate gates.

## Ownership
LexiBite remains authoritative for POS transactions, menus, recipes, ingredient quantities, stock, movements, suppliers, purchase orders, food costs and outlet performance. StayNas remains authoritative for accommodation bookings, occupancy, folios and accommodation revenue. This schema stores governed analytical projections only; it does not consolidate source databases.

## Dependency gates
LB-01 connectivity, LB-02 guest/stay references and LB-03 folio posting/reversal/reconciliation must be accepted before cross-domain guest spend or certified combined revenue is enabled. A missing or unverified dependency must yield an explicit unavailable/reconciliation-required result.

## Canonical property mapping
`lb04_property_links` binds one LexiBite tenant/property to one StayNas organisation/property. Only active, verified and currency-aligned mappings may exchange data. The mapping contract is one-to-one; do not infer mappings from similar names or tenant ownership. No implicit USD fallback or unapproved FX.

## Evidence envelope
Metrics retain tenant, property, outlet, period, currency, source system, source record reference, source freshness and reconciliation state. Guest metrics are aggregated by approved cohort/period and must not expose raw identity or PII.

## Forecasts and advice
Occupancy-driven F&B demand requires verified in-house occupancy, observed meal capture rate, average spend and outlet capacity. Ingredient demand requires complete verified recipe lines and compatible units. Procurement advice uses available stock after reservations and open POs, supplier lead time, MOQ, pack size, supplier price and matching currency. Missing data withholds the affected calculation. Advice never mutates stock or issues purchase orders.

## Revenue and profitability
LexiBite is canonical for F&B economic events; StayNas is canonical for accommodation events. Count only posted and reconciled economic events. Exclude pending, cancelled, voided, comped and reversed events; deduplicate mirrored POS/folio events. Room-charged POS sales count once as F&B revenue only after LB-03 reconciliation, not again as a StayNas accommodation event. Keep property/currency totals separate. Profitability is withheld unless the relevant cost coverage is complete and currency-aligned.

## Anomalies and recommendations
Anomalies preserve deterministic rule, severity, source evidence and recommended investigation. Forecasts preserve method, model version, inputs, assumptions, horizon and reliability. Recommendations are advisory and require a human decision.

## Access and operations
Reads use property-aware `restaurant_can_read_scoped(tenant_id, property_id)` RLS. Writes are service-role only. Server integration endpoints must independently authenticate the peer, verify the active property mapping and scope every read/write by tenant and property. No production migration, source-data mutation or deployment is authorized by this branch.
