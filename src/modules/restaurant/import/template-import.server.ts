/**
 * LexiBite Import Template — deterministic import pipeline.
 *
 * Everything here rides the EXISTING Import Studio architecture end to end:
 * createImportWorkspace / uploadImportSource / parseImportSource /
 * confirmImportMapping / commitImportWorkspace (import.server.ts) — the same
 * staging table, the same tenant/property authorization, the same
 * canonical write-path services, the same commit safety. This module adds
 * no second engine and no direct writes: it only supplies, on the
 * customer's behalf, the column mapping a LexiBite template sheet doesn't
 * need a human to confirm (every header already matches a canonical field
 * alias with confidence 1 — see template.ts) and orchestrates the
 * multi-round stage/commit sequence a same-workbook forward reference
 * requires.
 *
 * Why multiple rounds: `commitImportWorkspace` resolves a row's foreign
 * keys once, at staging time, against whatever already exists in the
 * database — there is no in-memory cross-domain id map built during a
 * single commit call (see that function's own commit loop). A brand-new
 * restaurant's Menu Items sheet references a Menu Code that doesn't exist
 * in the database yet on the first pass, so those rows stay `pending`
 * (blocked by a REQUIRED validation error) until the Menu domain has
 * actually committed — then re-staging the same sheet re-resolves them.
 * The same is true down the chain: menu -> menu_item -> product_station ->
 * {variant, recipe_component, product_modifier_group}. Rather than hand-
 * coding that dependency graph, this loop just re-stages every sheet and
 * commits again, repeating until a round commits nothing new — bounded by
 * one round per domain in IMPORT_DOMAIN_COMMIT_ORDER as a safety ceiling.
 */
import { assertTenantRead } from "../core/access.server";
import { parseXlsxBase64, type ParsedSheet } from "./parsers";
import {
  detectLexibiteTemplate,
  LEXIBITE_TEMPLATE_FILENAME,
  LEXIBITE_TEMPLATE_SHEETS,
  type TemplateColumn,
  type TemplateDetectionResult,
  type TemplateSheetDef,
} from "./template";
import { IMPORT_DOMAIN_COMMIT_ORDER, type FieldMappingEntry, type ImportDomain } from "./domains";
import {
  bulkDecideStagedRecords,
  commitImportWorkspace,
  confirmImportMapping,
  createImportWorkspace,
  getImportWorkspace,
  parseImportSource,
  uploadImportSource,
} from "./import.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase client is untyped at this boundary, matching the rest of this module. */
type Sb = any;

const MAX_COMMIT_ROUNDS = IMPORT_DOMAIN_COMMIT_ORDER.length;

function findParsedSheet(
  sheets: readonly ParsedSheet[],
  canonicalName: string,
): ParsedSheet | undefined {
  const upper = canonicalName.trim().toUpperCase();
  return sheets.find((s) => s.sheetName.trim().toUpperCase() === upper);
}

function columnValue(row: Record<string, string>, header: string): string {
  return (row[header] ?? "").trim();
}

/* ================= Tier-1 workbook-internal validation (Part 8) ================= */
/**
 * Fast, pure, no-DB-access feedback shown to the customer right after
 * upload — every cross-sheet code reference this workbook makes to itself,
 * checked against the codes this SAME workbook declares. This is not the
 * authoritative check (a code might already exist in the customer's
 * account, which this function has no way to know); the authoritative
 * check is the real staging engine invoked by commitLexibiteTemplateImport,
 * whose leftover exceptions land in the same summary a reviewer already
 * knows how to read from Advanced Import.
 */
export interface TemplateIssue {
  severity: "needs_attention" | "warning";
  sheetName: string;
  message: string;
}

function codesInSheet(
  sheets: readonly ParsedSheet[],
  sheetName: string,
  header: string,
): Set<string> {
  const sheet = findParsedSheet(sheets, sheetName);
  if (!sheet) return new Set();
  return new Set(sheet.rows.map((r) => columnValue(r, header)).filter(Boolean));
}

function checkCodeReferences(
  sheets: readonly ParsedSheet[],
  issues: TemplateIssue[],
  opts: {
    fromSheet: string;
    fromColumn: string;
    toSheet: string;
    toColumn: string;
    severity: TemplateIssue["severity"];
    describe: (code: string) => string;
    /** Only check rows matching this predicate — e.g. Modifiers' Inventory SKU only matters when Effect is Inventory. */
    when?: (row: Record<string, string>) => boolean;
  },
): void {
  const fromSheet = findParsedSheet(sheets, opts.fromSheet);
  if (!fromSheet) return;
  const toSheetPresent = !!findParsedSheet(sheets, opts.toSheet);
  const validCodes = codesInSheet(sheets, opts.toSheet, opts.toColumn);
  for (const row of fromSheet.rows) {
    if (opts.when && !opts.when(row)) continue;
    const code = columnValue(row, opts.fromColumn);
    if (!code) continue;
    if (!toSheetPresent || !validCodes.has(code)) {
      issues.push({
        severity: opts.severity,
        sheetName: opts.fromSheet,
        message: opts.describe(code),
      });
    }
  }
}

export function validateLexibiteTemplateWorkbook(sheets: readonly ParsedSheet[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  checkCodeReferences(sheets, issues, {
    fromSheet: "SUPPLIER PRODUCTS",
    fromColumn: "Supplier Code",
    toSheet: "SUPPLIERS",
    toColumn: "Supplier Code",
    severity: "needs_attention",
    describe: (code) =>
      `Supplier Products references supplier ${code}, but that supplier is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "SUPPLIER PRODUCTS",
    fromColumn: "Inventory SKU",
    toSheet: "INVENTORY",
    toColumn: "SKU",
    severity: "needs_attention",
    describe: (code) =>
      `Supplier Products references SKU ${code}, but that inventory item does not exist.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "CATEGORIES",
    fromColumn: "Menu Code",
    toSheet: "MENUS",
    toColumn: "Menu Code",
    severity: "warning",
    describe: (code) => `Categories references menu ${code}, but that menu is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "MENU ITEMS",
    fromColumn: "Menu Code",
    toSheet: "MENUS",
    toColumn: "Menu Code",
    severity: "needs_attention",
    describe: (code) => `Menu Items references menu ${code}, but that menu is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "MENU ITEMS",
    fromColumn: "Category Code",
    toSheet: "CATEGORIES",
    toColumn: "Category Code",
    severity: "warning",
    describe: (code) =>
      `Menu item references category ${code}, but ${code} is not in this file — it will be left uncategorised.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "VARIANTS",
    fromColumn: "Item Code",
    toSheet: "MENU ITEMS",
    toColumn: "Item Code",
    severity: "needs_attention",
    describe: (code) => `Variants references item ${code}, but that menu item is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "ITEM MODIFIERS",
    fromColumn: "Item Code",
    toSheet: "MENU ITEMS",
    toColumn: "Item Code",
    severity: "needs_attention",
    describe: (code) =>
      `Item Modifiers references item ${code}, but that menu item is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "ITEM MODIFIERS",
    fromColumn: "Group Code",
    toSheet: "MODIFIER GROUPS",
    toColumn: "Group Code",
    severity: "needs_attention",
    describe: (code) =>
      `Item Modifiers references modifier group ${code}, but that group is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "MODIFIERS",
    fromColumn: "Group Code",
    toSheet: "MODIFIER GROUPS",
    toColumn: "Group Code",
    severity: "needs_attention",
    describe: (code) => `Modifiers references group ${code}, but that group is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "MODIFIERS",
    fromColumn: "Inventory SKU",
    toSheet: "INVENTORY",
    toColumn: "SKU",
    severity: "needs_attention",
    when: (row) => columnValue(row, "Effect").toLowerCase() === "inventory",
    describe: (code) => `Modifier references SKU ${code}, but that inventory item does not exist.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "RECIPES",
    fromColumn: "Item Code",
    toSheet: "MENU ITEMS",
    toColumn: "Item Code",
    severity: "needs_attention",
    describe: (code) => `Recipe references item ${code}, but that menu item is not in this file.`,
  });
  checkCodeReferences(sheets, issues, {
    fromSheet: "RECIPES",
    fromColumn: "Ingredient SKU",
    toSheet: "INVENTORY",
    toColumn: "SKU",
    severity: "needs_attention",
    describe: (code) => `Recipe references SKU ${code}, but that inventory item does not exist.`,
  });

  const inventory = findParsedSheet(sheets, "INVENTORY");
  if (inventory) {
    for (const row of inventory.rows) {
      const size = columnValue(row, "Content per Stock Unit");
      const unit = columnValue(row, "Content Unit");
      if ((size && !unit) || (!size && unit)) {
        const label = columnValue(row, "Item Name") || columnValue(row, "SKU") || "This item";
        const stockUnit = columnValue(row, "Stock Unit") || "its stock unit";
        const consumptionUnit = columnValue(row, "Consumption Unit");
        const usage = consumptionUnit ? ` and ${consumptionUnit} as consumption` : "";
        issues.push({
          severity: "needs_attention",
          sheetName: "INVENTORY",
          message: `"${label}" uses ${stockUnit} as stock${usage}, but content per ${stockUnit.toLowerCase()} has not been provided.`,
        });
      }
    }
  }

  return issues;
}

export interface AnalyzeLexibiteTemplateResult {
  isTemplate: boolean;
  detection: TemplateDetectionResult;
  sheetCounts: Array<{ sheetName: string; present: boolean; rowCount: number }>;
  issues: TemplateIssue[];
  ready: boolean;
}

/** Pure preview — parses the upload and reports back. Writes nothing to the database. */
export async function analyzeLexibiteTemplateUpload(
  sb: Sb,
  userId: string,
  input: { tenantId: string; fileBase64: string },
): Promise<AnalyzeLexibiteTemplateResult> {
  await assertTenantRead(sb, userId, input.tenantId);
  const parsed = parseXlsxBase64(input.fileBase64);
  const detection = detectLexibiteTemplate(parsed.sheets);

  const sheetCounts = LEXIBITE_TEMPLATE_SHEETS.map((def) => {
    const sheet = findParsedSheet(parsed.sheets, def.name);
    return { sheetName: def.name, present: !!sheet, rowCount: sheet?.rows.length ?? 0 };
  });

  if (!detection.isTemplate) {
    return { isTemplate: false, detection, sheetCounts, issues: [], ready: false };
  }

  const issues = validateLexibiteTemplateWorkbook(parsed.sheets);
  const ready = issues.every((i) => i.severity !== "needs_attention");
  return { isTemplate: true, detection, sheetCounts, issues, ready };
}

/* ================= Deterministic staging + multi-round commit ================= */

function baseMapping(sheet: TemplateSheetDef, targetDomain: ImportDomain): FieldMappingEntry[] {
  return sheet.columns
    .filter((c) => (c.domain ?? sheet.domain) === targetDomain)
    .map((c) => columnToMapping(c));
}

function columnToMapping(c: TemplateColumn): FieldMappingEntry {
  return {
    sourceColumn: c.header,
    canonicalField: c.field ?? null,
    confidence: c.field ? 1 : 0,
    auto: !!c.field,
  };
}

/**
 * MENU ITEMS is the one sheet the template asks the customer to fill in
 * once but that the existing architecture needs staged as two domains: the
 * dish itself (menu_item) and the production bridge row a variant/modifier/
 * recipe eventually attaches to (product_station — see domains.ts's own
 * doc comment on why that bridge has to exist first). Item Code and Station
 * are declared under product_station in template.ts already; Item Name,
 * Selling Price and Available are declared under menu_item but are read a
 * second time here under their product_station names (menuItemName, price,
 * active) — not a second sheet, just the same row read twice.
 */
function deriveProductStationMapping(sheet: TemplateSheetDef): FieldMappingEntry[] {
  const overridden = baseMapping(sheet, "product_station");
  const shared: FieldMappingEntry[] = [
    { sourceColumn: "Item Name", canonicalField: "menuItemName", confidence: 1, auto: true },
    { sourceColumn: "Selling Price", canonicalField: "price", confidence: 1, auto: true },
    { sourceColumn: "Available", canonicalField: "active", confidence: 1, auto: true },
  ];
  return [...overridden, ...shared];
}

interface MappingCall {
  sheetName: string;
  domain: ImportDomain;
  mapping: FieldMappingEntry[];
}

function buildMappingCalls(parsedSheets: readonly ParsedSheet[]): MappingCall[] {
  const calls: MappingCall[] = [];
  for (const def of LEXIBITE_TEMPLATE_SHEETS) {
    if (!def.domain) continue;
    const parsedSheet = findParsedSheet(parsedSheets, def.name);
    if (!parsedSheet) continue; // customer omitted this optional sheet entirely
    if (def.name === "MENU ITEMS") {
      calls.push({
        sheetName: parsedSheet.sheetName,
        domain: "menu_item",
        mapping: baseMapping(def, "menu_item"),
      });
      calls.push({
        sheetName: parsedSheet.sheetName,
        domain: "product_station",
        mapping: deriveProductStationMapping(def),
      });
    } else {
      calls.push({
        sheetName: parsedSheet.sheetName,
        domain: def.domain,
        mapping: baseMapping(def, def.domain),
      });
    }
  }
  return calls;
}

export interface CommitLexibiteTemplateImportInput {
  tenantId: string;
  propertyId?: string;
  locationId?: string;
  workspaceName: string;
  fileBase64: string;
  originalFilename?: string;
}

/**
 * The one customer-facing "Import" action for the template path: creates a
 * workspace, uploads the workbook as its single source, then repeatedly
 * stages every sheet and commits until nothing new commits. Whatever is
 * left `pending` afterwards is a genuine exception (a code this workbook
 * never declared, a unit LexiBite doesn't recognise, a duplicate) — visible
 * and actionable in the same workspace review screen Advanced Import uses,
 * never silently dropped.
 */
export async function commitLexibiteTemplateImport(
  sb: Sb,
  userId: string,
  input: CommitLexibiteTemplateImportInput,
) {
  const parsed = parseXlsxBase64(input.fileBase64);
  const detection = detectLexibiteTemplate(parsed.sheets);
  if (!detection.isTemplate) {
    throw new Error(
      "This file was not recognised as a LexiBite Import Template. Use Advanced Import for other spreadsheets.",
    );
  }

  const workspace = await createImportWorkspace(sb, userId, {
    tenantId: input.tenantId,
    name: input.workspaceName,
    propertyId: input.propertyId,
    locationId: input.locationId,
    notes: "Created from the LexiBite Import Template.",
  });

  const source = await uploadImportSource(sb, userId, {
    tenantId: input.tenantId,
    workspaceId: workspace.id,
    kind: "xlsx",
    originalFilename: input.originalFilename ?? LEXIBITE_TEMPLATE_FILENAME,
    fileBase64: input.fileBase64,
  });

  await parseImportSource(sb, userId, { tenantId: input.tenantId, sourceId: source.id });

  const mappingCalls = buildMappingCalls(parsed.sheets);
  let rounds = 0;
  for (; rounds < MAX_COMMIT_ROUNDS; rounds++) {
    for (const call of mappingCalls) {
      await confirmImportMapping(sb, userId, {
        tenantId: input.tenantId,
        sourceId: source.id,
        sheetName: call.sheetName,
        domain: call.domain,
        mapping: call.mapping,
      });
    }
    // A brand-new template import is, by construction, mostly `new_entity`
    // rows (a first-time restaurant creates its whole catalog at once) —
    // Advanced Import deliberately leaves those `pending` for a human to
    // click through one at a time, since there it might really be an
    // uncertain guess. Here it never is: every code was resolved
    // deterministically against the workbook itself, and the customer
    // already reviewed the friendly validation summary before clicking the
    // one "Import" action that reaches this function — so that one click is
    // the approval. `ambiguous_match` and `cannot_map` are the genuine
    // exceptions and are deliberately left untouched, still pending, still
    // visible in the same review screen Advanced Import uses.
    await bulkDecideStagedRecords(sb, userId, {
      tenantId: input.tenantId,
      workspaceId: workspace.id,
      severity: "new_entity",
      decision: "approved",
    });
    await bulkDecideStagedRecords(sb, userId, {
      tenantId: input.tenantId,
      workspaceId: workspace.id,
      severity: "missing_field",
      decision: "approved",
    });

    const outcome = await commitImportWorkspace(sb, userId, {
      tenantId: input.tenantId,
      workspaceId: workspace.id,
    });
    if (outcome.committed === 0) {
      rounds += 1;
      break;
    }
  }

  const finalState = await getImportWorkspace(sb, userId, {
    tenantId: input.tenantId,
    workspaceId: workspace.id,
  });

  return {
    workspaceId: workspace.id as string,
    workspace: finalState.workspace,
    summary: finalState.summary,
    rounds,
  };
}
