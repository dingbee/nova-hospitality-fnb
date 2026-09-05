-- P1 closure — restaurant_profitability_snapshots was the one P1-named
-- domain whose RLS policies migration 0028 never touched: they still used
-- the tenant-only restaurant_can_read/restaurant_can_write, even though the
-- table already carries property_id/location_id columns (both nullable —
-- legacy rows keep NULL, never fabricated) that profitability.server.ts's
-- app-layer scope checks (assertCapability/assertTenantRead with
-- propertyId/locationId) already rely on. This closes that DB-layer gap
-- using the exact same restaurant_can_read_scoped/restaurant_can_write_scoped
-- functions already used for restaurant_mobile_money_accounts — additive
-- only, same table, same columns, no data migration.
drop policy if exists "profitability readable by tenant" on public.restaurant_profitability_snapshots;
drop policy if exists "profitability managed by tenant" on public.restaurant_profitability_snapshots;

create policy "profitability_read scoped" on public.restaurant_profitability_snapshots
  for select to authenticated
  using (public.restaurant_can_read_scoped(tenant_id, property_id));

create policy "profitability_write scoped" on public.restaurant_profitability_snapshots
  for all to authenticated
  using (public.restaurant_can_write_scoped(
    tenant_id,
    array['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[],
    property_id
  ))
  with check (public.restaurant_can_write_scoped(
    tenant_id,
    array['owner','general_manager','restaurant_manager','chef','kitchen_manager','accountant']::restaurant_role[],
    property_id
  ));
