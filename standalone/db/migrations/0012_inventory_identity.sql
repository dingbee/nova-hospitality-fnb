-- O6 — Intelligent Inventory & Receiving: identity fields.
--
-- restaurant_inventory_items already distinguishes NOVA's internal id (id),
-- a NOVA-facing SKU (sku) and per-supplier codes (restaurant_supplier_
-- products.supplier_sku) — three separate identity concepts, none of them
-- overwritten by this migration. What's missing is a barcode: the one
-- identifier a storekeeper scans that NOVA never captured anywhere. Added
-- here as its own column, distinct from sku and from supplier_sku, so a
-- barcode scan and a SKU lookup are never conflated.
--
-- brand is added alongside it — listed explicitly in the O6 identity
-- audit as a distinct concept from name/category, and currently absent.

ALTER TABLE public.restaurant_inventory_items
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS brand text;

-- A barcode, when present, must be unique within a tenant — but most items
-- will have none, so this is a partial index rather than a NOT NULL unique
-- constraint. Scanning an unknown barcode is expected and handled in the
-- application layer (search or create), not rejected at the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_inv_items_barcode
  ON public.restaurant_inventory_items (tenant_id, barcode)
  WHERE barcode IS NOT NULL;

-- Same identity gap exists one level down: a supplier's own product listing
-- can carry a barcode distinct from (or identical to) the canonical item's,
-- e.g. a supplier selling the same item under a different pack barcode.
ALTER TABLE public.restaurant_supplier_products
  ADD COLUMN IF NOT EXISTS barcode text;

CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_products_barcode
  ON public.restaurant_supplier_products (tenant_id, barcode)
  WHERE barcode IS NOT NULL;

-- Traceability for how a receipt line's data arrived — manual entry, a
-- barcode scan, or (later) OCR extraction — without inventing a parallel
-- capture/staging table. A goods receipt already IS the staging object
-- (status: draft until explicitly posted); this only records provenance
-- on top of that existing lifecycle.
ALTER TABLE public.restaurant_goods_receipt_items
  ADD COLUMN IF NOT EXISTS capture_source text NOT NULL DEFAULT 'manual'
    CHECK (capture_source IN ('manual', 'barcode_scan', 'ocr'));
