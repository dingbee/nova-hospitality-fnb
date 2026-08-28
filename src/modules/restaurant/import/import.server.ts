/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * O7 Import Studio — orchestration.
 *
 * Ties the pure pieces (parsers.ts, domains.ts, normalize.ts, stage.ts)
 * together with the database: uploads a raw source, stages candidate
 * records against it, and — only once a human has decided each one — commits
 * approved records through the *same* write-path service functions manual
 * entry uses (upsertSupplier, upsertInventoryItem, upsertSupplierProduct,
 * upsertMenu/upsertMenuItem, upsertRecipeComponent, insertMovement). Nothing
 * here ever writes a canonical table directly.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { convertUnits, type UnitRow } from "../inventory/units";
import { insertMovement } from "../inventory/movements.server";
import { upsertInventoryItem } from "../inventory/inventory.server";
import { upsertSupplier, upsertSupplierProduct } from "../suppliers/suppliers.server";
import { upsertMenu, upsertMenuItem } from "../menu/menu.server";
import { upsertRecipeComponent } from "../costing/costing.server";
import {
  attachModifierGroup,
  upsertModifier,
  upsertModifierGroup,
  upsertProduct,
  upsertVariant,
} from "../products/products.server";
import { parseCsv, parseJson, parsePasted, parseXlsxBase64, type ParsedSource } from "./parsers";
import {
  CANONICAL_FIELDS,
  IMPORT_DOMAIN_COMMIT_ORDER,
  detectDomains,
  suggestFieldMapping,
  type ImportDomain,
} from "./domains";
import { applyMapping } from "./normalize";
import {
  stageInventoryItemRow,
  stageMenuItemRow,
  stageModifierGroupRow,
  stageModifierRow,
  stageOpeningStockRow,
  stageProductModifierGroupRow,
  stageProductStationRow,
  stageRecipeComponentRow,
  stageSupplierProductRow,
  stageSupplierRow,
  stageVariantRow,
  type StageResult,
} from "./stage";
import type {
  CommitImportWorkspaceInput,
  ConfirmImportMappingInput,
  CreateImportWorkspaceInput,
  DecideStagedRecordInput,
  UploadImportSourceInput,
} from "./contracts";

type Sb = any;

const BUCKET = "restaurant-import-sources";

async function nextWorkspaceNumber(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "import_workspace",
    _prefix: "IMP",
  });
  if (error || !data) return `IMP-${Date.now()}`;
  return data as string;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "item"
  );
}

/* ================= Workspace ================= */

export async function createImportWorkspace(
  sb: Sb,
  userId: string,
  input: CreateImportWorkspaceInput,
) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const workspaceNumber = await nextWorkspaceNumber(sb, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_import_workspaces")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      workspace_number: workspaceNumber,
      name: input.name,
      notes: input.notes ?? null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.import.workspace.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_import_workspace",
    entityId: data.id,
    source: "restaurant-os",
    payload: { name: input.name, workspace_number: workspaceNumber },
  });
  return data;
}

export async function listImportWorkspaces(
  sb: Sb,
  userId: string,
  input: { tenantId: string; limit: number },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_import_workspaces")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getImportWorkspace(
  sb: Sb,
  userId: string,
  input: { tenantId: string; workspaceId: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const [
    { data: workspace, error: wErr },
    { data: sources, error: sErr },
    { data: staged, error: stErr },
  ] = await Promise.all([
    sb
      .from("restaurant_import_workspaces")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.workspaceId)
      .maybeSingle(),
    sb
      .from("restaurant_import_sources")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("workspace_id", input.workspaceId)
      .order("created_at"),
    sb
      .from("restaurant_import_staged_records")
      .select("id, domain, severity, decision, committed_at, commit_error")
      .eq("tenant_id", input.tenantId)
      .eq("workspace_id", input.workspaceId),
  ]);
  if (wErr) throw new Error(wErr.message);
  if (!workspace) throw new Error("Import workspace not found.");
  if (sErr) throw new Error(sErr.message);
  if (stErr) throw new Error(stErr.message);

  const rows = (staged ?? []) as any[];
  const byDomain: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  let committed = 0;
  let failed = 0;
  for (const r of rows) {
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    if (r.committed_at) committed += 1;
    if (r.commit_error) failed += 1;
  }
  return {
    workspace,
    sources: sources ?? [],
    summary: { total: rows.length, byDomain, bySeverity, byDecision, committed, failed },
  };
}

/* ================= Source upload & parse ================= */

function extensionFor(kind: string, mimeType?: string): string {
  if (kind === "xlsx") return "xlsx";
  if (kind === "csv") return "csv";
  if (kind === "pdf") return "pdf";
  if (kind === "image") return mimeType?.includes("png") ? "png" : "jpg";
  return "txt";
}

async function loadSourceRow(sb: Sb, tenantId: string, sourceId: string) {
  const { data, error } = await sb
    .from("restaurant_import_sources")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Import source not found.");
  return data as any;
}

/** Marker thrown when a source has no configured extraction path (PDF/image) — never a fabricated result. */
class ExtractionUnavailableError extends Error {}

async function parseSourceContent(sb: Sb, source: any): Promise<ParsedSource> {
  if (source.kind === "pdf" || source.kind === "image") {
    throw new ExtractionUnavailableError(
      "No document/OCR extraction is configured for this project. Export this document as CSV, XLSX or JSON and upload that instead, or configure a document-AI provider (see docs/o6-ocr-staging-architecture.md) to enable this later.",
    );
  }
  let text: string;
  if (source.storage_path) {
    const { data, error } = await sb.storage.from(BUCKET).download(source.storage_path);
    if (error) throw new Error(error.message);
    const buffer = Buffer.from(await data.arrayBuffer());
    if (source.kind === "xlsx") return parseXlsxBase64(buffer.toString("base64"));
    text = buffer.toString("utf8");
  } else {
    text = source.raw_text ?? "";
  }
  if (source.kind === "csv") return parseCsv(text);
  if (source.kind === "json") return parseJson(text);
  return parsePasted(text);
}

export async function uploadImportSource(sb: Sb, userId: string, input: UploadImportSourceInput) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const { data: ws } = await sb
    .from("restaurant_import_workspaces")
    .select("id, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (!ws) throw new Error("Import workspace not found.");
  // "committed" isn't terminal — a migration often lands in phases (inventory
  // today, recipes next once it exists to reference); only a cancelled
  // workspace refuses more sources.
  if (ws.status === "cancelled")
    throw new Error("This workspace was cancelled and cannot accept new sources.");

  const needsFile = input.kind === "xlsx" || input.kind === "pdf" || input.kind === "image";
  if (needsFile && !input.fileBase64)
    throw new Error(`A file is required for a "${input.kind}" source.`);
  if (!needsFile && !input.text && !input.fileBase64)
    throw new Error("Paste some data or attach a file.");

  const sourceId = crypto.randomUUID();
  let storagePath: string | null = null;
  let rawText: string | null = null;
  let byteSize = 0;

  if (needsFile || input.fileBase64) {
    const buffer = Buffer.from(input.fileBase64!, "base64");
    if (buffer.length === 0) throw new Error("The selected file is empty.");
    byteSize = buffer.length;
    storagePath = `${input.tenantId}/${input.workspaceId}/${sourceId}.${extensionFor(input.kind, input.mimeType)}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: input.mimeType ?? "application/octet-stream",
      upsert: false,
    });
    if (upErr) throw new Error(upErr.message);
  } else {
    rawText = input.text ?? "";
    byteSize = Buffer.byteLength(rawText, "utf8");
  }

  const { data, error } = await sb
    .from("restaurant_import_sources")
    .insert({
      id: sourceId,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      kind: input.kind,
      original_filename: input.originalFilename ?? null,
      storage_path: storagePath,
      mime_type: input.mimeType ?? null,
      byte_size: byteSize,
      raw_text: rawText,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) {
    if (storagePath) await sb.storage.from(BUCKET).remove([storagePath]);
    throw new Error(error.message);
  }
  return data;
}

export async function parseImportSource(
  sb: Sb,
  userId: string,
  input: { tenantId: string; sourceId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const source = await loadSourceRow(sb, input.tenantId, input.sourceId);

  try {
    const parsed = await parseSourceContent(sb, source);
    const sheetSummaries = parsed.sheets.map((s) => ({
      sheetName: s.sheetName,
      headers: s.headers,
      rowCount: s.rows.length,
      detectedDomains: detectDomains(s.headers),
    }));
    const { data, error } = await sb
      .from("restaurant_import_sources")
      .update({
        status: "parsed",
        sheet_names: parsed.sheets.map((s) => s.sheetName),
        detected_domains: sheetSummaries.map((s) => ({
          sheetName: s.sheetName,
          guesses: s.detectedDomains,
        })),
        row_count: parsed.sheets.reduce((n, s) => n + s.rows.length, 0),
        parse_error: null,
      })
      .eq("id", source.id)
      .eq("tenant_id", input.tenantId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { source: data, sheets: sheetSummaries };
  } catch (err) {
    const unavailable = err instanceof ExtractionUnavailableError;
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("restaurant_import_sources")
      .update({ status: unavailable ? "extraction_unavailable" : "failed", parse_error: message })
      .eq("id", source.id)
      .eq("tenant_id", input.tenantId);
    throw new Error(message);
  }
}

export async function suggestImportMapping(
  sb: Sb,
  userId: string,
  input: { tenantId: string; sourceId: string; sheetName: string; domain: ImportDomain },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const source = await loadSourceRow(sb, input.tenantId, input.sourceId);
  const parsed = await parseSourceContent(sb, source);
  const sheet = parsed.sheets.find((s) => s.sheetName === input.sheetName);
  if (!sheet) throw new Error(`Sheet "${input.sheetName}" not found in this source.`);
  return {
    headers: sheet.headers,
    mapping: suggestFieldMapping(sheet.headers, input.domain),
    canonicalFields: CANONICAL_FIELDS[input.domain],
  };
}

/* ================= Reference data & staging ================= */

async function fetchRefData(sb: Sb, tenantId: string) {
  const [
    { data: suppliers },
    { data: inventoryItems },
    { data: units },
    { data: inventoryCategories },
    { data: menuCategories },
    { data: menuItems },
    { data: supplierProducts },
    { data: locations },
    { data: stations },
    { data: products },
    { data: variants },
    { data: modifierGroups },
    { data: modifiers },
    { data: productModifierGroups },
  ] = await Promise.all([
    sb.from("restaurant_suppliers").select("id, code, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_inventory_items")
      .select("id, sku, name, barcode, brand")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_inventory_units")
      .select("id, code, name, dimension, factor, base_unit_id")
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`),
    sb.from("restaurant_inventory_categories").select("id, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_categories")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("kind", "menu"),
    sb.from("restaurant_menu_items").select("id, name, menu_id").eq("tenant_id", tenantId),
    sb
      .from("restaurant_supplier_products")
      .select("id, supplier_id, supplier_sku, barcode")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_locations").select("id, name").eq("tenant_id", tenantId),
    sb.from("restaurant_stations").select("id, code, name").eq("tenant_id", tenantId),
    sb.from("restaurant_products").select("id, menu_item_id, station_id").eq("tenant_id", tenantId),
    sb.from("restaurant_product_variants").select("id, product_id, name").eq("tenant_id", tenantId),
    sb.from("restaurant_modifier_groups").select("id, code, name").eq("tenant_id", tenantId),
    sb.from("restaurant_modifiers").select("id, group_id, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_product_modifier_groups")
      .select("product_id, group_id")
      .eq("tenant_id", tenantId),
  ]);
  return {
    suppliers: suppliers ?? [],
    inventoryItems: inventoryItems ?? [],
    units: (units ?? []) as UnitRow[],
    inventoryCategories: inventoryCategories ?? [],
    menuCategories: menuCategories ?? [],
    menuItems: menuItems ?? [],
    supplierProducts: supplierProducts ?? [],
    locations: locations ?? [],
    stations: stations ?? [],
    products: products ?? [],
    variants: variants ?? [],
    modifierGroups: modifierGroups ?? [],
    modifiers: modifiers ?? [],
    productModifierGroups: productModifierGroups ?? [],
  };
}

function stageRow(
  domain: ImportDomain,
  mappedRaw: Record<string, string>,
  ref: Awaited<ReturnType<typeof fetchRefData>>,
): StageResult {
  switch (domain) {
    case "supplier":
      return stageSupplierRow(mappedRaw, { suppliers: ref.suppliers });
    case "inventory_item":
      return stageInventoryItemRow(mappedRaw, {
        inventoryItems: ref.inventoryItems,
        units: ref.units,
        categories: ref.inventoryCategories,
      });
    case "supplier_product":
      return stageSupplierProductRow(mappedRaw, {
        suppliers: ref.suppliers,
        inventoryItems: ref.inventoryItems,
        existingSupplierProducts: ref.supplierProducts,
      });
    case "menu_item":
      return stageMenuItemRow(mappedRaw, {
        menuItems: ref.menuItems,
        categories: ref.menuCategories,
      });
    case "product_station":
      return stageProductStationRow(mappedRaw, {
        menuItems: ref.menuItems,
        stations: ref.stations,
        existingProducts: ref.products,
      });
    case "variant":
      return stageVariantRow(mappedRaw, {
        menuItems: ref.menuItems,
        products: ref.products,
        existingVariants: ref.variants,
      });
    case "modifier_group":
      return stageModifierGroupRow(mappedRaw, { modifierGroups: ref.modifierGroups });
    case "modifier":
      return stageModifierRow(mappedRaw, {
        modifierGroups: ref.modifierGroups,
        inventoryItems: ref.inventoryItems,
        units: ref.units,
        existingModifiers: ref.modifiers,
      });
    case "product_modifier_group":
      return stageProductModifierGroupRow(mappedRaw, {
        menuItems: ref.menuItems,
        products: ref.products,
        modifierGroups: ref.modifierGroups,
        existingLinks: ref.productModifierGroups,
      });
    case "recipe_component":
      return stageRecipeComponentRow(mappedRaw, {
        menuItems: ref.menuItems,
        inventoryItems: ref.inventoryItems,
        units: ref.units,
      });
    case "opening_stock":
      return stageOpeningStockRow(mappedRaw, {
        inventoryItems: ref.inventoryItems,
        units: ref.units,
        locations: ref.locations,
      });
  }
}

export async function confirmImportMapping(
  sb: Sb,
  userId: string,
  input: ConfirmImportMappingInput,
) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const source = await loadSourceRow(sb, input.tenantId, input.sourceId);

  const { error: mapErr } = await sb.from("restaurant_import_field_mappings").upsert(
    {
      tenant_id: input.tenantId,
      source_id: input.sourceId,
      sheet_name: input.sheetName,
      domain: input.domain,
      mapping: input.mapping,
      created_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,source_id,sheet_name,domain" },
  );
  if (mapErr) throw new Error(mapErr.message);

  const parsed = await parseSourceContent(sb, source);
  const sheet = parsed.sheets.find((s) => s.sheetName === input.sheetName);
  if (!sheet) throw new Error(`Sheet "${input.sheetName}" not found in this source.`);

  const ref = await fetchRefData(sb, input.tenantId);

  const { data: existingStaged, error: exErr } = await sb
    .from("restaurant_import_staged_records")
    .select("id, dedupe_key, committed_at")
    .eq("tenant_id", input.tenantId)
    .eq("source_id", input.sourceId)
    .eq("sheet_name", input.sheetName)
    .eq("domain", input.domain);
  if (exErr) throw new Error(exErr.message);
  const existingByKey = new Map<string, any>(
    ((existingStaged ?? []) as any[]).map((r) => [r.dedupe_key, r]),
  );

  const toInsert: any[] = [];
  const toUpdate: { id: string; row: any }[] = [];
  let skippedCommitted = 0;

  sheet.rows.forEach((rawRow, idx) => {
    const dedupeKey = `${input.sourceId}:${input.sheetName}:${input.domain}:${idx}`;
    const existing = existingByKey.get(dedupeKey);
    if (existing?.committed_at) {
      skippedCommitted += 1;
      return;
    }

    const mappedRaw = applyMapping(input.mapping, rawRow);
    const result = stageRow(input.domain, mappedRaw, ref);
    const autoApprove = result.severity === "auto_ok";

    const row = {
      tenant_id: input.tenantId,
      workspace_id: source.workspace_id,
      source_id: input.sourceId,
      sheet_name: input.sheetName,
      source_row: idx + 2, // header occupies row 1
      domain: input.domain,
      raw_data: rawRow,
      mapped_data: result.mappedData,
      match_status: result.matchStatus,
      matched_entity_id: result.matchedEntityId,
      matched_entity_table: result.matchedEntityTable,
      match_confidence: result.matchConfidence,
      match_evidence: result.matchEvidence,
      validation_errors: result.validationErrors,
      severity: result.severity,
      decision: autoApprove ? "approved" : "pending",
      decided_by: autoApprove ? userId : null,
      decided_at: autoApprove ? new Date().toISOString() : null,
      commit_error: null,
      dedupe_key: dedupeKey,
      updated_at: new Date().toISOString(),
    };
    if (existing) toUpdate.push({ id: existing.id, row });
    else toInsert.push(row);
  });

  if (toInsert.length) {
    const { error } = await sb.from("restaurant_import_staged_records").insert(toInsert);
    if (error) throw new Error(error.message);
  }
  for (const u of toUpdate) {
    const { error } = await sb
      .from("restaurant_import_staged_records")
      .update(u.row)
      .eq("id", u.id)
      .eq("tenant_id", input.tenantId);
    if (error) throw new Error(error.message);
  }

  return {
    staged: toInsert.length + toUpdate.length,
    skippedAlreadyCommitted: skippedCommitted,
    total: sheet.rows.length,
  };
}

/* ================= Review ================= */

export async function listStagedRecords(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    workspaceId: string;
    domain?: ImportDomain;
    severity?: string;
    decision?: string;
    limit: number;
  },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_import_staged_records")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("workspace_id", input.workspaceId)
    .order("domain")
    .order("source_row")
    .limit(input.limit);
  if (input.domain) q = q.eq("domain", input.domain);
  if (input.severity) q = q.eq("severity", input.severity);
  if (input.decision) q = q.eq("decision", input.decision);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function decideStagedRecord(sb: Sb, userId: string, input: DecideStagedRecordInput) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const { data: existing, error: readErr } = await sb
    .from("restaurant_import_staged_records")
    .select("id, committed_at, mapped_data, matched_entity_table")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.recordId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!existing) throw new Error("Staged record not found.");
  if (existing.committed_at)
    throw new Error("This record has already been committed and can no longer be changed.");

  const patch: any = {
    decision: input.decision,
    decided_by: userId,
    decided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (input.matchedEntityId !== undefined) {
    patch.matched_entity_id = input.matchedEntityId;
    patch.match_status = input.matchedEntityId ? "exact_match" : "new_entity";
  }
  if (input.mappedDataPatch) {
    patch.mapped_data = { ...(existing.mapped_data as object), ...input.mappedDataPatch };
  }
  const { data, error } = await sb
    .from("restaurant_import_staged_records")
    .update(patch)
    .eq("id", input.recordId)
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function bulkDecideStagedRecords(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    workspaceId: string;
    domain?: ImportDomain;
    severity?: string;
    decision: "approved" | "rejected" | "skipped";
  },
) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  let q = sb
    .from("restaurant_import_staged_records")
    .update({
      decision: input.decision,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("workspace_id", input.workspaceId)
    .is("committed_at", null);
  if (input.domain) q = q.eq("domain", input.domain);
  if (input.severity) q = q.eq("severity", input.severity);
  const { data, error } = await q.select("id");
  if (error) throw new Error(error.message);
  return { updated: ((data ?? []) as any[]).length };
}

/* ================= Commit ================= */

interface CommitOutcome {
  recordId: string;
  domain: ImportDomain;
  committedEntityId: string | null;
  error: string | null;
}

async function commitSupplierRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  const result = await upsertSupplier(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    name: m.name,
    code: m.code ?? undefined,
    contactName: m.contactName ?? undefined,
    email: m.email ?? undefined,
    phone: m.phone ?? undefined,
    address: m.address ?? undefined,
    paymentTerms: m.paymentTerms ?? undefined,
    leadTimeDays: m.leadTimeDays ?? undefined,
    status: "active",
    deliveryDays: [],
    preferred: false,
    suppliedCategoryIds: [],
  });
  return result.id as string;
}

async function commitInventoryItemRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  const result = await upsertInventoryItem(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    categoryId: m.categoryId ?? undefined,
    unitId: m.unitId ?? undefined,
    sku: m.sku ?? undefined,
    barcode: m.barcode ?? undefined,
    brand: m.brand ?? undefined,
    name: m.name,
    itemType: "ingredient",
    currentQuantity: Number(m.openingQuantity ?? 0),
    parLevel: m.parLevel ?? undefined,
    reorderPoint: m.reorderPoint ?? undefined,
    averageCost: Number(m.averageCost ?? 0),
    currency: "TZS",
    trackBatches: false,
    allowNegative: false,
  });
  return result.id as string;
}

async function commitSupplierProductRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  if (!m.supplierId || !m.inventoryItemId) {
    throw new Error(
      "Supplier or item was never resolved for this row — re-stage the sheet after importing them.",
    );
  }
  const result = await upsertSupplierProduct(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    supplierId: m.supplierId,
    inventoryItemId: m.inventoryItemId,
    supplierSku: m.supplierSku ?? undefined,
    barcode: m.barcode ?? undefined,
    name: m.name ?? m.itemName ?? "Supplier product",
    packSize: m.packSize ?? undefined,
    unitPrice: Number(m.unitPrice ?? 0),
    currency: "TZS",
    minOrderQuantity: m.minOrderQuantity ?? undefined,
    leadTimeDays: m.leadTimeDays ?? undefined,
    active: true,
  });
  return result.id as string;
}

async function commitMenuItemRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  menuId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  const slug = `${slugify(m.name)}-${record.source_row}`;
  const result = await upsertMenuItem(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    menuId,
    categoryId: m.categoryId ?? undefined,
    name: m.name,
    slug,
    description: m.description ?? undefined,
    price: Number(m.price ?? 0),
    currency: "TZS",
    available: m.available ?? true,
    tags: [],
    allergens: [],
    sortOrder: 0,
  });
  return result.id as string;
}

async function commitProductStationRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  if (!m.menuItemId) {
    throw new Error(
      "Dish was never resolved for this row — re-stage the sheet after importing it.",
    );
  }
  if (!m.stationId) {
    throw new Error(
      "Station was never resolved for this row — check the station code and re-stage.",
    );
  }
  const result = await upsertProduct(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    sku: m.sku ?? `PROD-${slugify(m.menuItemName ?? "item")}-${record.source_row}`,
    name: m.menuItemName,
    productType: "standard",
    menuItemId: m.menuItemId,
    stationId: m.stationId,
    price: Number(m.price ?? 0),
    currency: "TZS",
    active: m.active ?? true,
    servicePeriodIds: [],
    sortOrder: 0,
    taxRate: 0,
  });
  return result.id as string;
}

async function commitVariantRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  if (!m.productId) {
    throw new Error(
      "Product/station link was never resolved for this row — import the product/station relationship first, then re-stage this sheet.",
    );
  }
  const result = await upsertVariant(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    productId: m.productId,
    sku: m.sku ?? undefined,
    name: m.name,
    price: Number(m.price ?? 0),
    priceIsDelta: Boolean(m.priceIsDelta),
    yieldFactor: 1,
    active: m.active ?? true,
    sortOrder: 0,
  });
  return result.id as string;
}

async function commitModifierGroupRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  const result = await upsertModifierGroup(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    code: m.code,
    name: m.name,
    minSelect: Number(m.minSelect ?? 0),
    maxSelect: Number(m.maxSelect ?? 1),
    required: Boolean(m.required),
    active: m.active ?? true,
    sortOrder: 0,
  });
  return result.id as string;
}

async function commitModifierRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string> {
  const m = record.mapped_data;
  if (!m.groupId) {
    throw new Error(
      "Modifier group was never resolved for this row — import the modifier group first, then re-stage this sheet.",
    );
  }
  // Belt-and-braces: staging already blocks "recipe" (see stage.ts), but a
  // human can still force-approve a row that still carries a validation
  // error — this must never fall through to writing a wrong effect.
  if (m.effect === "recipe") {
    throw new Error(
      "Recipe-effect modifiers are not supported by import — create this modifier manually.",
    );
  }
  if (m.effect === "inventory" && !m.inventoryItemId) {
    throw new Error(
      "Ingredient was never resolved for this row — re-stage the sheet after importing it.",
    );
  }
  const result = await upsertModifier(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    groupId: m.groupId,
    name: m.name,
    priceDelta: Number(m.priceDelta ?? 0),
    effect: m.effect === "inventory" ? "inventory" : "none",
    inventoryItemId: m.inventoryItemId ?? undefined,
    quantity: Number(m.quantity ?? 0),
    unitId: m.unitId ?? undefined,
    active: m.active ?? true,
    sortOrder: 0,
  });
  return result.id as string;
}

async function commitProductModifierGroupRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
): Promise<string | null> {
  const m = record.mapped_data;
  if (!m.productId) {
    throw new Error(
      "Product/station link was never resolved for this row — import it first, then re-stage this sheet.",
    );
  }
  if (!m.groupId) {
    throw new Error(
      "Modifier group was never resolved for this row — import it first, then re-stage this sheet.",
    );
  }
  await attachModifierGroup(sb, userId, {
    tenantId,
    productId: m.productId,
    groupId: m.groupId,
    sortOrder: Number(m.sortOrder ?? 0),
    attached: true,
  });
  const { data } = await sb
    .from("restaurant_product_modifier_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("product_id", m.productId)
    .eq("group_id", m.groupId)
    .maybeSingle();
  return (data as any)?.id ?? null;
}

async function commitRecipeComponentRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
  units: readonly UnitRow[],
): Promise<string> {
  const m = record.mapped_data;
  if (!m.menuItemId || !m.inventoryItemId) {
    throw new Error(
      "Dish or ingredient was never resolved for this row — re-stage the sheet after importing them.",
    );
  }
  const { data: item, error } = await sb
    .from("restaurant_inventory_items")
    .select("unit_id")
    .eq("tenant_id", tenantId)
    .eq("id", m.inventoryItemId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  let quantity = Number(m.quantity ?? 0);
  let unitId: string | null = item?.unit_id ?? m.unitId ?? null;
  if (m.unitId && item?.unit_id && m.unitId !== item.unit_id) {
    const fromUnit = units.find((u) => u.id === m.unitId);
    const toUnit = units.find((u) => u.id === item.unit_id);
    const converted = convertUnits(quantity, fromUnit, toUnit);
    if (!converted.exact) {
      throw new Error(
        converted.reason ?? "This ingredient's unit cannot be converted to the item's stock unit.",
      );
    }
    quantity = converted.quantity;
    unitId = item.unit_id;
  }

  const result = await upsertRecipeComponent(sb, userId, {
    tenantId,
    id: record.matched_entity_id ?? undefined,
    menuItemId: m.menuItemId,
    inventoryItemId: m.inventoryItemId,
    unitId: unitId ?? undefined,
    quantity,
    yieldPercent: Number(m.yieldPercent ?? 100),
    notes: m.notes ?? undefined,
  });
  return result.id as string;
}

async function commitOpeningStockRow(
  sb: Sb,
  userId: string,
  tenantId: string,
  record: any,
  workspace: any,
  units: readonly UnitRow[],
): Promise<string> {
  const m = record.mapped_data;
  if (!m.inventoryItemId) {
    throw new Error(
      "Item was never resolved for this row — re-stage the sheet after importing it.",
    );
  }
  const { data: item, error } = await sb
    .from("restaurant_inventory_items")
    .select("id, unit_id, average_cost, currency, property_id, location_id")
    .eq("tenant_id", tenantId)
    .eq("id", m.inventoryItemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item)
    throw new Error(
      "Item was never resolved for this row — re-stage the sheet after importing it.",
    );

  const locationId = m.locationId ?? workspace.location_id ?? item.location_id ?? null;
  if (!locationId)
    throw new Error(
      "No storage location — set one on the workspace or in the source's Location column.",
    );

  let quantity = Number(m.quantity ?? 0);
  if (m.unitId && item.unit_id && m.unitId !== item.unit_id) {
    const fromUnit = units.find((u) => u.id === m.unitId);
    const toUnit = units.find((u) => u.id === item.unit_id);
    const converted = convertUnits(quantity, fromUnit, toUnit);
    if (!converted.exact) {
      throw new Error(
        converted.reason ??
          "This opening quantity's unit cannot be converted to the item's stock unit.",
      );
    }
    quantity = converted.quantity;
  }
  if (quantity <= 0) throw new Error("Opening quantity must be greater than zero.");

  // Same dedupe key an item's own opening-quantity write uses (upsertInventoryItem), so
  // whichever sheet posts the balance first wins and a second description of the same
  // item's opening stock is a safe no-op rather than a double count.
  await insertMovement(sb, userId, {
    tenantId,
    propertyId: workspace.property_id ?? item.property_id ?? null,
    locationId,
    inventoryItemId: item.id,
    unitId: item.unit_id,
    movementType: "opening_balance",
    quantity,
    unitCost: Number(m.unitCost ?? item.average_cost ?? 0),
    currency: item.currency ?? "TZS",
    reason: "Opening balance (import)",
    referenceType: "restaurant_import_staged_records",
    referenceId: record.id,
    dedupeKey: `opening_balance:${item.id}`,
  });
  return item.id as string;
}

export async function commitImportWorkspace(
  sb: Sb,
  userId: string,
  input: CommitImportWorkspaceInput,
) {
  await assertCapability(sb, userId, input.tenantId, "import.manage");
  const { data: workspace, error: wErr } = await sb
    .from("restaurant_import_workspaces")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (wErr) throw new Error(wErr.message);
  if (!workspace) throw new Error("Import workspace not found.");
  if (workspace.status === "cancelled")
    throw new Error("This workspace was cancelled and cannot be committed.");
  // Not "already committed": a workspace stays open to a follow-up commit —
  // a human resolving exceptions after the fact approves more records, then
  // commits again. Already-committed records are gated by committed_at, not
  // by workspace status, so this is always safe to re-run.
  const statusBeforeThisRun = workspace.status;

  await sb
    .from("restaurant_import_workspaces")
    .update({ status: "committing", updated_at: new Date().toISOString() })
    .eq("id", workspace.id);

  const { data: units } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, name, dimension, factor, base_unit_id")
    .or(`tenant_id.is.null,tenant_id.eq.${input.tenantId}`);
  const unitRows = (units ?? []) as UnitRow[];

  let targetMenuId = input.targetMenuId ?? null;
  const outcomes: CommitOutcome[] = [];

  for (const domain of IMPORT_DOMAIN_COMMIT_ORDER) {
    const { data: records, error } = await sb
      .from("restaurant_import_staged_records")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("workspace_id", input.workspaceId)
      .eq("domain", domain)
      .eq("decision", "approved")
      .is("committed_at", null)
      .order("source_row");
    if (error) throw new Error(error.message);
    const pending = (records ?? []) as any[];
    if (pending.length === 0) continue;

    if (domain === "menu_item" && !targetMenuId) {
      const menu = await upsertMenu(sb, userId, {
        tenantId: input.tenantId,
        propertyId: workspace.property_id ?? undefined,
        locationId: workspace.location_id ?? undefined,
        name: `${workspace.name} — Imported Menu`,
        slug: `${slugify(workspace.name)}-${slugify(workspace.workspace_number)}`,
        version: 1,
        status: "draft",
        currency: "TZS",
      });
      targetMenuId = menu.id as string;
    }

    for (const record of pending) {
      let committedEntityId: string | null = null;
      let commitError: string | null = null;
      try {
        switch (domain) {
          case "supplier":
            committedEntityId = await commitSupplierRow(sb, userId, input.tenantId, record);
            break;
          case "inventory_item":
            committedEntityId = await commitInventoryItemRow(sb, userId, input.tenantId, record);
            break;
          case "supplier_product":
            committedEntityId = await commitSupplierProductRow(sb, userId, input.tenantId, record);
            break;
          case "menu_item":
            committedEntityId = await commitMenuItemRow(
              sb,
              userId,
              input.tenantId,
              targetMenuId!,
              record,
            );
            break;
          case "product_station":
            committedEntityId = await commitProductStationRow(sb, userId, input.tenantId, record);
            break;
          case "variant":
            committedEntityId = await commitVariantRow(sb, userId, input.tenantId, record);
            break;
          case "modifier_group":
            committedEntityId = await commitModifierGroupRow(sb, userId, input.tenantId, record);
            break;
          case "modifier":
            committedEntityId = await commitModifierRow(sb, userId, input.tenantId, record);
            break;
          case "product_modifier_group":
            committedEntityId = await commitProductModifierGroupRow(
              sb,
              userId,
              input.tenantId,
              record,
            );
            break;
          case "recipe_component":
            committedEntityId = await commitRecipeComponentRow(
              sb,
              userId,
              input.tenantId,
              record,
              unitRows,
            );
            break;
          case "opening_stock":
            committedEntityId = await commitOpeningStockRow(
              sb,
              userId,
              input.tenantId,
              record,
              workspace,
              unitRows,
            );
            break;
        }
      } catch (err) {
        commitError = err instanceof Error ? err.message : String(err);
      }

      await sb
        .from("restaurant_import_staged_records")
        .update({
          committed_at: commitError ? null : new Date().toISOString(),
          committed_entity_id: committedEntityId,
          commit_error: commitError,
          updated_at: new Date().toISOString(),
        })
        .eq("id", record.id)
        .eq("tenant_id", input.tenantId);

      outcomes.push({ recordId: record.id, domain, committedEntityId, error: commitError });
    }
  }

  const failedCount = outcomes.filter((o) => o.error).length;
  const finalStatus =
    outcomes.length === 0 ? statusBeforeThisRun : failedCount > 0 ? "failed" : "committed";
  await sb
    .from("restaurant_import_workspaces")
    .update({ status: finalStatus, updated_at: new Date().toISOString() })
    .eq("id", workspace.id)
    .eq("tenant_id", input.tenantId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.import.committed",
    tenantId: input.tenantId,
    propertyId: workspace.property_id ?? undefined,
    locationId: workspace.location_id ?? undefined,
    entityType: "restaurant_import_workspace",
    entityId: workspace.id,
    source: "restaurant-os",
    payload: {
      workspace_number: workspace.workspace_number,
      committed: outcomes.length - failedCount,
      failed: failedCount,
      status: finalStatus,
    },
  });

  return {
    status: finalStatus as "committed" | "failed" | "committing",
    committed: outcomes.length - failedCount,
    failed: failedCount,
    outcomes,
  };
}
