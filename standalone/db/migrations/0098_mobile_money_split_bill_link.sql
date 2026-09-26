alter table public.restaurant_mobile_money_collections
  add column if not exists split_bill_id uuid references public.restaurant_bill_splits(id) on delete set null;

create index if not exists restaurant_mm_collections_split_bill_idx
  on public.restaurant_mobile_money_collections (tenant_id, split_bill_id)
  where split_bill_id is not null;

notify pgrst, 'reload schema';