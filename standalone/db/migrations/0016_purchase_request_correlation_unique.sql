-- P10 — concurrency-safe idempotency for intelligence-originated purchase
-- requests.
--
-- executeRestaurantAction recovers an existing draft by
-- (tenant_id, correlation_id) after a partial failure, but nothing stopped
-- two truly concurrent executions of the same action from both passing that
-- recovery check (finding nothing yet) and both inserting a request. A
-- unique constraint is what lets the executor apply the same pattern
-- movements.server.ts's insertMovement already uses for its own dedupe key:
-- catch the 23505 unique-violation and treat it as "already happened,"
-- recovering the winner's row instead of erroring or duplicating.
alter table public.restaurant_purchase_requests
  add constraint restaurant_purchase_requests_tenant_correlation_key
  unique (tenant_id, correlation_id);
