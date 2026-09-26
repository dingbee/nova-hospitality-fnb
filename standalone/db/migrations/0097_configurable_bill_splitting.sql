-- LexiBite configurable bill splitting.
create table if not exists public.restaurant_bill_splits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  split_no integer not null,
  label text not null,
  mode text not null check (mode in ('even','seat','items','amount','percentage')),
  amount numeric(14,2) not null check (amount >= 0),
  allocation jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open','partially_paid','paid','voided')),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_id, split_no)
);

create index if not exists restaurant_bill_splits_order_idx
  on public.restaurant_bill_splits (tenant_id, order_id, status);

alter table public.restaurant_payments
  add column if not exists split_bill_id uuid references public.restaurant_bill_splits(id) on delete set null;

create index if not exists restaurant_payments_split_bill_idx
  on public.restaurant_payments (tenant_id, split_bill_id)
  where split_bill_id is not null;

alter table public.restaurant_bill_splits enable row level security;

drop policy if exists restaurant_bill_splits_read on public.restaurant_bill_splits;
create policy restaurant_bill_splits_read
on public.restaurant_bill_splits for select to authenticated
using (
  restaurant_can_read_scoped(
    tenant_id,
    (select property_id from public.restaurant_orders o where o.id = restaurant_bill_splits.order_id and o.tenant_id = restaurant_bill_splits.tenant_id)
  )
  or restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[],
    (select property_id from public.restaurant_orders o where o.id = restaurant_bill_splits.order_id and o.tenant_id = restaurant_bill_splits.tenant_id)
  )
);

drop policy if exists restaurant_bill_splits_write on public.restaurant_bill_splits;
create policy restaurant_bill_splits_write
on public.restaurant_bill_splits for all to authenticated
using (
  restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[],
    (select property_id from public.restaurant_orders o where o.id = restaurant_bill_splits.order_id and o.tenant_id = restaurant_bill_splits.tenant_id)
  )
)
with check (
  restaurant_can_write_scoped(
    tenant_id,
    ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[],
    (select property_id from public.restaurant_orders o where o.id = restaurant_bill_splits.order_id and o.tenant_id = restaurant_bill_splits.tenant_id)
  )
);

create or replace function public.restaurant_validate_split_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare split_row public.restaurant_bill_splits%rowtype; paid_before numeric(14,2);
begin
  if new.split_bill_id is null or new.amount <= 0 or new.state = 'refunded' then return new; end if;
  select * into split_row from public.restaurant_bill_splits
  where id = new.split_bill_id and tenant_id = new.tenant_id and order_id = new.order_id for update;
  if not found then raise exception 'Split bill does not belong to this order.'; end if;
  if split_row.status = 'voided' then raise exception 'This split bill is no longer payable.'; end if;
  select coalesce(sum(p.amount),0) into paid_before
  from public.restaurant_payments p
  where p.tenant_id = new.tenant_id and p.split_bill_id = new.split_bill_id
    and p.state <> 'refunded'
    and p.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);
  if round(paid_before + new.amount, 2) > round(split_row.amount, 2) + 0.005 then
    raise exception 'Payment exceeds the remaining amount on this split bill.';
  end if;
  return new;
end;
$$;

revoke all on function public.restaurant_validate_split_payment() from public, anon, authenticated;

drop trigger if exists restaurant_payment_split_integrity on public.restaurant_payments;
create trigger restaurant_payment_split_integrity
before insert or update of amount, state, split_bill_id on public.restaurant_payments
for each row execute function public.restaurant_validate_split_payment();

notify pgrst, 'reload schema';