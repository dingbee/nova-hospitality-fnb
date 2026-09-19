-- ME-13 synthetic load-test dataset. LOCAL ONLY — never run against production.
-- Builds on standalone/db/seed/demo/0100_demo_restaurant_bar.sql (1 tenant/property,
-- 3 locations, 15 menu items, 24 inventory items, 12 tables, 3 stations).
-- Generates ~90 days of order history at realistic restaurant volume so EXPLAIN
-- ANALYZE reflects a ledger past "toy scale" rather than the ~1.1k-row database
-- ME-01's own report measured against.
set search_path = public;

DO $seed$
DECLARE
  t_id uuid := '11111111-1111-4111-8111-111111111111';
  p_id uuid := '22222222-2222-4222-8222-222222222222';
  loc_rest uuid := '33333333-3333-4333-8333-333333333331';
  loc_bar  uuid := '33333333-3333-4333-8333-333333333332';
  store_dry uuid := '33333333-3333-4333-8333-333333333333';
  staff_user uuid;
  n_orders int := 30000;
  n_days int := 90;
BEGIN
  -- one synthetic staff user for created_by/server_user_id/actor FKs
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('99999999-9999-4999-8999-999999999999', 'me13-load@local.test', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
  staff_user := '99999999-9999-4999-8999-999999999999';

  ---------------------------------------------------------------- orders
  INSERT INTO restaurant_orders (
    id, tenant_id, property_id, location_id, table_id, order_number, order_type,
    status, payment_state, guest_count, server_user_id, source, opened_at, closed_at,
    subtotal, tax_total, total, paid_total, currency, created_by, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    t_id, p_id,
    (ARRAY[loc_rest, loc_bar])[1 + (g % 2)],
    (SELECT id FROM restaurant_tables ORDER BY id OFFSET (g % 12) LIMIT 1),
    'ORD-' || lpad(g::text, 7, '0'),
    'dine_in',
    (ARRAY['closed','closed','closed','closed','closed','closed','closed','closed','open','cancelled'])[1 + (g % 10)]::restaurant_order_status,
    (ARRAY['paid','paid','paid','paid','paid','paid','paid','paid','unpaid','unpaid'])[1 + (g % 10)]::restaurant_payment_state,
    1 + (g % 6),
    staff_user,
    'pos',
    now() - ((n_days - (g % n_days)) || ' days')::interval - ((g % 720) || ' minutes')::interval,
    CASE WHEN g % 10 < 8 THEN now() - ((n_days - (g % n_days)) || ' days')::interval - ((g % 720) || ' minutes')::interval + '35 minutes'::interval ELSE NULL END,
    (20000 + (g % 400) * 500)::numeric,
    ((20000 + (g % 400) * 500) * 0.18)::numeric,
    ((20000 + (g % 400) * 500) * 1.18)::numeric,
    CASE WHEN g % 10 < 8 THEN ((20000 + (g % 400) * 500) * 1.18)::numeric ELSE 0 END,
    'TZS', staff_user,
    now() - ((n_days - (g % n_days)) || ' days')::interval,
    now() - ((n_days - (g % n_days)) || ' days')::interval
  FROM generate_series(1, n_orders) AS g
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'orders inserted: %', (SELECT count(*) FROM restaurant_orders WHERE tenant_id = t_id);

  ---------------------------------------------------------------- order items (avg 3 lines/order)
  INSERT INTO restaurant_order_items (
    id, tenant_id, order_id, menu_item_id, station_id, description, quantity, unit_price,
    line_total, unit_cost, line_cost, status, created_at, updated_at, currency
  )
  SELECT
    gen_random_uuid(), t_id, o.id,
    mi.id, mi_station.id,
    mi.name,
    1 + (li % 3),
    mi.price,
    mi.price * (1 + (li % 3)),
    mi.price * 0.35,
    mi.price * 0.35 * (1 + (li % 3)),
    'served',
    o.created_at, o.created_at, 'TZS'
  FROM restaurant_orders o
  CROSS JOIN LATERAL generate_series(0, 2) AS li
  JOIN LATERAL (
    SELECT id, name, price FROM restaurant_menu_items
    WHERE tenant_id = t_id
    OFFSET ((abs(hashtext(o.id::text || li::text))) % 15) LIMIT 1
  ) mi ON true
  LEFT JOIN LATERAL (
    SELECT id FROM restaurant_stations WHERE tenant_id = t_id
    OFFSET ((abs(hashtext(o.id::text || li::text || 'st'))) % 3) LIMIT 1
  ) mi_station ON true
  WHERE o.tenant_id = t_id
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'order items inserted: %', (SELECT count(*) FROM restaurant_order_items WHERE tenant_id = t_id);

  ---------------------------------------------------------------- payments (one per closed/paid order)
  INSERT INTO restaurant_payments (
    id, tenant_id, order_id, method, state, amount, currency, captured_at, created_by, created_at, updated_at
  )
  SELECT gen_random_uuid(), t_id, o.id,
    (ARRAY['cash','card','mobile_money'])[1 + (abs(hashtext(o.id::text)) % 3)],
    'paid', o.total, 'TZS', o.closed_at, staff_user, o.closed_at, o.closed_at
  FROM restaurant_orders o
  WHERE o.tenant_id = t_id AND o.payment_state = 'paid' AND o.closed_at IS NOT NULL
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'payments inserted: %', (SELECT count(*) FROM restaurant_payments WHERE tenant_id = t_id);

  ---------------------------------------------------------------- kitchen tickets (one per order, items per ticket)
  INSERT INTO restaurant_kitchen_tickets (
    id, tenant_id, order_id, station_id, location_id, ticket_number, status, queued_at, started_at, ready_at, served_at, created_by, created_at, updated_at
  )
  SELECT gen_random_uuid(), t_id, o.id,
    (SELECT id FROM restaurant_stations WHERE tenant_id = t_id OFFSET (abs(hashtext(o.id::text)) % 3) LIMIT 1),
    o.location_id,
    'TCK-' || lpad(row_number() OVER (ORDER BY o.id)::text, 7, '0'),
    (ARRAY['served','served','served','served','served','served','served','ready','queued','cancelled'])[1 + (abs(hashtext(o.id::text)) % 10)]::restaurant_ticket_status,
    o.opened_at, o.opened_at + '2 minutes'::interval, o.opened_at + '12 minutes'::interval, o.opened_at + '15 minutes'::interval,
    staff_user, o.opened_at, o.opened_at
  FROM restaurant_orders o
  WHERE o.tenant_id = t_id
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'kitchen tickets inserted: %', (SELECT count(*) FROM restaurant_kitchen_tickets WHERE tenant_id = t_id);

  INSERT INTO restaurant_kitchen_ticket_items (
    id, tenant_id, ticket_id, order_item_id, menu_item_id, description, quantity, status, created_at, updated_at
  )
  SELECT gen_random_uuid(), t_id, kt.id, oi.id, oi.menu_item_id, oi.description, oi.quantity, 'served', kt.created_at, kt.created_at
  FROM restaurant_kitchen_tickets kt
  JOIN restaurant_order_items oi ON oi.order_id = kt.order_id
  WHERE kt.tenant_id = t_id
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'kitchen ticket items inserted: %', (SELECT count(*) FROM restaurant_kitchen_ticket_items WHERE tenant_id = t_id);

  ---------------------------------------------------------------- stock movements (one per order, sale-consumption shaped —
  -- capped at one per order rather than per order-item so the per-row
  -- restaurant_apply_stock_movement trigger's cost is measured at a
  -- representative ledger volume without the generator itself dominating
  -- runtime; the trigger's own per-row cost is exactly the same regardless
  -- of which order_item a movement is attributed to).
  INSERT INTO restaurant_stock_movements (
    id, tenant_id, property_id, location_id, inventory_item_id, unit_id, movement_type,
    quantity, unit_cost, total_cost, currency, reference_type, order_item_id, occurred_at, created_by, created_at
  )
  SELECT gen_random_uuid(), t_id, p_id, store_dry,
    ii.id, ii.unit_id, 'consumption',
    -0.1, ii.average_cost, -0.1 * ii.average_cost, 'TZS',
    'restaurant_order_item', first_item.id, o.created_at, staff_user, o.created_at
  FROM restaurant_orders o
  JOIN LATERAL (
    SELECT id FROM restaurant_order_items WHERE order_id = o.id ORDER BY id LIMIT 1
  ) first_item ON true
  JOIN LATERAL (
    SELECT id, unit_id, average_cost FROM restaurant_inventory_items
    WHERE tenant_id = t_id
    OFFSET (abs(hashtext(o.id::text)) % 24) LIMIT 1
  ) ii ON true
  WHERE o.tenant_id = t_id
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'stock movements inserted: %', (SELECT count(*) FROM restaurant_stock_movements WHERE tenant_id = t_id);
END
$seed$;
