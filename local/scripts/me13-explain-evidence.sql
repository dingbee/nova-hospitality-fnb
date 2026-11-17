\timing on
set search_path = public;

\echo '=== 1. Order board: open orders for a location, ordered by opened_at ==='
explain (analyze, buffers, format text)
select id, order_number, status, total, opened_at
from restaurant_orders
where tenant_id = '11111111-1111-4111-8111-111111111111'
  and location_id = '33333333-3333-4333-8333-333333333331'
  and status in ('open','sent')
order by opened_at desc
limit 50;

\echo '=== 2. Order history report: tenant, recent window, paginated ==='
explain (analyze, buffers, format text)
select id, order_number, status, total, opened_at
from restaurant_orders
where tenant_id = '11111111-1111-4111-8111-111111111111'
order by opened_at desc
limit 50;

\echo '=== 3. Kitchen ticket queue: queued/preparing tickets for the tenant ==='
explain (analyze, buffers, format text)
select id, ticket_number, status, queued_at
from restaurant_kitchen_tickets
where tenant_id = '11111111-1111-4111-8111-111111111111'
  and status in ('queued','preparing')
order by queued_at
limit 100;

\echo '=== 4. Stock reconciliation view — full ledger GROUP BY (used by listReconciliation) ==='
explain (analyze, buffers, format text)
select * from restaurant_stock_reconciliation_v
where tenant_id = '11111111-1111-4111-8111-111111111111'
limit 100;

\echo '=== 5. Stock positions view — full ledger GROUP BY ==='
explain (analyze, buffers, format text)
select * from restaurant_stock_positions_v
where tenant_id = '11111111-1111-4111-8111-111111111111';

\echo '=== 6. getInventoryOverview wastage-sum query (7-day window, still fetches rows to sum in JS) ==='
explain (analyze, buffers, format text)
select movement_type, total_cost
from restaurant_stock_movements
where tenant_id = '11111111-1111-4111-8111-111111111111'
  and movement_type = 'wastage'
  and occurred_at >= now() - interval '7 days';

\echo '=== 7. getInventoryOverview transfers-pending — NOW a head-count query (ME-13 fix) ==='
explain (analyze, buffers, format text)
select id from restaurant_stock_transfers
where tenant_id = '11111111-1111-4111-8111-111111111111'
  and status in ('requested','approved','dispatched','partially_received');

\echo '=== 8. Payments for an order (payment history / receipt lookup) ==='
explain (analyze, buffers, format text)
select id, method, state, amount from restaurant_payments
where order_id = (select id from restaurant_orders where tenant_id='11111111-1111-4111-8111-111111111111' limit 1);

\echo '=== 9. lexibite_demo_sessions FK join (was unindexed before ME-13 migration 0088) ==='
explain (analyze, buffers, format text)
select s.* from lexibite_demo_sessions s
join lexibite_demo_registrations r on r.id = s.registration_id
limit 10;

\echo '=== 10. API request log rate-limit COUNT (P08 sliding window) ==='
explain (analyze, buffers, format text)
select count(*) from api_request_log
where credential_id = (select credential_id from api_request_log limit 1)
  and created_at >= now() - interval '1 minute';
