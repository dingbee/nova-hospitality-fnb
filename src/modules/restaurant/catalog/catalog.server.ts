/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * F&B Master Catalog — identity layer.
 *
 * The catalog is the stable SKU spine that inventory, recipes, menu, orders,
 * costing, procurement and intelligence all reference. Importing a catalog
 * establishes *identity and configuration only*: never balances, never prices,
 * never recipes, never menu items.
 *
 * Import safety contract:
 *   • matched on (tenant_id, sku) — the supplied SKU is immutable
 *   • unknown SKU        → created
 *   • known + identical  → no-op
 *   • known + different  → conflict recorded, production data untouched
 */
import catalogSource from "./data/legacy-master-catalog.json";
import { COUNT_UNIT_NAMES, normaliseRow, type CatalogSourceRow, type NormalisedCatalogRow } from "./parse";
import { assertCapability, assertTenantRead } from "../core/access.server";

type Sb = any;

const COMPARED_FIELDS = [
  "name",
  "domain",
  "subcategory",
  "category_id",
  "unit_id",
  "purchase_unit_id",
  "pack_size",
  "pack_label",
] as const;

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function ensureUnits(sb: Sb, tenantId: string, codes: Set<string>) {
  const { data, error } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, tenant_id")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
  if (error) throw new Error(error.message);
  const byCode = new Map<string, string>();
  for (const u of (data ?? []) as any[]) {
    // Tenant-owned units win over the global defaults.
    if (!byCode.has(u.code) || u.tenant_id === tenantId) byCode.set(u.code, u.id);
  }
  const missing = [...codes].filter((c) => c && !byCode.has(c));
  if (missing.length) {
    const { data: created, error: insErr } = await sb
      .from("restaurant_inventory_units")
      .insert(
        missing.map((code) => ({
          tenant_id: tenantId,
          code,
          name: COUNT_UNIT_NAMES[code] ?? code.toUpperCase(),
          dimension: "count",
          factor: 1,
        })),
      )
      .select("id, code");
    if (insErr) throw new Error(insErr.message);
    for (const u of (created ?? []) as any[]) byCode.set(u.code, u.id);
  }
  return byCode;
}

async function ensureCategories(sb: Sb, tenantId: string, names: Set<string>) {
  const { data, error } = await sb
    .from("restaurant_inventory_categories")
    .select("id, name, slug")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  const byName = new Map<string, string>();
  for (const c of (data ?? []) as any[]) byName.set(c.name.toLowerCase(), c.id);
  const missing = [...names].filter((n) => n && !byName.has(n.toLowerCase()));
  if (missing.length) {
    const { data: created, error: insErr } = await sb
      .from("restaurant_inventory_categories")
      .insert(missing.map((name) => ({ tenant_id: tenantId, name, slug: slugify(name), kind: "ingredient" })))
      .select("id, name");
    if (insErr) throw new Error(insErr.message);
    for (const c of (created ?? []) as any[]) byName.set(c.name.toLowerCase(), c.id);
  }
  return byName;
}

function num(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function differs(field: string, existing: any, incoming: any) {
  if (field === "pack_size") {
    const a = num(existing);
    const b = num(incoming);
    if (a === null || b === null) return a !== b;
    return Math.abs(a - b) > 1e-6;
  }
  return (existing ?? null) !== (incoming ?? null);
}

export interface CatalogImportSummary {
  batchId: string;
  sourceFile: string;
  totalRows: number;
  created: number;
  unchanged: number;
  updated: number;
  conflicts: number;
  unconfirmed: number;
  skipped: number;
  errors: number;
}

export function getCatalogSourceRows(): CatalogSourceRow[] {
  return (catalogSource as { rows: CatalogSourceRow[] }).rows;
}

export async function importMasterCatalog(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId?: string | null; dryRun?: boolean },
): Promise<CatalogImportSummary> {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");

  const source = catalogSource as { sourceFile: string; sourceLabel: string; rows: CatalogSourceRow[] };
  const rows: NormalisedCatalogRow[] = source.rows.map(normaliseRow);

  const unitCodes = new Set<string>();
  const categoryNames = new Set<string>();
  for (const r of rows) {
    if (r.baseUnitCode) unitCodes.add(r.baseUnitCode);
    if (r.purchaseUnitCode) unitCodes.add(r.purchaseUnitCode);
    if (r.category) categoryNames.add(r.category);
  }

  const units = await ensureUnits(sb, input.tenantId, unitCodes);
  const categories = await ensureCategories(sb, input.tenantId, categoryNames);

  const { data: existingRows, error: exErr } = await sb
    .from("restaurant_inventory_items")
    .select(
      "id, sku, name, domain, subcategory, category_id, unit_id, purchase_unit_id, pack_size, pack_label, data_status",
    )
    .eq("tenant_id", input.tenantId)
    .in("sku", rows.map((r) => r.sku));
  if (exErr) throw new Error(exErr.message);
  const existingBySku = new Map<string, any>(((existingRows ?? []) as any[]).map((r) => [r.sku, r]));

  const { data: batch, error: batchErr } = await sb
    .from("restaurant_catalog_import_batches")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      source_file: source.sourceFile,
      source_label: source.sourceLabel,
      status: input.dryRun ? "dry_run" : "running",
      total_rows: rows.length,
      imported_by: userId,
    })
    .select("id")
    .single();
  if (batchErr) throw new Error(batchErr.message);
  const batchId = batch.id as string;

  const counts = { created: 0, unchanged: 0, updated: 0, conflicts: 0, unconfirmed: 0, skipped: 0, errors: 0 };
  const auditRows: any[] = [];

  for (const r of rows) {
    if (r.dataStatus === "UNCONFIRMED") counts.unconfirmed += 1;
    const desired = {
      name: r.name,
      domain: r.domain,
      subcategory: r.subcategory,
      category_id: r.category ? categories.get(r.category.toLowerCase()) ?? null : null,
      unit_id: r.baseUnitCode ? units.get(r.baseUnitCode) ?? null : null,
      purchase_unit_id: r.purchaseUnitCode ? units.get(r.purchaseUnitCode) ?? null : null,
      pack_size: r.packSize,
      pack_label: r.packLabel,
    };
    const sourceValues = {
      sku: r.sku,
      name: r.name,
      domain: r.domain,
      category: r.category,
      subcategory: r.subcategory,
      purchase_unit: r.purchaseUnitLabel,
      pack_size: r.packLabel,
      base_unit: r.baseUnitLabel,
      data_status: r.dataStatus,
      issues: r.issues,
    };
    const audit = {
      tenant_id: input.tenantId,
      batch_id: batchId,
      source_row: r.sourceRow,
      sku: r.sku,
      name: r.name,
      source_values: sourceValues,
      item_id: null as string | null,
      result: "skipped",
      message: null as string | null,
      conflicts: [] as any[],
      review_status: r.issues.length ? "REVIEW_REQUIRED" : "none",
    };

    const existing = existingBySku.get(r.sku);
    try {
      if (!existing) {
        if (input.dryRun) {
          audit.result = "created";
          counts.created += 1;
        } else {
          const { data: inserted, error } = await sb
            .from("restaurant_inventory_items")
            .insert({
              tenant_id: input.tenantId,
              property_id: input.propertyId ?? null,
              sku: r.sku,
              item_type: "ingredient",
              status: "active",
              data_status: r.dataStatus,
              source: r.source,
              source_row: r.sourceRow,
              import_batch_id: batchId,
              ...desired,
              pack_size: desired.pack_size ?? 1,
            })
            .select("id")
            .single();
          if (error) throw new Error(error.message);
          audit.item_id = inserted.id;
          audit.result = "created";
          counts.created += 1;
        }
      } else {
        const conflicts = COMPARED_FIELDS.filter((f) => {
          const incoming = (desired as any)[f];
          // The workbook asserts nothing when a value is absent — silence is not
          // a conflict, it is a data-quality issue already surfaced separately.
          if (incoming === null || incoming === undefined) return false;
          return differs(f, existing[f], incoming);
        }).map((f) => ({
          field: f,
          existing: existing[f] ?? null,
          incoming: (desired as any)[f] ?? null,
          recommended_action: "Review and confirm which value is authoritative before applying.",
        }));
        audit.item_id = existing.id;
        if (conflicts.length === 0) {
          audit.result = "unchanged";
          counts.unchanged += 1;
        } else {
          audit.result = "conflict";
          audit.conflicts = conflicts;
          audit.review_status = "REVIEW_REQUIRED";
          audit.message = `${conflicts.length} field(s) differ from the existing catalog record. Not overwritten.`;
          counts.conflicts += 1;
        }
      }
    } catch (err) {
      audit.result = "error";
      audit.message = err instanceof Error ? err.message : String(err);
      audit.review_status = "REVIEW_REQUIRED";
      counts.errors += 1;
    }
    auditRows.push(audit);
  }

  const { error: rowsErr } = await sb.from("restaurant_catalog_import_rows").insert(auditRows);
  if (rowsErr) throw new Error(rowsErr.message);

  const { error: updErr } = await sb
    .from("restaurant_catalog_import_batches")
    .update({
      status: input.dryRun ? "dry_run" : "completed",
      created_count: counts.created,
      unchanged_count: counts.unchanged,
      updated_count: counts.updated,
      conflict_count: counts.conflicts,
      unconfirmed_count: counts.unconfirmed,
      skipped_count: counts.skipped,
      error_count: counts.errors,
    })
    .eq("id", batchId)
    .eq("tenant_id", input.tenantId);
  if (updErr) throw new Error(updErr.message);

  return {
    batchId,
    sourceFile: source.sourceFile,
    totalRows: rows.length,
    ...counts,
  };
}

/* ---------------- Reads ---------------- */

export interface ListCatalogInput {
  tenantId: string;
  search?: string;
  domain?: string;
  categoryId?: string;
  subcategory?: string;
  dataStatus?: "CONFIRMED" | "UNCONFIRMED";
  status?: "active" | "inactive";
  limit?: number;
}

export async function listMasterCatalog(sb: Sb, userId: string, input: ListCatalogInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_inventory_items")
    .select(
      "id, sku, name, domain, subcategory, category_id, unit_id, purchase_unit_id, pack_size, pack_label, data_status, status, source, source_row, import_batch_id, item_type, created_at, updated_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("sku")
    .limit(input.limit ?? 500);
  if (input.domain) q = q.eq("domain", input.domain);
  if (input.categoryId) q = q.eq("category_id", input.categoryId);
  if (input.subcategory) q = q.eq("subcategory", input.subcategory);
  if (input.dataStatus) q = q.eq("data_status", input.dataStatus);
  if (input.status) q = q.eq("status", input.status);
  if (input.search) q = q.or(`name.ilike.%${input.search}%,sku.ilike.%${input.search}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const [{ data: cats }, { data: units }] = await Promise.all([
    sb.from("restaurant_inventory_categories").select("id, name").eq("tenant_id", input.tenantId),
    sb
      .from("restaurant_inventory_units")
      .select("id, code, name, dimension, factor")
      .or(`tenant_id.is.null,tenant_id.eq.${input.tenantId}`),
  ]);
  return { items: data ?? [], categories: cats ?? [], units: units ?? [] };
}

export async function listCatalogImportBatches(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_catalog_import_batches")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("imported_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listCatalogReviewQueue(
  sb: Sb,
  userId: string,
  input: { tenantId: string; batchId?: string; includeResolved?: boolean },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_catalog_import_rows")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("source_row")
    .limit(500);
  if (input.batchId) q = q.eq("batch_id", input.batchId);
  if (!input.includeResolved) q = q.eq("review_status", "REVIEW_REQUIRED");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function resolveCatalogReviewRow(
  sb: Sb,
  userId: string,
  input: { tenantId: string; rowId: string; note?: string },
) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const { data, error } = await sb
    .from("restaurant_catalog_import_rows")
    .update({
      review_status: "resolved",
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      ...(input.note ? { message: input.note } : {}),
    })
    .eq("id", input.rowId)
    .eq("tenant_id", input.tenantId)
    .select("id, review_status")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
