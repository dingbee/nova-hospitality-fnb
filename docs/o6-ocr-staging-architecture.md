# O6 — Document/OCR capture staging architecture (design only)

Scope: this describes how a future delivery-note photo capability plugs into
the receiving basket built in O6. **No OCR or AI extraction API is called
anywhere in this codebase.** There is no AI infrastructure configured for
this project to call, and fabricating a result instead of a real integration
would violate the O6 mandate directly ("AI must never directly mutate
canonical inventory... if AI infra isn't configured, design the
architecture/fallback cleanly rather than fabricate results"). This document
is the fallback: the shape the feature will slot into, built now, populated
later.

## Why this doesn't need new tables

O6 already gave the receiving flow everything document capture needs:

- `restaurant_goods_receipts` / `restaurant_goods_receipt_items` — a
  draft-until-posted document. A draft receipt is already a safe place to
  hold provisional, human-unconfirmed lines; nothing derived from it touches
  the ledger until `postGoodsReceipt` runs.
- `restaurant_goods_receipt_items.capture_source` (migration
  `0012_inventory_identity.sql`) — `'manual' | 'barcode_scan' | 'ocr'`. Added
  in this phase specifically so a line can carry how it was captured without
  a parallel table. It defaults to `'manual'`; nothing sets it to `'ocr'`
  today because nothing produces an OCR line today.
- `catalog/matching.ts` (`matchCatalogItem`) — the same engine the receiving
  basket's search box calls (`matchInventoryItems` /
  `matchRestaurantInventoryItemsFn`). An OCR-extracted line name is just
  another `MatchQuery`; it does not need its own resolver.

So the pipeline the O6 brief specifies —
**RAW CAPTURE → EXTRACTION → MATCHING → VALIDATION → HUMAN REVIEW → POST** —
maps onto existing, already-tested primitives:

| Stage | What it is | Where it already lives |
|---|---|---|
| Raw capture | A photo of a delivery note | Not built. Would be a file input / camera capture, uploaded to Supabase Storage. No extraction happens client-side. |
| Extraction | Turn the photo into candidate lines (description, qty, unit cost) | Not built. Would be a server-only call to a real OCR/document-AI provider once one is actually configured for this project — never a client call, never a fabricated stub that pretends to have extracted something. |
| Matching | Resolve each extracted description to an existing catalog item | Already built: `matchCatalogItem` / `matchInventoryItems`. An extracted line is just a `{ name }` `MatchQuery` like a typed search. |
| Validation | Unit conversion, over-receipt checks, required rejection reasons | Already built: `postGoodsReceipt`'s pre-pass unit conversion (this phase's P0 fix) and `createGoodsReceipt`'s accepted+rejected+damaged ≤ received check run unconditionally, regardless of `capture_source`. |
| Human review | A person looks at the extracted basket before anything posts | Already built: the receiving basket is a draft the storekeeper edits (`updateBasketLine`, `removeBasketLine`) before choosing to post. An OCR-populated basket would render into the exact same review UI as a manually-typed one — same component, same validation, same post button. |
| Post | Commit accepted quantities as stock movements | Already built: `postGoodsReceipt`, unconditional on how the receipt got its lines. |

## The one guarantee this design enforces

**Extraction output is a proposal, never a write.** An OCR line would arrive
as a basket entry — `{ inventoryItemId?, description, quantity, unitCost,
capture_source: 'ocr' }` — the same shape the storekeeper's own typed entry
produces (`BasketLine` in `ProcurementCentre.tsx`). It goes through the same
`createFn`/`postGoodsReceipt` call, which means it goes through the same
server-side validation every other line does. There is no code path where an
extraction result reaches `restaurant_stock_movements` or
`restaurant_inventory_items.current_quantity` without a human clicking
"Post receiving" on a receipt that still has to pass unit-conversion and
over-receipt checks. This is the same non-negotiable this phase already
enforces for barcode scanning: capture method changes how a line gets into
the basket, never what happens once it's there.

## What's deliberately not built yet

- No storage bucket, no upload UI, no OCR provider call, no confidence
  scoring for extracted text. Building these now, against no configured AI
  infra, would mean stubbing fake extraction results — exactly what the O6
  brief prohibits.
- No new `capture_source` values beyond the three already defined. If a
  concrete provider is chosen later, `'ocr'` is enough to distinguish it from
  manual entry for audit purposes; a provider name, if ever needed, belongs
  in `restaurant_goods_receipt_items.notes` or a future nullable column, not
  a new identity table.

## What a future implementer needs to add

1. A raw-capture surface (upload/camera) that stores the image and calls a
   *server-only* extraction endpoint — never client-side, so an API key is
   never shipped to the browser and a client can never claim an extraction
   result the server didn't produce.
2. A mapping from the provider's output to `MatchQuery[]`, then
   `matchCatalogItem` per line — reusing, not duplicating, this phase's
   matching engine.
3. Basket entries built from the matches, `capture_source: 'ocr'`, rendered
   through the existing basket UI so a human reviews and edits before
   posting.

No inventory, receiving, or matching code changes are required to add this
later — only a new capture surface feeding the same basket.
