-- O7 — NoVA Import Studio: staging/review layer.
--
-- RAW DATA -> EXTRACT -> UNDERSTAND -> MAP -> MATCH -> NORMALIZE -> VALIDATE
-- -> HUMAN REVIEW -> COMMIT -> VERIFY.
--
-- Nothing here is a canonical entity. A staged record only ever becomes real
-- inventory/menu/supplier/recipe data through the existing write-path
-- service functions (upsertInventoryItem, upsertSupplier, upsertMenuItem,
-- upsertRecipeComponent, insertMovement opening_balance, ...) at commit time
-- — this schema exists so nothing can skip that path, not to replace it.
--
-- Four tables, one per stage of "what did the restaurant give NoVA, and what
-- did NoVA do with it":
--   restaurant_import_workspaces        one migration effort
--   restaurant_import_sources           one uploaded/pasted file, raw and
--                                        unmodified, with detected domains
--   restaurant_import_field_mappings    the explicit, inspectable column ->
--                                        canonical field map for one
--                                        (source, sheet, domain)
--   restaurant_import_staged_records    one candidate entity: raw_data is
--                                        never overwritten; mapped_data,
--                                        match and validation state live
--                                        alongside it until a human decides
--                                        and a commit either succeeds or
--                                        records exactly why it did not.

create table public.restaurant_import_workspaces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id),
  property_id uuid references public.restaurant_properties(id),
  location_id uuid references public.restaurant_locations(id),
  workspace_number text not null,
  name text not null,
  status text not null default 'open'
    check (status in ('open','committing','committed','failed','cancelled')),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, workspace_number)
);

create table public.restaurant_import_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id),
  workspace_id uuid not null references public.restaurant_import_workspaces(id) on delete cascade,
  kind text not null check (kind in ('xlsx','csv','json','pasted','pdf','image')),
  original_filename text,
  storage_path text,
  mime_type text,
  byte_size integer,
  status text not null default 'uploaded'
    check (status in ('uploaded','parsed','extraction_unavailable','failed')),
  parse_error text,
  sheet_names text[],
  -- [{ domain, confidence, sheetName }] — a deterministic header heuristic's
  -- guess, always human-confirmable, never hidden inside a prompt.
  detected_domains jsonb not null default '[]'::jsonb,
  row_count integer,
  -- Small pasted/JSON payloads are stored inline; xlsx/csv/pdf go to storage
  -- (raw_text stays null for those — see storage_path).
  raw_text text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index idx_restaurant_import_sources_workspace
  on public.restaurant_import_sources (tenant_id, workspace_id);

create table public.restaurant_import_field_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id),
  source_id uuid not null references public.restaurant_import_sources(id) on delete cascade,
  sheet_name text,
  domain text not null,
  -- [{ sourceColumn, canonicalField, confidence, auto }]
  mapping jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_id, sheet_name, domain)
);

create table public.restaurant_import_staged_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id),
  workspace_id uuid not null references public.restaurant_import_workspaces(id) on delete cascade,
  source_id uuid not null references public.restaurant_import_sources(id) on delete cascade,
  sheet_name text,
  source_row integer,
  domain text not null check (domain in (
    'supplier','inventory_item','supplier_product','menu_item','recipe_component','opening_stock'
  )),
  -- Verbatim as extracted. Never overwritten by normalization — this answers
  -- "what did the restaurant actually give NoVA?" for as long as the
  -- workspace exists.
  raw_data jsonb not null,
  mapped_data jsonb not null default '{}'::jsonb,
  match_status text not null default 'pending' check (match_status in (
    'pending','new_entity','exact_match','possible_match','ambiguous','unmatched','invalid'
  )),
  matched_entity_id uuid,
  matched_entity_table text,
  match_confidence numeric,
  match_evidence jsonb not null default '[]'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  -- Exception-queue priority, computed at normalize time.
  severity text not null default 'auto_ok' check (severity in (
    'cannot_map','ambiguous_match','missing_field','new_entity','auto_ok'
  )),
  decision text not null default 'pending' check (decision in ('pending','approved','rejected','skipped')),
  decided_by uuid,
  decided_at timestamptz,
  committed_at timestamptz,
  committed_entity_id uuid,
  commit_error text,
  -- Stable across a re-parse/retry of the same source row, so a retried
  -- commit can never double-create the same entity.
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
create index idx_restaurant_import_staged_workspace
  on public.restaurant_import_staged_records (tenant_id, workspace_id);
create index idx_restaurant_import_staged_workspace_domain
  on public.restaurant_import_staged_records (tenant_id, workspace_id, domain);
create index idx_restaurant_import_staged_workspace_decision
  on public.restaurant_import_staged_records (tenant_id, workspace_id, decision);

alter table public.restaurant_import_workspaces enable row level security;
alter table public.restaurant_import_sources enable row level security;
alter table public.restaurant_import_field_mappings enable row level security;
alter table public.restaurant_import_staged_records enable row level security;

-- Import touches every canonical domain at once, so — unlike day-to-day
-- inventory/menu edits — it is restricted to the tenant's senior operating
-- roles rather than every role that can edit one of those domains
-- individually (see import.manage in core/permissions.ts).
create policy "import workspaces read" on public.restaurant_import_workspaces
  for select using (public.restaurant_can_read(tenant_id));
create policy "import workspaces write" on public.restaurant_import_workspaces for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]));

create policy "import sources read" on public.restaurant_import_sources
  for select using (public.restaurant_can_read(tenant_id));
create policy "import sources write" on public.restaurant_import_sources for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]));

create policy "import mappings read" on public.restaurant_import_field_mappings
  for select using (public.restaurant_can_read(tenant_id));
create policy "import mappings write" on public.restaurant_import_field_mappings for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]));

create policy "import staged read" on public.restaurant_import_staged_records
  for select using (public.restaurant_can_read(tenant_id));
create policy "import staged write" on public.restaurant_import_staged_records for all
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager']::restaurant_role[]));

ALTER POLICY "import workspaces read" ON public.restaurant_import_workspaces TO authenticated;
ALTER POLICY "import workspaces write" ON public.restaurant_import_workspaces TO authenticated;
ALTER POLICY "import sources read" ON public.restaurant_import_sources TO authenticated;
ALTER POLICY "import sources write" ON public.restaurant_import_sources TO authenticated;
ALTER POLICY "import mappings read" ON public.restaurant_import_field_mappings TO authenticated;
ALTER POLICY "import mappings write" ON public.restaurant_import_field_mappings TO authenticated;
ALTER POLICY "import staged read" ON public.restaurant_import_staged_records TO authenticated;
ALTER POLICY "import staged write" ON public.restaurant_import_staged_records TO authenticated;

-- Raw source files. Private (business data, not a public menu photo) —
-- unlike restaurant-menu-images this bucket has no public-read policy.
-- restaurant_owns_menu_image_path is bucket-agnostic (it only checks that
-- path segment 1 is a tenant the caller belongs to), so it is reused as-is
-- rather than duplicating the same tenant-path check under a new name.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-import-sources',
  'restaurant-import-sources',
  false,
  10485760, -- 10MB
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/json',
    'application/pdf',
    'text/plain'
  ]
)
on conflict (id) do nothing;

do $$ begin
  create policy "import sources tenant read"
    on storage.objects for select
    to authenticated
    using (bucket_id = 'restaurant-import-sources' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "import sources tenant write"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'restaurant-import-sources' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "import sources tenant delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'restaurant-import-sources' and public.restaurant_owns_menu_image_path(name));
exception when duplicate_object then null; end $$;
