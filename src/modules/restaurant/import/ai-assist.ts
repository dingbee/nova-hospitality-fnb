/**
 * Import Studio — bounded, validated AI assist.
 *
 * Deterministic methods (domains.ts's alias/signal-word matching) always run
 * first and are always sufficient for a sheet that uses familiar words —
 * this module only helps with the header or domain a deterministic pass
 * genuinely could not place: an unfamiliar synonym, a local abbreviation
 * this codebase has never seen. It never touches a canonical table and never
 * decides anything by itself: it only ever returns a *suggestion*, shaped
 * exactly like a deterministic one, which still goes through the same
 * human-reviewed staging pipeline as every other suggestion (a hit still
 * requires the reviewer's own "Stage this sheet" click, same as an alias
 * hit does today).
 *
 * Optional end to end, exactly like the existing decision-narration use of
 * this same gateway (see intelligence/decisions/decision.server.ts#narrate):
 * if NOVA_AI_API_KEY is not configured, the gateway errors, or its answer
 * doesn't parse to something valid, every function here returns `null` —
 * never fabricates a match, never throws, never blocks the deterministic
 * result already in hand.
 */
import { callAiGateway, parseAiJson } from "@/lib/ai-gateway.server";
import { CANONICAL_FIELDS, IMPORT_DOMAINS, type ImportDomain } from "./domains";

export interface AiDomainSuggestion {
  domain: ImportDomain;
  confidence: number;
  reason: string;
}

/**
 * Meant to be called only when the deterministic pass found no confident
 * domain for a sheet. Given the headers and a few sample rows, asks the
 * configured AI gateway to pick ONE domain from the fixed canonical list —
 * never an open-ended answer. Discarded unless the domain is literally one
 * of IMPORT_DOMAINS and confidence is a real number in [0,1]; anything else
 * (a non-JSON reply, a table name the AI invented) is treated exactly like
 * "no suggestion" rather than surfaced.
 */
export async function suggestDomainViaAi(
  headers: readonly string[],
  sampleRows: readonly Record<string, string>[],
): Promise<AiDomainSuggestion | null> {
  try {
    const { content } = await callAiGateway({
      jsonMode: true,
      system:
        "You classify one spreadsheet sheet from a restaurant/hospitality data import into exactly one of a fixed list of canonical domains, or none. " +
        `Respond with strict JSON only: {"domain": one of [${IMPORT_DOMAINS.join(", ")}] or null, "confidence": number 0-1, "reason": short string}. ` +
        "Never invent a domain name outside that list. If genuinely unsure, return domain: null.",
      user: JSON.stringify({ headers, sampleRows: sampleRows.slice(0, 3) }),
    });
    const parsed = parseAiJson<{ domain?: unknown; confidence?: unknown; reason?: unknown }>(
      content,
    );
    if (!parsed) return null;
    const domain = parsed.domain;
    if (typeof domain !== "string" || !(IMPORT_DOMAINS as readonly string[]).includes(domain))
      return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return {
      domain: domain as ImportDomain,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "AI-suggested",
    };
  } catch {
    return null;
  }
}

export interface AiFieldSuggestion {
  canonicalField: string;
  confidence: number;
}

/**
 * Meant to be called only for a header the deterministic alias pass left
 * unmapped. Restricted to the domain's own real canonical field list — an
 * answer naming a field this domain doesn't have is discarded exactly like
 * no answer at all, never coerced to the nearest real one.
 */
export async function suggestFieldViaAi(
  header: string,
  domain: ImportDomain,
  sampleValues: readonly string[],
): Promise<AiFieldSuggestion | null> {
  const fields = CANONICAL_FIELDS[domain];
  try {
    const { content } = await callAiGateway({
      jsonMode: true,
      system:
        `You map one spreadsheet column header to a canonical field for the "${domain}" import domain, or none. ` +
        `Valid fields: ${fields.map((f) => `${f.field} (${f.label})`).join(", ")}. ` +
        'Respond with strict JSON only: {"field": one of those field names or null, "confidence": number 0-1}. ' +
        "Never invent a field name outside that list. If genuinely unsure, return field: null.",
      user: JSON.stringify({ header, sampleValues: sampleValues.slice(0, 5) }),
    });
    const parsed = parseAiJson<{ field?: unknown; confidence?: unknown }>(content);
    if (!parsed) return null;
    const field = parsed.field;
    if (typeof field !== "string" || !fields.some((f) => f.field === field)) return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    return { canonicalField: field, confidence };
  } catch {
    return null;
  }
}
