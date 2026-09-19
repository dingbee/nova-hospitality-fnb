-- ME-13 concurrency evidence: lost-update race in PO-item fulfilment
-- accounting, before and after the fix in migration 0088.
--
-- "before" reproduces receiving.server.ts's OLD pattern (SELECT current
-- value, compute in the client, UPDATE with the computed absolute value)
-- with an artificial delay between the read and the write to force the
-- race window open deterministically instead of relying on timing luck.
-- "after" is the real fix: a single atomic UPDATE ... SET x = x + delta.
set search_path = public;

create or replace function _me13_before_fix(_id uuid, _delta numeric) returns void
language plpgsql as $$
declare _cur numeric;
begin
  select received_quantity into _cur from restaurant_purchase_order_items where id = _id;
  perform pg_sleep(0.2); -- widen the race window between read and write
  update restaurant_purchase_order_items set received_quantity = _cur + _delta where id = _id;
end;
$$;

-- Fixture: one PO item, starting at 0.
delete from restaurant_purchase_order_items where id = '00000000-0000-4000-8000-0000000000f1';
delete from restaurant_purchase_orders where id = '00000000-0000-4000-8000-0000000000f0';
insert into restaurant_purchase_orders (id, tenant_id, status, currency, document_number, reference)
values ('00000000-0000-4000-8000-0000000000f0', '11111111-1111-4111-8111-111111111111', 'approved', 'TZS', 'PO-ME13', 'PO-ME13')
on conflict (id) do nothing;
insert into restaurant_purchase_order_items (id, tenant_id, purchase_order_id, description, quantity, unit_price, received_quantity, accepted_quantity, rejected_quantity)
values ('00000000-0000-4000-8000-0000000000f1', '11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000f0', 'Concurrency test line', 100, 1000, 0, 0, 0);

insert into restaurant_members (tenant_id, property_id, user_id, role)
values ('11111111-1111-4111-8111-111111111111', null, '99999999-9999-4999-8999-999999999999', 'owner')
on conflict do nothing;

-- Simulate an authenticated session for the RPC's own SECURITY DEFINER
-- authorization check (matches the local auth shim's auth.uid() contract).
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999"}', false);
set role authenticated;
