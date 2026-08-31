/**
 * I11 — pure, deterministic classification of a staff free-text
 * instruction into intent/domain/action plus raw (unresolved) mentions of
 * entities, locations, supplier, temporal reference, and qualifiers.
 *
 * Deliberately keyword/pattern-based, not AI: per the I11 architectural
 * verdict (point 8), every example this sprint's spec gives is reliably
 * classifiable this way, so no AI call is made for classification. Nothing
 * here resolves an entity against real data — that is understand.server.ts's
 * job, against the actual tenant's inventory/menu/supplier/location rows.
 */
import { parseGuestCount, parseItemQuantities, type QuantityMatch } from "./quantity";
import type {
  NovaAction,
  NovaDomain,
  NovaIntentType,
  NovaRequestedExecution,
  NovaServicePeriod,
  NovaSupplierReferenceKind,
  NovaTemporalKind,
} from "./intent.contracts";

export interface RawCommandLine {
  raw: string;
  quantity: QuantityMatch | null;
  entityRaw: string | null;
}

export interface RawTemporalReference {
  raw: string;
  kind: NovaTemporalKind;
  servicePeriod: NovaServicePeriod | null;
}

export interface RawSupplierReference {
  raw: string;
  kind: NovaSupplierReferenceKind;
}

export interface ClassifiedInstruction {
  intent: NovaIntentType;
  domain: NovaDomain;
  action: NovaAction;
  requestedExecution: NovaRequestedExecution;
  /** Deterministic classification confidence — a rough measure of how strong the keyword match was, never presented as statistical certainty. */
  confidence: number;
  lines: RawCommandLine[];
  /** For a query/planning utterance with no stated quantity (e.g. "how much chicken will we need..."), the bare subject noun phrase left after stripping question words, temporal, and guest-count text. */
  bareSubjectRaw: string | null;
  sourceLocationRaw: string | null;
  destinationLocationRaw: string | null;
  supplier: RawSupplierReference | null;
  temporal: RawTemporalReference | null;
  guestCount: { raw: string; count: number } | null;
  /** Verbatim qualifier/negation clauses — never dropped even when not further interpreted. */
  constraints: string[];
}

interface DomainActionGuess {
  intent: NovaIntentType;
  domain: NovaDomain;
  action: NovaAction;
  requestedExecution: NovaRequestedExecution;
  confidence: number;
}

function guessReadDomain(lower: string): NovaDomain {
  if (/\b(sales|revenue|takings)\b/.test(lower)) return "sales";
  if (/\b(menu|dish|price|pricing)\b/.test(lower)) return "menu";
  if (/\b(kitchen|prep|ticket)\b/.test(lower)) return "kitchen";
  return "inventory";
}

function readActionFor(domain: NovaDomain): NovaAction {
  switch (domain) {
    case "sales":
      return "query_sales";
    case "menu":
      return "query_menu";
    case "kitchen":
      return "query_kitchen";
    default:
      return "query_inventory";
  }
}

/** Deterministic domain/action/intent classification from keyword patterns grounded in this app's own module vocabulary (see the I11 architectural verdict). */
function classifyDomainAction(lower: string): DomainActionGuess {
  const has = (re: RegExp) => re.test(lower);
  const wantsPrepare = has(/\b(prepare|create|draft)\b/);

  if (has(/\bapprove\b/)) {
    if (has(/purchase order|\bpo\b/)) {
      return {
        intent: "approval_request",
        domain: "procurement",
        action: "approve_purchase_order",
        requestedExecution: "approve",
        confidence: 0.9,
      };
    }
    return {
      intent: "approval_request",
      domain: "general",
      action: "unknown",
      requestedExecution: "approve",
      confidence: 0.4,
    };
  }

  if (has(/\bsubmit\b/) && has(/purchase order|\bpo\b/)) {
    return {
      intent: "operational_command",
      domain: "procurement",
      action: "submit_purchase_order",
      requestedExecution: "submit",
      confidence: 0.85,
    };
  }

  if (has(/purchase order|\bpo\b/)) {
    return {
      intent: "operational_command",
      domain: "procurement",
      action: "prepare_purchase_order",
      requestedExecution: "prepare",
      confidence: 0.85,
    };
  }

  if (has(/stock movement\b/)) {
    const requestedExecution: NovaRequestedExecution = wantsPrepare ? "prepare" : "execute";
    return {
      intent: "operational_command",
      domain: "stock_movement",
      action:
        requestedExecution === "prepare" ? "prepare_stock_movement" : "execute_stock_movement",
      requestedExecution,
      confidence: 0.85,
    };
  }

  if (has(/\brequisition\b/)) {
    return {
      intent: "operational_command",
      domain: "stock_movement",
      action: "prepare_requisition",
      requestedExecution: wantsPrepare ? "prepare" : "execute",
      confidence: 0.85,
    };
  }

  if (has(/\b(pull|move|transfer)\b/)) {
    // Destination-only phrasing ("pull ... to the bar") reads as a requisition to a service point rather than a two-sided stock movement — but this is a naming heuristic only; both still require source+destination to be resolved before anything could be prepared.
    const isRequisitionShaped = !has(/\bfrom\b/) && has(/\bto\b/);
    const requestedExecution: NovaRequestedExecution = wantsPrepare ? "prepare" : "execute";
    return {
      intent: "operational_command",
      domain: "stock_movement",
      action: isRequisitionShaped
        ? "prepare_requisition"
        : requestedExecution === "prepare"
          ? "prepare_stock_movement"
          : "execute_stock_movement",
      requestedExecution,
      confidence: 0.75,
    };
  }

  if (has(/\bhow (much|many)\b/) && has(/\bneed\b/)) {
    const domain = guessReadDomain(lower);
    return {
      intent: "planning_request",
      domain,
      action: readActionFor(domain),
      requestedExecution: "understand_only",
      confidence: 0.75,
    };
  }

  if (has(/\b(how much|how many|what|which|show me|do we have)\b/) || /\?\s*$/.test(lower)) {
    const domain = guessReadDomain(lower);
    return {
      intent: "information_query",
      domain,
      action: readActionFor(domain),
      requestedExecution: "understand_only",
      confidence: 0.65,
    };
  }

  return {
    intent: "information_query",
    domain: "general",
    action: "unknown",
    requestedExecution: "understand_only",
    confidence: 0.2,
  };
}

interface QualifierMatch {
  raw: string;
  label: string;
}

const QUALIFIER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(?:don'?t|do not)\s+[^,.!?]{1,60}/i, label: "negation" },
  { re: /\bnot\s+[^,.!?]{1,60}/i, label: "negation" },
  { re: /\bexcept\s+[^,.!?]{1,60}/i, label: "exception" },
  { re: /\bonly\s+[^,.!?]{1,60}/i, label: "restriction" },
  { re: /\binstead of\s+[^,.!?]{1,60}/i, label: "substitution" },
  { re: /\bbefore\s+[^,.!?]{1,60}/i, label: "temporal_before" },
  { re: /\bafter\s+[^,.!?]{1,60}/i, label: "temporal_after" },
];

function extractQualifiers(text: string): { constraints: string[]; matches: QualifierMatch[] } {
  const matches: QualifierMatch[] = [];
  for (const { re, label } of QUALIFIER_PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push({ raw: m[0].trim(), label });
  }
  return { constraints: matches.map((m) => `${m.label}: ${m.raw}`), matches };
}

function extractSupplierReference(
  text: string,
  domain: NovaDomain,
): { supplier: RawSupplierReference; remaining: string } | null {
  let m = /\b(?:our |the )?(preferred|usual)\s+supplier\b/i.exec(text);
  if (m) return { supplier: { raw: m[0], kind: "preferred" }, remaining: text.replace(m[0], " ") };

  m = /\b(?:our |the )?cheapest\s+supplier\b/i.exec(text);
  if (m) return { supplier: { raw: m[0], kind: "cheapest" }, remaining: text.replace(m[0], " ") };

  m = /\bsupplier\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,3})/i.exec(text);
  if (m) return { supplier: { raw: m[0], kind: "named" }, remaining: text.replace(m[0], " ") };

  if (domain === "procurement") {
    m = /\bfrom\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,3})\s+supplier\b/i.exec(text);
    if (m) return { supplier: { raw: m[0], kind: "named" }, remaining: text.replace(m[0], " ") };
  }
  return null;
}

function extractLocationClause(
  text: string,
  domain: NovaDomain,
): { sourceRaw: string | null; destinationRaw: string | null; remaining: string } {
  let m = /\bfrom\s+(.+?)\s+to\s+(.+?)(?=[.?!]|$)/i.exec(text);
  if (m) {
    return {
      sourceRaw: m[1].trim(),
      destinationRaw: m[2].trim(),
      remaining: text.replace(m[0], " "),
    };
  }
  m = /\bto\s+(?:the\s+)?(.+?)(?=[.?!]|$)/i.exec(text);
  if (m) {
    return { sourceRaw: null, destinationRaw: m[1].trim(), remaining: text.replace(m[0], " ") };
  }
  if (domain === "stock_movement" || domain === "inventory") {
    m = /\bfrom\s+(?:the\s+)?(.+?)(?=[.?!]|$)/i.exec(text);
    if (m) {
      return { sourceRaw: m[1].trim(), destinationRaw: null, remaining: text.replace(m[0], " ") };
    }
  }
  return { sourceRaw: null, destinationRaw: null, remaining: text };
}

const TEMPORAL_PATTERNS: Array<{ re: RegExp; kind: NovaTemporalKind }> = [
  { re: /\btomorrow\b/i, kind: "tomorrow" },
  { re: /\btoday\b/i, kind: "today" },
  { re: /\bthis evening\b/i, kind: "this_evening" },
  { re: /\bnext week'?s?\b/i, kind: "next_week" },
];

function extractTemporal(text: string): RawTemporalReference | null {
  for (const { re, kind } of TEMPORAL_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const servicePeriod: NovaServicePeriod | null = /\blunch\b/i.test(text)
        ? "lunch"
        : /\bdinner\b/i.test(text)
          ? "dinner"
          : /\bbreakfast\b/i.test(text)
            ? "breakfast"
            : null;
      return { raw: m[0], kind, servicePeriod };
    }
  }
  return null;
}

/** Splits remaining text into per-line quantity+entity mentions, one per stated quantity — never merges two quantities into one line, never drops one. */
function segmentLines(text: string): RawCommandLine[] {
  const quantities = parseItemQuantities(text);
  const lines: RawCommandLine[] = [];
  for (let i = 0; i < quantities.length; i++) {
    const q = quantities[i];
    const next = quantities[i + 1];
    const segmentEnd = next ? next.index : text.length;
    let entitySegment = text.slice(q.endIndex, segmentEnd);
    const boundary = /\b(from|to|and)\b/i.exec(entitySegment);
    if (boundary) entitySegment = entitySegment.slice(0, boundary.index);
    entitySegment = entitySegment
      .replace(/^\s*(of|the)\s+/i, "")
      .replace(/[,.]+$/, "")
      .trim();
    lines.push({
      raw: `${q.raw} ${entitySegment}`.trim(),
      quantity: q,
      entityRaw: entitySegment || null,
    });
  }
  return lines;
}

const QUERY_STOPWORDS =
  /\b(how much|how many|will|we|need|to|for|do|does|is|are|the|our|of|about|please|can|you|tell|me|show|what|which|have)\b/gi;

/** For a query/planning utterance with no stated quantity — what's left after stripping question scaffolding, guest-count and temporal text. Never used to invent a quantity, only to name the subject being asked about. */
function extractBareSubject(
  text: string,
  guestCountRaw: string | null,
  temporalRaw: string | null,
): string | null {
  let t = text;
  if (guestCountRaw) t = t.replace(guestCountRaw, " ");
  if (temporalRaw) t = t.replace(temporalRaw, " ");
  t = t.replace(QUERY_STOPWORDS, " ");
  t = t.replace(/[?.!]/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

export function classifyInstruction(message: string): ClassifiedInstruction {
  const lower = message.toLowerCase();
  const guess = classifyDomainAction(lower);

  const { constraints, matches: qualifierMatches } = extractQualifiers(message);
  let working = message;
  for (const q of qualifierMatches) working = working.replace(q.raw, " ");

  const supplierResult = extractSupplierReference(working, guess.domain);
  if (supplierResult) working = supplierResult.remaining;

  const { sourceRaw, destinationRaw, remaining } = extractLocationClause(working, guess.domain);
  working = remaining;

  const guestCount = parseGuestCount(working);
  const temporal = extractTemporal(working);

  const lines = segmentLines(working);
  const bareSubjectRaw =
    lines.length === 0
      ? extractBareSubject(working, guestCount?.raw ?? null, temporal?.raw ?? null)
      : null;

  return {
    intent: guess.intent,
    domain: guess.domain,
    action: guess.action,
    requestedExecution: guess.requestedExecution,
    confidence: guess.confidence,
    lines,
    bareSubjectRaw,
    sourceLocationRaw: sourceRaw,
    destinationLocationRaw: destinationRaw,
    supplier: supplierResult?.supplier ?? null,
    temporal,
    guestCount,
    constraints,
  };
}
