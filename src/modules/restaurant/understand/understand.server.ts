/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I11 "NOVA UNDERSTAND" — orchestration.
 *
 * Understanding only: this module never imports anything from
 * purchasing.server.ts, movements.server.ts, requisitions.server.ts,
 * receiving.server.ts, or any other write-capable restaurant module — it
 * only reads (matchInventoryItems, listUnits, and the new I11 entity
 * matchers, all of which are themselves read-only) and returns a validated
 * NovaIntentContract. There is nothing here to call even if it wanted to
 * mutate operational state.
 *
 * Deterministic first (see the I11 architectural verdict, point 8):
 * classification, quantity/unit parsing, and entity resolution are all
 * plain code — no AI call is made anywhere in this file.
 */
import { assertCapability } from "../core/access.server";
import { matchInventoryItems, listUnits } from "../inventory/inventory.server";
import { resolveUnitId, type UnitRowLike } from "./quantity";
import { classifyInstruction, type RawCommandLine } from "./classify";
import {
  classifyMatchOutcome,
  listPreferredSuppliers,
  matchLocationEntities,
  matchMenuEntities,
  matchSupplierEntities,
} from "./entity-matchers.server";
import {
  novaIntentContractSchema,
  type NovaAmbiguity,
  type NovaEntityDomain,
  type NovaEntityMention,
  type NovaIntentContract,
  type NovaLocationReference,
  type NovaQuantityMention,
  type NovaSupplierReference,
  type NovaTemporalReference,
  type UnderstandNovaInstructionInput,
} from "./intent.contracts";

type Sb = any;

function entityDomainFor(domain: NovaIntentContract["domain"]): NovaEntityDomain {
  return domain === "menu" ? "menu_item" : "inventory_item";
}

async function resolveEntityMention(
  sb: Sb,
  userId: string,
  tenantId: string,
  entityDomain: NovaEntityDomain,
  raw: string,
): Promise<Omit<NovaEntityMention, "quantity">> {
  const ranked =
    entityDomain === "menu_item"
      ? await matchMenuEntities(sb, userId, { tenantId, name: raw })
      : await matchInventoryItems(sb, userId, { tenantId, query: { name: raw } });
  const outcome = classifyMatchOutcome(ranked);
  return {
    raw,
    entityDomain,
    status: outcome.status,
    resolvedId: outcome.resolvedId,
    resolvedName: outcome.resolvedName,
    candidates: outcome.candidates,
  };
}

async function resolveLocation(
  sb: Sb,
  userId: string,
  tenantId: string,
  raw: string,
): Promise<NovaLocationReference> {
  const ranked = await matchLocationEntities(sb, userId, { tenantId, name: raw });
  const outcome = classifyMatchOutcome(ranked);
  return {
    raw,
    status: outcome.status,
    resolvedId: outcome.resolvedId,
    resolvedName: outcome.resolvedName,
    candidates: outcome.candidates,
  };
}

function stripSupplierNoiseWords(raw: string): string {
  return raw
    .replace(/\bsupplier\b/gi, "")
    .replace(/\bfrom\b/gi, "")
    .trim();
}

async function resolveSupplier(
  sb: Sb,
  userId: string,
  tenantId: string,
  ref: { raw: string; kind: NovaSupplierReference["kind"] },
): Promise<NovaSupplierReference> {
  if (ref.kind === "preferred") {
    const preferred = await listPreferredSuppliers(sb, userId, tenantId);
    if (preferred.length === 0) {
      return {
        raw: ref.raw,
        kind: "preferred",
        status: "unresolved",
        resolvedId: null,
        resolvedName: null,
        candidates: [],
      };
    }
    if (preferred.length === 1) {
      return {
        raw: ref.raw,
        kind: "preferred",
        status: "exact",
        resolvedId: preferred[0].id,
        resolvedName: preferred[0].name,
        candidates: [],
      };
    }
    return {
      raw: ref.raw,
      kind: "preferred",
      status: "ambiguous",
      resolvedId: null,
      resolvedName: null,
      candidates: preferred.slice(0, 5).map((p) => ({ id: p.id, name: p.name, score: 1 })),
    };
  }

  if (ref.kind === "cheapest") {
    // Deliberately never resolved here — ranking suppliers by price is
    // intelligence/purchasing.server.ts's logic, not duplicated in I11.
    return {
      raw: ref.raw,
      kind: "cheapest",
      status: "deferred",
      resolvedId: null,
      resolvedName: null,
      candidates: [],
    };
  }

  const namePart = stripSupplierNoiseWords(ref.raw);
  const ranked = await matchSupplierEntities(sb, userId, { tenantId, name: namePart });
  const outcome = classifyMatchOutcome(ranked);
  return {
    raw: ref.raw,
    kind: "named",
    status: outcome.status,
    resolvedId: outcome.resolvedId,
    resolvedName: outcome.resolvedName,
    candidates: outcome.candidates,
  };
}

function locationLabel(ref: NovaLocationReference | null): string {
  if (!ref) return "an unspecified location";
  if (ref.resolvedName) return ref.resolvedName;
  if (ref.status === "ambiguous") return `"${ref.raw}" (multiple matches — needs clarification)`;
  return `"${ref.raw}" (not found)`;
}

function entityLine(e: NovaEntityMention): string {
  const qty = e.quantity ? `${e.quantity.quantity}${e.quantity.unitText} ` : "";
  if (e.resolvedName) return `${qty}${e.resolvedName}`;
  if (e.status === "ambiguous") return `${qty}"${e.raw}" (multiple matches — needs clarification)`;
  return `${qty}"${e.raw}" (not found in catalogue)`;
}

/** Deterministic, template-based summary — never an AI call, so there is nothing to fabricate: every word traces to a field already on the validated contract. */
export function buildUnderstandingSummary(c: NovaIntentContract): string {
  const lines: string[] = [];
  const itemsText = c.entities.length > 0 ? c.entities.map(entityLine).join(", ") : null;

  switch (c.action) {
    case "prepare_stock_movement":
    case "execute_stock_movement":
    case "prepare_requisition":
      lines.push(
        `I understand this as a stock movement: ${itemsText ?? "no items identified"}, ${locationLabel(c.locations.source)} → ${locationLabel(c.locations.destination)}.`,
      );
      break;
    case "prepare_purchase_order":
      lines.push(
        `I understand this as a purchase order request: ${itemsText ?? "no items identified"}.`,
      );
      break;
    case "approve_purchase_order":
      lines.push("I understand this as a request to approve a purchase order.");
      break;
    case "submit_purchase_order":
      lines.push("I understand this as a request to submit a purchase order.");
      break;
    case "query_inventory":
    case "query_sales":
    case "query_menu":
    case "query_kitchen":
      lines.push(`I understand this as a question about ${itemsText ?? c.domain}.`);
      break;
    default:
      lines.push("I wasn't able to confidently classify this as a specific restaurant action.");
  }

  if (c.supplier) {
    if (c.supplier.resolvedName) {
      lines.push(`Supplier: ${c.supplier.resolvedName}.`);
    } else if (c.supplier.kind === "cheapest") {
      lines.push(
        "Supplier: you asked for the cheapest option — selecting a supplier is a purchasing decision I don't make here.",
      );
    } else {
      lines.push(
        `Supplier: "${c.supplier.raw}" — ${c.supplier.status === "ambiguous" ? "multiple suppliers could match" : "not found"}.`,
      );
    }
  }

  if (c.temporal) {
    lines.push(
      `When: ${c.temporal.raw}${c.temporal.servicePeriod ? ` (${c.temporal.servicePeriod})` : ""}.`,
    );
  }

  if (c.constraints.length > 0) {
    lines.push(`Also noted: ${c.constraints.join("; ")}.`);
  }

  if (c.ambiguities.length > 0) {
    lines.push(
      `I need clarification before going further: ${c.ambiguities.map((a) => a.reason).join(" ")}`,
    );
  }
  if (c.missingInformation.length > 0) {
    lines.push(`Missing: ${c.missingInformation.join(", ")}.`);
  }

  lines.push(
    "This is understanding only — nothing has been prepared, moved, ordered, or approved.",
  );
  return lines.join(" ");
}

export interface UnderstandOutcome {
  contract: NovaIntentContract;
  summary: string;
}

/**
 * Understands one staff instruction. Read-only end to end: capability
 * check, deterministic classification, then server-side entity/location/
 * supplier resolution against this tenant's real data. Returns a validated
 * NovaIntentContract plus a deterministic human-readable summary — never
 * an operation, and never anything the caller could execute by accident.
 */
export async function understandNovaInstruction(
  sb: Sb,
  userId: string,
  input: UnderstandNovaInstructionInput,
): Promise<UnderstandOutcome> {
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const classified = classifyInstruction(input.message);
  const entityDomain = entityDomainFor(classified.domain);

  const needsUnits = classified.lines.some((l: RawCommandLine) => l.quantity);
  const [sourceLocation, destinationLocation, units] = await Promise.all([
    classified.sourceLocationRaw
      ? resolveLocation(sb, userId, input.tenantId, classified.sourceLocationRaw)
      : Promise.resolve(null),
    classified.destinationLocationRaw
      ? resolveLocation(sb, userId, input.tenantId, classified.destinationLocationRaw)
      : Promise.resolve(null),
    needsUnits ? listUnits(sb, userId, input.tenantId) : Promise.resolve([] as UnitRowLike[]),
  ]);

  const entities: NovaEntityMention[] = [];
  for (const line of classified.lines) {
    if (!line.entityRaw) continue;
    const mention = await resolveEntityMention(
      sb,
      userId,
      input.tenantId,
      entityDomain,
      line.entityRaw,
    );
    const quantity: NovaQuantityMention | null = line.quantity
      ? {
          raw: line.quantity.raw,
          quantity: line.quantity.quantity,
          unitText: line.quantity.unitText,
          resolvedUnitId: resolveUnitId(line.quantity.unitText, units),
        }
      : null;
    entities.push({ ...mention, quantity });
  }
  // Approval/submission requests reference a purchase order by number/id,
  // not a catalogue item — attempting to resolve the leftover words of
  // "approve the purchase order" against inventory would only ever produce
  // meaningless noise, never a real entity.
  const skipsBareSubject =
    classified.action === "approve_purchase_order" || classified.action === "submit_purchase_order";
  if (entities.length === 0 && classified.bareSubjectRaw && !skipsBareSubject) {
    const mention = await resolveEntityMention(
      sb,
      userId,
      input.tenantId,
      entityDomain,
      classified.bareSubjectRaw,
    );
    entities.push({ ...mention, quantity: null });
  }

  const supplier = classified.supplier
    ? await resolveSupplier(sb, userId, input.tenantId, classified.supplier)
    : null;

  const temporal: NovaTemporalReference | null = classified.temporal
    ? {
        raw: classified.temporal.raw,
        kind: classified.temporal.kind,
        servicePeriod: classified.temporal.servicePeriod,
      }
    : null;

  const constraints = [...classified.constraints];
  if (classified.guestCount) {
    constraints.push(`guest_count: ${classified.guestCount.count} (${classified.guestCount.raw})`);
  }

  const missingInformation: string[] = [];
  const ambiguities: NovaAmbiguity[] = [];

  if (classified.domain === "stock_movement") {
    if (!sourceLocation) missingInformation.push("source location");
    if (!destinationLocation) missingInformation.push("destination location");
  }
  if (
    classified.action === "approve_purchase_order" ||
    classified.action === "submit_purchase_order"
  ) {
    missingInformation.push("purchase order reference (number or id)");
  }

  entities.forEach((e, i) => {
    if (e.status === "ambiguous") {
      ambiguities.push({
        field: `entities[${i}]`,
        reason: `Multiple items could match "${e.raw}".`,
        candidates: e.candidates,
      });
    }
    if (e.status === "unresolved") {
      missingInformation.push(`could not identify "${e.raw}" in the catalogue`);
    }
  });
  if (sourceLocation?.status === "ambiguous") {
    ambiguities.push({
      field: "locations.source",
      reason: `Multiple locations could match "${classified.sourceLocationRaw}".`,
      candidates: sourceLocation.candidates,
    });
  }
  if (destinationLocation?.status === "ambiguous") {
    ambiguities.push({
      field: "locations.destination",
      reason: `Multiple locations could match "${classified.destinationLocationRaw}".`,
      candidates: destinationLocation.candidates,
    });
  }
  if (sourceLocation?.status === "unresolved") {
    missingInformation.push(`could not identify source location "${classified.sourceLocationRaw}"`);
  }
  if (destinationLocation?.status === "unresolved") {
    missingInformation.push(
      `could not identify destination location "${classified.destinationLocationRaw}"`,
    );
  }
  if (supplier?.status === "ambiguous") {
    ambiguities.push({
      field: "supplier",
      reason: `Multiple suppliers could match "${supplier.raw}".`,
      candidates: supplier.candidates,
    });
  }
  if (supplier?.status === "unresolved") {
    missingInformation.push(`could not identify supplier "${supplier.raw}"`);
  }

  const contract: NovaIntentContract = novaIntentContractSchema.parse({
    intent: classified.intent,
    domain: classified.domain,
    action: classified.action,
    entities,
    locations: { source: sourceLocation, destination: destinationLocation },
    supplier,
    temporal,
    constraints,
    requestedExecution: classified.requestedExecution,
    confidence: classified.confidence,
    missingInformation,
    ambiguities,
  });

  return { contract, summary: buildUnderstandingSummary(contract) };
}
