-- I6 — concurrency-safe idempotency for intelligence-originated pricing
-- reviews, mirroring 0016's restaurant_purchase_requests fix exactly.
--
-- restaurant_prices already has everything an Intelligence-created pricing
-- proposal needs: a versioned, superseding-never-mutating row shape and a
-- 'pending_approval' status that requires a *separate*, higher-privilege
-- decidePrice() call (capability pricing.approve, not pricing.manage) before
-- it can ever become the live price. The one thing missing is a way to
-- correlate a row back to the intelligence_action that raised it, so
-- executeRestaurantAction can recover an existing proposal by
-- (tenant_id, correlation_id) instead of ever creating a second one for the
-- same action — the same pattern restaurant_purchase_requests already uses.
alter table public.restaurant_prices
  add column correlation_id uuid;

alter table public.restaurant_prices
  add constraint restaurant_prices_tenant_correlation_key
  unique (tenant_id, correlation_id);
