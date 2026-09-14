-- P07 closure: covering indexes for the property/location columns
-- purchasing.server.ts and kitchen.server.ts now filter on directly (see the
-- P07 isolation fixes on restaurant_purchase_orders.property_id/location_id
-- and restaurant_kitchen_tickets.location_id) — live performance-advisor
-- check confirmed neither had a supporting index, so the new WHERE clauses
-- that close the property/outlet isolation gap would fall back to a
-- sequential scan as these tables grow. Row counts are tiny today (UAT
-- data), so a plain CREATE INDEX (brief SHARE lock, not ACCESS EXCLUSIVE) is
-- safe — CREATE INDEX CONCURRENTLY is not usable inside Supabase's migration
-- transaction wrapper (same constraint recorded in migration 0054).

CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_property_id ON public.restaurant_purchase_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_location_id ON public.restaurant_purchase_orders(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_tickets_location_id ON public.restaurant_kitchen_tickets(location_id);
