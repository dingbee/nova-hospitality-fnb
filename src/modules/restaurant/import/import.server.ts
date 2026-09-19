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
import { upsertCategory, upsertMenu, upsertMenuItem } from "../menu/menu.server";
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
  type DomainGuess,
  type ImportDomain,
} from "./domains";
import { suggestDomainViaAi, suggestFieldViaAi } from "./ai-assist";
import { applyMapping } from "./normalize";
import {
  stageCategoryRow,
  stageInventoryItemRow,
  stageMenuItemRow,
  stageMenuRow,
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
  await assertCapability(sb, userId, input.tenantId, "import.manage", {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
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
      .select("id, domain, match_status, severity, decision, committed_at, commit_error")
      .eq("tenant_id", input.tenantId)
      .eq("workspace_id", input.workspaceId),
  ]);
  if (wErr) throw new Error(wErr.message);
  if (!workspace) throw new Error("Import workspace not found.");
  if (sErr) throw new Error(sErr.message);
  if (stErr) throw new Error(stErr.message);

  // No source column NoVA couldn't place is ever silently dropped — this is
  // the operator-visible record of exactly that: every column a reviewer
  // saw and chose "— ignore this column —" for (or that had no confident
  // alias at all), across every sheet this workspace has confirmed a
  // mapping for. The source row itself (raw_data) keeps the actual values
  // regardless; this is only the summary of *which columns* were left out.
  const sourceIds = ((sources ?? []) as any[]).map((s) => s.id);
  let unmappedColumns: Array<{ sheetName: string; domain: string; columns: string[] }> = [];
  if (sourceIds.length > 0) {
    const { data: mappings, error: mErr } = await sb
      .from("restaurant_import_field_mappings")
      .select("sheet_name, domain, mapping")
      .eq("tenant_id", input.tenantId)
      .in("source_id", sourceIds);
    if (mErr) throw new Error(mErr.message);
    unmappedColumns = ((mappings ?? []) as any[])
      .map((m) => ({
        sheetName: m.sheet_name,
        domain: m.domain,
        columns: (m.mapping as Array<{ sourceColumn: string; canonicalField: string | null }>)
          .filter((f) => !f.canonicalField)
          .map((f) => f.sourceColumn),
      }))
      .filter((m) => m.columns.length > 0);
  }

  const rows = (staged ?? []) as any[];
  const byDomain: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  const byPlan = { create: 0, update: 0, review: 0, reject: 0 };
  let committed = 0;
  let failed = 0;
  for (const r of rows) {
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    byPlan[planBucketFor(r)] += 1;
    if (r.committed_at) committed += 1;
    if (r.commit_error) failed += 1;
  }
  return {
    workspace,
    sources: sources ?? [],
    summary: { total: rows.length, byDomain, bySeverity, byDecision, byPlan, committed, failed },
    unmappedColumns,
  };
}

/**
 * The pre-commit import plan's own bucket for one staged row: what will
 * actually happen to it if the workspace is committed as it stands right
 * now. A row a human has already rejected, or that can't be safely mapped
 * at all, is REJECT regardless of anything else. A row still waiting on a
 * human because it's ambiguous or carries an unresolved finding (an
 * unrecognised unit, a currency mismatch) is REVIEW — even when it would
 * otherwise create a brand new entity, matching the plan example in the
 * spec ("2 unknown units" is its own REVIEW line, not folded into CREATE).
 * Everything else is either a brand new entity (CREATE) or a link to one
 * that already exists (UPDATE).
 */
function planBucketFor(r: {
  decision: string;
  severity: string;
  match_status: string;
}): "create" | "update" | "review" | "reject" {
  if (r.decision === "rejected" || r.severity === "cannot_map") return "reject";
  if (
    r.decision === "pending" &&
    (r.severity === "ambiguous_match" || r.severity === "missing_field")
  )
    return "review";
  if (r.match_status === "new_entity") return "create";
  return "update";
}

/* ================= Source upload & parse ================= */

function extensionFor(kind: string, mimeType?: string): string {
  if (kind === "xlsx") return "xlsx";
  if (kind === "csv") return "csv";
  if (kind === "pdf") return "pdf";
  if (kind === "image") return mimeType?.includes("png") ? "png" : "jpg";
  return "txt";
}

function defaultMimeTypeFor(kind: string): string | undefined {
  if (kind === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (kind === "csv") return "text/csv";
  if (kind === "json") return "application/json";
  if (kind === "pdf") return "application/pdf";
  return undefined;
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

/**
 * Only reaches for AI when the deterministic heuristic genuinely could not
 * place a sheet (no guess at all, or its best guess is weak) — a confident
 * heuristic result is never second-guessed. Appends the AI's own guess
 * rather than replacing anything, and skips it outright if the AI happened
 * to land on a domain the heuristic already suggested (nothing to add).
 */
async function withAiDomainAssist(
  headers: readonly string[],
  rows: readonly Record<string, string>[],
  heuristicGuesses: DomainGuess[],
): Promise<DomainGuess[]> {
  const topConfidence = heuristicGuesses[0]?.confidence ?? 0;
  if (topConfidence >= 0.5) return heuristicGuesses;
  const ai = await suggestDomainViaAi(headers, rows);
  if (!ai || heuristicGuesses.some((g) => g.domain === ai.domain)) return heuristicGuesses;
  return [
    ...heuristicGuesses,
    { domain: ai.domain, confidence: ai.confidence, matchedHeaders: [], source: "ai" as const },
  ];
}

/**
 * The one property-level fact the commit path actually needs about money:
 * what currency this property's own prices/costs are already in, so a
 * source row is judged against the property's real setting rather than a
 * literal hardcoded everywhere it commits a price. "TZS" is the same
 * last-resort fallback already used throughout this codebase when a
 * property has no currency configured at all — never invented here.
 */
async function resolvePropertyCurrency(
  sb: Sb,
  tenantId: string,
  propertyId: string | null | undefined,
): Promise<string> {
  if (!propertyId) return "TZS";
  const { data } = await sb
    .from("restaurant_properties")
    .select("currency")
    .eq("tenant_id", tenantId)
    .eq("id", propertyId)
    .maybeSingle();
  return (data as any)?.currency ?? "TZS";
}

/**
 * Resolves a workspace's own property/location scope for the "lookup-then-
 * scope" pattern 0063_p09_import_workspace_property_scope.sql documents
 * (the same one 0061 uses for restaurant_menu_items/restaurant_recipe_components):
 * every workspace-orchestration entry point below that acts on an EXISTING
 * workspace resolves its real property_id/location_id first, then passes
 * that as assertCapability's scope — so a property-scoped owner/general_manager/
 * restaurant_manager can only drive an import workspace that belongs to a
 * property they actually hold that grant at. RLS enforces the same boundary
 * independently (0063/0072's "…write scoped" policies) and fails closed
 * either way; this is what turns a raw RLS rejection into the same clean
 * "Forbidden" error every other capability check in this codebase gives.
 */
async function resolveWorkspaceScope(
  sb: Sb,
  tenantId: string,
  workspaceId: string,
): Promise<{ propertyId: string | null; locationId: string | null }> {
  const { data } = await sb
    .from("restaurant_import_workspaces")
    .select("property_id, location_id")
    .eq("tenant_id", tenantId)
    .eq("id", workspaceId)
    .maybeSingle();
  return {
    propertyId: (data as any)?.property_id ?? null,
    locationId: (data as any)?.location_id ?? null,
  };
}

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
  const { data: ws } = await sb
    .from("restaurant_import_workspaces")
    .select("id, status, property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (!ws) throw new Error("Import workspace not found.");
  await assertCapability(sb, userId, input.tenantId, "import.manage", {
    propertyId: ws.property_id,
    locationId: ws.location_id,
  });
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
    const effectiveMimeType =
      input.mimeType && input.mimeType !== "application/octet-stream"
        ? input.mimeType
        : defaultMimeTypeFor(input.kind);
    storagePath =
      input.tenantId +
      "/" +
      input.workspaceId +
      "/" +
      sourceId +
      "." +
      extensionFor(input.kind, effectiveMimeType);
    const { error: upErr } = await sb.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: effectiveMimeType ?? "application/octet-stream",
      upsert: false,
    });
    if (upErr) throw new Error(upErr.message);
    input.mimeType = effectiveMimeType;
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
  const source = await loadSourceRow(sb, input.tenantId, input.sourceId);
  const scope = await resolveWorkspaceScope(sb, input.tenantId, source.workspace_id);
  await assertCapability(sb, userId, input.tenantId, "import.manage", scope);

  try {
    const parsed = await parseSourceContent(sb, source);
    const sheetSummaries = await Promise.all(
      parsed.sheets.map(async (s) => {
        const heuristicGuesses = detectDomains(s.headers);
        const detectedDomains = await withAiDomainAssist(s.headers, s.rows, heuristicGuesses);
        return {
          sheetName: s.sheetName,
          headers: s.headers,
          rowCount: s.rows.length,
          detectedDomains,
        };
      }),
    );
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
  const heuristicMapping = suggestFieldMapping(sheet.headers, input.domain);
  const mapping = await Promise.all(
    heuristicMapping.map(async (m) => {
      if (m.canonicalField) return m;
      const sampleValues = sheet.rows.slice(0, 5).map((r) => r[m.sourceColumn] ?? "");
      const ai = await suggestFieldViaAi(m.sourceColumn, input.domain, sampleValues);
      if (!ai) return m;
      // Still not "auto": an AI-sourced guess gets exactly the same standing
      // as an unmatched column always has — visible in the review table,
      // never silently applied — the reviewer picks it (or doesn't).
      return { ...m, canonicalField: ai.canonicalField, confidence: ai.confidence };
    }),
  );
  return {
    headers: sheet.headers,
    mapping,
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
    { data: menus },
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
    sb.from("restaurant_menus").select("id, slug, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_categories")
      .select("id, slug, name")
      .eq("tenant_id", tenantId)
      .eq("kind", "menu"),
    sb.from("restaurant_menu_items").select("id, name, menu_id").eq("tenant_id", tenantId),
    sb
      .from("restaurant_supplier_products")
      .select("id, supplier_id, supplier_sku, barcode")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_locations").select("id, name").eq("tenant_id", tenantId),
    sb.from("restaurant_stations").select("id, code, name").eq("tenant_id", tenantId),
    sb
      .from("restaurant_products")
      .select("id, menu_item_id, station_id, sku")
      .eq("tenant_id", tenantId),
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
    menus: menus ?? [],
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
  ref: Awaited<ReturnType<typeof fetchRefData>> & { propertyCurrency?: string },
): StageResult {
  switch (domain) {
    case "supplier":
      return stageSupplierRow(mappedRaw, { suppliers: ref.suppliers });
    case "inventory_item":
      return stageInventoryItemRow(mappedRaw, {
        inventoryItems: ref.inventoryItems,
        units: ref.units,
        categories: ref.inventoryCategories,
        propertyCurrency: ref.propertyCurrency,
      });
    case "supplier_product":
      return stageSupplierProductRow(mappedRaw, {
        suppliers: ref.suppliers,
        inventoryItems: ref.inventoryItems,
        existingSupplierProducts: ref.supplierProducts,
        units: ref.units,
        propertyCurrency: ref.propertyCurrency,
      });
    case "menu":
      return stageMenuRow(mappedRaw, { menus: ref.menus });
    case "category":
      return stageCategoryRow(mappedRaw, { categories: ref.menuCategories, menus: ref.menus });
    case "menu_item":
      return stageMenuItemRow(mappedRaw, {
        menuItems: ref.menuItems,
        categories: ref.menuCategories,
        menus: ref.menus,
        propertyCurrency: ref.propertyCurrency,
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
        products: ref.products,
      });
    case "opening_stock":
      return stageOpeningStockRow(mappedRaw, {
        inventoryItems: ref.inventoryItems,
        units: ref.units,
        locations: ref.locations,
        propertyCurrency: ref.propertyCurrency,
      });
  }
}

export async function confirmImportMapping(
  sb: Sb,
  userId: string,
  input: ConfirmImportMappingInput,
) {
  const source = await loadSourceRow(sb, input.tenantId, input.sourceId);
  const scope = await resolveWorkspaceScope(sb, input.tenantId, source.workspace_id);
  await assertCapability(sb, userId, input.tenantId, "import.manage", scope);

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

  const propertyCurrency = await resolvePropertyCurrency(sb, input.tenantId, scope.propertyId);
  const ref = { ...(await fetchRefData(sb, input.tenantId)), propertyCurrency };

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
      match_candidates: result.matchCandidates,
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