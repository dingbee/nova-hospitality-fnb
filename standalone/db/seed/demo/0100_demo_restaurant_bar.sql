-- Demo Restaurant & Bar — 100% synthetic data.
-- No NOVA tenant, property, guest, booking, rate, asset or identifier appears here.
-- Idempotent: safe to re-run.
set search_path = public;

DO $seed$
DECLARE
  t_id      uuid := '11111111-1111-4111-8111-111111111111';
  p_id      uuid := '22222222-2222-4222-8222-222222222222';
  loc_rest  uuid := '33333333-3333-4333-8333-333333333331';
  loc_bar   uuid := '33333333-3333-4333-8333-333333333332';
  store_dry uuid := '33333333-3333-4333-8333-333333333333';
  u_ea uuid; u_kg uuid; u_g uuid; u_l uuid; u_ml uuid; u_btl uuid;
  ic_prod uuid; ic_meat uuid; ic_dry uuid; ic_bev uuid;
  mc_start uuid; mc_main uuid; mc_dess uuid; mc_cock uuid; mc_beer uuid;
  v_menu_id uuid;
  st_hot uuid; st_cold uuid; st_bar uuid;
  sup_a uuid; sup_b uuid; sup_c uuid; sup_d uuid;
  rec_id uuid; mi_id uuid; usr uuid;
BEGIN
  ---------------------------------------------------------------- tenant
  INSERT INTO restaurant_tenants (id, slug, name, status, settings)
  VALUES (t_id, 'demo-restaurant-bar', 'Demo Restaurant & Bar', 'active',
          jsonb_build_object('currency','TZS','locale','en','demo',true))
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO restaurant_properties (id, tenant_id, slug, name, timezone, currency)
  VALUES (p_id, t_id, 'demo-house', 'Demo House', 'Africa/Dar_es_Salaam', 'TZS')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO restaurant_locations (id, tenant_id, property_id, slug, name, location_type) VALUES
    (loc_rest, t_id, p_id, 'main-restaurant', 'Main Restaurant', 'restaurant'),
    (loc_bar,  t_id, p_id, 'terrace-bar',     'Terrace Bar',     'bar'),
    (store_dry,t_id, p_id, 'dry-store',       'Dry Store',       'store')
  ON CONFLICT (id) DO NOTHING;

  ---------------------------------------------------------------- units
  INSERT INTO restaurant_inventory_units (tenant_id, code, name, dimension, factor) VALUES
    (t_id,'ea','Each','count',1), (t_id,'kg','Kilogram','mass',1),
    (t_id,'g','Gram','mass',0.001), (t_id,'l','Litre','volume',1),
    (t_id,'ml','Millilitre','volume',0.001), (t_id,'btl','Bottle','count',1),
    (t_id,'case','Case','count',1), (t_id,'pkt','Packet','count',1)
  ON CONFLICT DO NOTHING;
  SELECT id INTO u_ea  FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='ea';
  SELECT id INTO u_kg  FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='kg';
  SELECT id INTO u_g   FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='g';
  SELECT id INTO u_l   FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='l';
  SELECT id INTO u_ml  FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='ml';
  SELECT id INTO u_btl FROM restaurant_inventory_units WHERE tenant_id=t_id AND code='btl';

  ---------------------------------------------------------------- inventory categories
  INSERT INTO restaurant_inventory_categories (tenant_id, name, slug, kind) VALUES
    (t_id,'Produce','produce','ingredient'), (t_id,'Meat & Fish','meat-fish','ingredient'),
    (t_id,'Dry Goods','dry-goods','ingredient'), (t_id,'Beverages','beverages','beverage'),
    (t_id,'Cleaning','cleaning','consumable')
  ON CONFLICT (tenant_id, slug) DO NOTHING;
  SELECT id INTO ic_prod FROM restaurant_inventory_categories WHERE tenant_id=t_id AND slug='produce';
  SELECT id INTO ic_meat FROM restaurant_inventory_categories WHERE tenant_id=t_id AND slug='meat-fish';
  SELECT id INTO ic_dry  FROM restaurant_inventory_categories WHERE tenant_id=t_id AND slug='dry-goods';
  SELECT id INTO ic_bev  FROM restaurant_inventory_categories WHERE tenant_id=t_id AND slug='beverages';

  ---------------------------------------------------------------- ingredients / stock
  INSERT INTO restaurant_inventory_items
    (tenant_id, property_id, location_id, category_id, unit_id, sku, name, item_type,
     current_quantity, par_level, reorder_point, average_cost, currency) VALUES
    (t_id,p_id,store_dry,ic_prod,u_kg,'ING-TOM','Tomatoes','ingredient',      18.5, 25, 10, 3200,'TZS'),
    (t_id,p_id,store_dry,ic_prod,u_kg,'ING-ONI','Red Onions','ingredient',    22.0, 30, 12, 2400,'TZS'),
    (t_id,p_id,store_dry,ic_prod,u_kg,'ING-POT','Potatoes','ingredient',      40.0, 50, 20, 1900,'TZS'),
    (t_id,p_id,store_dry,ic_prod,u_kg,'ING-LET','Lettuce','ingredient',        6.0, 12,  6, 4100,'TZS'),
    (t_id,p_id,store_dry,ic_prod,u_kg,'ING-LIM','Limes','ingredient',          7.5, 10,  4, 5200,'TZS'),
    (t_id,p_id,store_dry,ic_meat,u_kg,'ING-BEF','Beef Striploin','ingredient', 12.0, 20,  8,24500,'TZS'),
    (t_id,p_id,store_dry,ic_meat,u_kg,'ING-CHK','Chicken Breast','ingredient', 16.0, 25, 10,11800,'TZS'),
    (t_id,p_id,store_dry,ic_meat,u_kg,'ING-FSH','Red Snapper','ingredient',     5.5, 15,  7,18900,'TZS'),
    (t_id,p_id,store_dry,ic_meat,u_kg,'ING-PRW','Prawns','ingredient',          3.2, 10,  5,32000,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_kg,'ING-RIC','Basmati Rice','ingredient',   55.0, 60, 25, 4300,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_kg,'ING-FLR','Flour','ingredient',          30.0, 40, 15, 2100,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_l ,'ING-OIL','Sunflower Oil','ingredient',  24.0, 30, 12, 6800,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_kg,'ING-SLT','Sea Salt','ingredient',        9.0, 10,  4, 1500,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_kg,'ING-SUG','Sugar','ingredient',          14.0, 20,  8, 2800,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_l ,'ING-CRM','Cream','ingredient',           8.0, 12,  5, 7400,'TZS'),
    (t_id,p_id,store_dry,ic_dry ,u_kg,'ING-BTR','Butter','ingredient',          6.0, 10,  4,12600,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-GIN','London Dry Gin 700ml','beverage', 9, 12, 5,42000,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-RUM','White Rum 700ml','beverage',      7, 12, 5,38000,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-VOD','Vodka 700ml','beverage',          4, 12, 5,36000,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-WHT','Whisky 700ml','beverage',        11, 12, 5,58000,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-TON','Tonic Water 200ml','beverage',   64, 72,30, 1400,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-BEE','Local Lager 500ml','beverage',   96,120,48, 2300,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-WNE','House Red 750ml','beverage',     18, 24,10,26000,'TZS'),
    (t_id,p_id,loc_bar ,ic_bev ,u_btl,'BEV-SOD','Soda 300ml','beverage',         120,144,60,  900,'TZS')
  ON CONFLICT (tenant_id, sku) DO NOTHING;

  ---------------------------------------------------------------- menu structure
  INSERT INTO restaurant_categories (tenant_id, property_id, kind, name, slug, sort_order) VALUES
    (t_id,p_id,'menu','Starters','starters',10), (t_id,p_id,'menu','Mains','mains',20),
    (t_id,p_id,'menu','Desserts','desserts',30), (t_id,p_id,'menu','Cocktails','cocktails',40),
    (t_id,p_id,'menu','Beer & Wine','beer-wine',50), (t_id,p_id,'menu','Soft Drinks','soft-drinks',60)
  ON CONFLICT (tenant_id, kind, slug) DO NOTHING;
  SELECT id INTO mc_start FROM restaurant_categories WHERE tenant_id=t_id AND slug='starters';
  SELECT id INTO mc_main  FROM restaurant_categories WHERE tenant_id=t_id AND slug='mains';
  SELECT id INTO mc_dess  FROM restaurant_categories WHERE tenant_id=t_id AND slug='desserts';
  SELECT id INTO mc_cock  FROM restaurant_categories WHERE tenant_id=t_id AND slug='cocktails';
  SELECT id INTO mc_beer  FROM restaurant_categories WHERE tenant_id=t_id AND slug='beer-wine';

  INSERT INTO restaurant_menus (tenant_id, property_id, location_id, name, slug, version, status, currency, description)
  VALUES (t_id, p_id, loc_rest, 'All Day Menu', 'all-day', 1, 'published', 'TZS', 'Demo published menu')
  ON CONFLICT (tenant_id, slug, version) DO NOTHING;
  SELECT id INTO v_menu_id FROM restaurant_menus WHERE tenant_id=t_id AND slug='all-day' AND version=1;

  INSERT INTO restaurant_menu_items (tenant_id, menu_id, category_id, name, slug, description, price, currency, cost_price, allergens, sort_order) VALUES
    (t_id,v_menu_id,mc_start,'Tomato & Onion Salad','tomato-onion-salad','Vine tomato, red onion, herbs',9000,'TZS',2600,'{}',10),
    (t_id,v_menu_id,mc_start,'Prawn Skewers','prawn-skewers','Grilled prawns, lime butter',18000,'TZS',7400,'{shellfish,dairy}',20),
    (t_id,v_menu_id,mc_start,'Soup of the Day','soup-of-the-day','Chef selection',7500,'TZS',2100,'{dairy}',30),
    (t_id,v_menu_id,mc_main ,'Grilled Snapper','grilled-snapper','Whole snapper, rice, salad',32000,'TZS',12400,'{fish}',10),
    (t_id,v_menu_id,mc_main ,'Beef Striploin','beef-striploin','250g striploin, potatoes',46000,'TZS',18600,'{}',20),
    (t_id,v_menu_id,mc_main ,'Chicken Curry','chicken-curry','Coconut curry, basmati rice',26000,'TZS',8900,'{}',30),
    (t_id,v_menu_id,mc_main ,'Vegetable Biryani','vegetable-biryani','Spiced rice, seasonal vegetables',21000,'TZS',5600,'{}',40),
    (t_id,v_menu_id,mc_dess ,'Chocolate Tart','chocolate-tart','Dark chocolate, cream',12000,'TZS',3900,'{dairy,gluten,eggs}',10),
    (t_id,v_menu_id,mc_dess ,'Fresh Fruit Plate','fresh-fruit-plate','Seasonal fruit',9000,'TZS',2400,'{}',20),
    (t_id,v_menu_id,mc_cock ,'Gin & Tonic','gin-tonic','Double gin, tonic, lime',14000,'TZS',4600,'{}',10),
    (t_id,v_menu_id,mc_cock ,'Daiquiri','daiquiri','White rum, lime, sugar',15000,'TZS',4300,'{}',20),
    (t_id,v_menu_id,mc_cock ,'Old Fashioned','old-fashioned','Whisky, sugar, bitters',18000,'TZS',6100,'{}',30),
    (t_id,v_menu_id,mc_beer ,'Local Lager','local-lager','500ml bottle',6000,'TZS',2300,'{gluten}',10),
    (t_id,v_menu_id,mc_beer ,'House Red (Glass)','house-red-glass','175ml pour',11000,'TZS',6100,'{sulphites}',20),
    (t_id,v_menu_id,mc_beer ,'Soda','soda','300ml bottle',3500,'TZS',900,'{}',30)
  ON CONFLICT (menu_id, slug) DO NOTHING;

  ---------------------------------------------------------------- stations, periods, tables
  INSERT INTO restaurant_stations (tenant_id, property_id, location_id, code, name, station_type, target_prep_minutes, sort_order) VALUES
    (t_id,p_id,loc_rest,'HOT','Hot Kitchen','kitchen',18,10),
    (t_id,p_id,loc_rest,'COLD','Cold Larder','kitchen',8,20),
    (t_id,p_id,loc_bar ,'BAR','Bar','bar',5,30)
  ON CONFLICT DO NOTHING;
  SELECT id INTO st_hot FROM restaurant_stations WHERE tenant_id=t_id AND code='HOT';
  SELECT id INTO st_bar FROM restaurant_stations WHERE tenant_id=t_id AND code='BAR';

  INSERT INTO restaurant_service_periods (tenant_id, property_id, location_id, code, name, start_time, end_time, sort_order) VALUES
    (t_id,p_id,loc_rest,'BRK','Breakfast','06:30','10:30',10),
    (t_id,p_id,loc_rest,'LUN','Lunch','12:00','15:00',20),
    (t_id,p_id,loc_rest,'DIN','Dinner','18:30','22:30',30),
    (t_id,p_id,loc_bar ,'BAR','Bar Service','11:00','23:30',40)
  ON CONFLICT DO NOTHING;

  INSERT INTO restaurant_tables (tenant_id, property_id, location_id, code, name, zone, seats)
  SELECT t_id, p_id, loc_rest, 'T'||g, 'Table '||g, 'Terrace', CASE WHEN g % 3 = 0 THEN 6 ELSE 4 END
  FROM generate_series(1,8) g ON CONFLICT DO NOTHING;
  INSERT INTO restaurant_tables (tenant_id, property_id, location_id, code, name, zone, seats)
  SELECT t_id, p_id, loc_bar, 'B'||g, 'Bar '||g, 'Bar Counter', 2
  FROM generate_series(1,4) g ON CONFLICT DO NOTHING;

  ---------------------------------------------------------------- suppliers
  INSERT INTO restaurant_suppliers (tenant_id, code, name, contact_name, email, phone) VALUES
    (t_id,'SUP-FRESH','Fresh Fields Produce','A. Demo','orders@example.invalid','+000000001'),
    (t_id,'SUP-OCEAN','Ocean Catch Ltd','B. Demo','orders@example.invalid','+000000002'),
    (t_id,'SUP-DRY','Pantry Wholesale','C. Demo','orders@example.invalid','+000000003'),
    (t_id,'SUP-BEV','Beverage Distributors','D. Demo','orders@example.invalid','+000000004')
  ON CONFLICT DO NOTHING;

  ---------------------------------------------------------------- products (POS sellable)
  INSERT INTO restaurant_products (tenant_id, property_id, location_id, sku, name, category_id, menu_item_id, station_id, price, currency, tax_rate, sort_order)
  SELECT t_id, p_id,
         CASE WHEN mi.category_id IN (mc_cock, mc_beer) THEN loc_bar ELSE loc_rest END,
         'SKU-'||upper(left(md5(mi.slug),6)), mi.name, mi.category_id, mi.id,
         CASE WHEN mi.category_id IN (mc_cock, mc_beer) THEN st_bar ELSE st_hot END,
         mi.price, 'TZS', 18, mi.sort_order
  FROM restaurant_menu_items mi WHERE mi.menu_id = v_menu_id
  ON CONFLICT (tenant_id, sku) DO NOTHING;

  ---------------------------------------------------------------- membership for every local user
  FOR usr IN SELECT id FROM auth.users LOOP
    INSERT INTO restaurant_members (tenant_id, property_id, user_id, role)
    VALUES (t_id, NULL, usr, 'owner') ON CONFLICT DO NOTHING;
    -- Canonical RBAC grant (public.user_roles is deprecated and is not an
    -- authorization source; see migration 0004).
    PERFORM public.nova_grant_owner(usr);
  END LOOP;
END
$seed$;
