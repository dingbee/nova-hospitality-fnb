-- ME-13 performance & load certification — two genuine defects found by
-- measurement, not by inspection alone.
--
-- 1. lexibite_demo_sessions / lexibite_demo_registrations regression.
--    0082_p02_lexibite_demo_access.sql postdates ME-01's systemic
--    unindexed-FK and auth-RLS-initplan remediation (0054/0065/0067) and
--    doesn't carry either pattern forward: lexibite_demo_sessions has a FK
--    to lexibite_demo_registrations(id) with no covering index, and both
--    tables' "self read" policies call auth.uid() bare instead of
--    (select auth.uid()), so Postgres re-evaluates it once per row instead
--    of once per query. Confirmed live against production via
--    get_advisors(performance) during this certification pass — the two
--    findings are new and isolated to these two tables; every other table
--    in the schema still reports zero for both lint types. Both tables are
--    read-only self-service bookkeeping (a visitor reading their own
--    registration/session) — no correctness or tenant-isolation exposure,
--    purely the performance-lint regression ME-01 had already closed
--    everywhere else.
--
-- 2. Lost-update race in purchase-order-item fulfilment accounting.
--    receiving.server.ts's postGoodsReceipt does, per receipt line:
--    SELECT received_quantity/accepted_quantity/rejected_quantity, compute
--    new totals in application code, then UPDATE with the computed
--    absolute values. Two concurrent postings crediting the SAME
--    restaurant_purchase_order_items row (two different partial
--    deliveries against the same PO line, posted at close to the same
--    time by two different staff members or two retried requests) each
--    read the pre-update row, compute independently, and the second
--    UPDATE silently overwrites the first's contribution — the stock
--    ledger itself stays correct (insertMovement has its own dedupe_key
--    unique index), but the PO line's cumulative received/accepted/
--    rejected counters lose one delivery's worth of quantity. This
--    function makes the accumulator update atomic in the database instead
--    of read-then-write in application code, which both closes the race
--    and removes one round trip per receipt line.

-- ---------------------------------------------------------------------
-- 1. lexibite demo-access performance regression
-- ---------------------------------------------------------------------

create index if not exists idx_lexibite_demo_sessions_registration_id
  on public.lexibite_demo_sessions(registration_id);

drop policy if exists "lexibite_demo_registrations self read" on public.lexibite_demo_registrations;
create policy "lexibite_demo_registrations self read"
  on public.lexibite_demo_registrations for select
  to authenticated
  using ((select auth.uid()) = auth_user_id);

drop policy if exists "lexibite_demo_sessions self read" on public.lexibite_demo_sessions;
create policy "lexibite_demo_sessions self read"
  on public.lexibite_demo_sessions for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------
-- 2. Atomic purchase-order-item fulfilment increment
-- ---------------------------------------------------------------------
-- SECURITY DEFINER so the atomic UPDATE can run as a single statement;
-- the authorization check inside mirrors "po items write scoped (update)"
-- (0073_me01_multi_policy_consolidation_part3.sql) exactly — same roles,
-- same property scope derivation — so this closes no privilege the RLS
-- policy wasn't already going to grant the caller.
create or replace function public.restaurant_increment_po_item_fulfilment(
  _tenant uuid,
  _po_item_id uuid,
  _received_delta numeric,
  _accepted_delta numeric,
  _rejected_delta numeric
)
returns table (
  out_id uuid,
  out_received_quantity numeric,
  out_accepted_quantity numeric,
  out_rejected_quantity numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  _po_id uuid;
begin
  select t.purchase_order_id into _po_id
  from public.restaurant_purchase_order_items t
  where t.tenant_id = _tenant and t.id = _po_item_id;

  if _po_id is null then
    raise exception 'Purchase order item not found for this tenant.';
  end if;

  if not public.restaurant_can_write_scoped(
    _tenant,
    array['owner','general_manager','restaurant_manager','purchasing_officer','inventory_manager','accountant']::restaurant_role[],
    public.restaurant_purchase_order_property(_po_id)
  ) then
    raise exception 'Forbidden — insufficient role to post receiving against this purchase order.';
  end if;

  return query
  update public.restaurant_purchase_order_items t
  set received_quantity = coalesce(t.received_quantity, 0) + _received_delta,
      accepted_quantity = coalesce(t.accepted_quantity, 0) + _accepted_delta,
      rejected_quantity = coalesce(t.rejected_quantity, 0) + _rejected_delta
  where t.tenant_id = _tenant and t.id = _po_item_id
  returning t.id, t.received_quantity, t.accepted_quantity, t.rejected_quantity;
end;
$$;

revoke all on function public.restaurant_increment_po_item_fulfilment(uuid, uuid, numeric, numeric, numeric) from public;
grant execute on function public.restaurant_increment_po_item_fulfilment(uuid, uuid, numeric, numeric, numeric) to authenticated;
grant execute on function public.restaurant_increment_po_item_fulfilment(uuid, uuid, numeric, numeric, numeric) to service_role;
