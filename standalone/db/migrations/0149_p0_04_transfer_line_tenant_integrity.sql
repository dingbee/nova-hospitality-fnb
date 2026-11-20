-- P0-04: close the remaining tenant-reference gap in transfer-line records.
-- Migration 0134 added tenant-scoped candidate keys and tenant-composite
-- references for transfer movements and transfer endpoints, but transfer
-- lines themselves still referenced their parent transfer, inventory item
-- and optional batch by id alone. A direct authenticated INSERT could
-- therefore attempt to attach a foreign-tenant parent/item/batch to a line
-- whose tenant_id belonged to another tenant. These constraints make the
-- tenant boundary a PostgreSQL invariant, independent of application code.
--
-- Existing single-column FKs remain in place; the composite FKs add the
-- missing same-tenant invariant while preserving the original delete action.
-- All constraints are validated in the migration; no NOT VALID residue is
-- accepted at the end of the migration.

ALTER TABLE public.restaurant_stock_transfer_lines
  ADD CONSTRAINT ts_stock_transfer_lines_transfer_id_p0_04
  FOREIGN KEY (tenant_id, transfer_id)
  REFERENCES public.restaurant_stock_transfers (tenant_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE public.restaurant_stock_transfer_lines
  VALIDATE CONSTRAINT ts_stock_transfer_lines_transfer_id_p0_04;
COMMENT ON CONSTRAINT ts_stock_transfer_lines_transfer_id_p0_04
  ON public.restaurant_stock_transfer_lines IS
  'P0-04: prevents a transfer line from referencing a transfer owned by another tenant.';

ALTER TABLE public.restaurant_stock_transfer_lines
  ADD CONSTRAINT ts_stock_transfer_lines_inventory_item_p0_04
  FOREIGN KEY (tenant_id, inventory_item_id)
  REFERENCES public.restaurant_inventory_items (tenant_id, id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.restaurant_stock_transfer_lines
  VALIDATE CONSTRAINT ts_stock_transfer_lines_inventory_item_p0_04;
COMMENT ON CONSTRAINT ts_stock_transfer_lines_inventory_item_p0_04
  ON public.restaurant_stock_transfer_lines IS
  'P0-04: prevents a transfer line from referencing inventory owned by another tenant.';

ALTER TABLE public.restaurant_stock_transfer_lines
  ADD CONSTRAINT ts_stock_transfer_lines_batch_p0_04
  FOREIGN KEY (tenant_id, batch_id)
  REFERENCES public.restaurant_inventory_batches (tenant_id, id)
  ON DELETE SET NULL (batch_id) NOT VALID;
ALTER TABLE public.restaurant_stock_transfer_lines
  VALIDATE CONSTRAINT ts_stock_transfer_lines_batch_p0_04;
COMMENT ON CONSTRAINT ts_stock_transfer_lines_batch_p0_04
  ON public.restaurant_stock_transfer_lines IS
  'P0-04: prevents a transfer line from referencing a batch owned by another tenant.';
