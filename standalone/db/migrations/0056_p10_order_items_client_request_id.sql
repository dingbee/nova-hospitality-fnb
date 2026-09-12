-- P10 — Offline Operations Capability.
--
-- addPosLines (adding items to an already-open order) had no idempotency
-- mechanism, unlike openPosOrder/takePosPayment which already dedupe via a
-- unique restaurant_orders.client_request_id / restaurant_payments.
-- client_request_id. Extends the same existing mechanism rather than
-- inventing a parallel one: a nullable client_request_id column, stamped
-- on every row one addPosLines call inserts (see sales.server.ts's
-- insertLines, pos.server.ts's addPosLines).
--
-- Unlike orders/payments (one row = one idempotency key, enforced with a
-- unique index), one addPosLines call inserts N order_item rows sharing
-- the SAME client_request_id — so this is deliberately NOT a unique index.
-- addPosLines instead does an existence check (any row with this
-- tenant_id/order_id/client_request_id already exists ⇒ return it,
-- idempotent, never insert again) before inserting, mirroring
-- openPosOrder's own check-before-create shape at the batch level.

ALTER TABLE public.restaurant_order_items
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE INDEX IF NOT EXISTS restaurant_order_items_client_request_idx
  ON public.restaurant_order_items (tenant_id, order_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
