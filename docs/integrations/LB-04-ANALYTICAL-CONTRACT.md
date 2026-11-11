# LB-04 — LexiBite analytical contract
Status: foundation implementation on `feat/lb04-operational-intelligence`. UAT only.

## Ownership
LexiBite remains authoritative for POS transactions, menus, recipes, ingredient quantities, stock, movements, suppliers, purchase orders, food costs and outlet performance. This schema stores governed analytical projections only.

## Canonical mapping
`lb04_property_links` binds a LexiBite tenant/property to one StayNas organisation/property. Only verified active mappings may exchange data. Currency is explicit and must match the property configuration; no implicit USD fallback or unapproved FX.

## Evidence envelope
Metrics retain tenant, property, outlet, period, currency, source system, source record reference, source freshness and reconciliation state. Guest metrics must be aggregated and non-identifying.

## Forecasts and advice
Forecast records distinguish projections from actuals and preserve method, model version, inputs, assumptions, horizon and reliability. Inventory and procurement recommendations are advisory; they do not mutate stock or issue purchase orders.

## Access
Reads use property-aware `restaurant_can_read_scoped` RLS. Writes are service-role only. Server integration endpoints must independently authenticate the peer, verify the active property mapping and scope every read/write by tenant and property. No production migration or deployment is authorized by this branch.
