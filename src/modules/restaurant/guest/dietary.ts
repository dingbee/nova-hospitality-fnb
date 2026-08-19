/**
 * Sprint 5.11 — guest dietary context. Pure, no I/O.
 *
 * Three distinct things that must never be conflated:
 *   PREFERENCE           — likes/dislikes. Advisory.
 *   DIETARY_REQUIREMENT  — vegetarian, vegan, halal. Firm but not medical.
 *   ALLERGY              — safety critical. Requires verification, never a guarantee.
 */

export const GUEST_CONTEXT_KINDS = ["preference", "dietary_requirement", "allergy"] as const;
export type GuestContextKind = (typeof GUEST_CONTEXT_KINDS)[number];

export const GUEST_CONTEXT_STATES = ["observed", "confirmed", "recurring"] as const;
export type GuestContextState = (typeof GUEST_CONTEXT_STATES)[number];

export interface GuestDietaryEntry {
  id?: string;
  guestId: string;
  kind: GuestContextKind;
  /** e.g. "vegetarian", "gluten", "onion", "spicy". */
  key: string;
  value: string;
  state: GuestContextState;
  confidence: number | null;
  severity: string | null;
  source: string;
  observedCount: number;
}

/** Dietary requirements that exclude whole classes of ingredients. */
export const DIET_EXCLUSIONS: Record<string, string[]> = {
  vegetarian: ["meat", "poultry", "beef", "pork", "chicken", "lamb", "fish", "seafood", "prawn", "shrimp"],
  vegan: [
    "meat", "poultry", "beef", "pork", "chicken", "lamb", "fish", "seafood", "prawn", "shrimp",
    "milk", "dairy", "cheese", "butter", "cream", "egg", "eggs", "honey",
  ],
  pescatarian: ["meat", "poultry", "beef", "pork", "chicken", "lamb"],
  halal: ["pork", "bacon", "ham", "alcohol", "wine", "beer"],
  no_seafood: ["fish", "seafood", "prawn", "shrimp", "crab", "lobster", "squid", "octopus"],
};

const TOKEN = /[a-z]+/g;
const tokens = (s: string) => (s.toLowerCase().match(TOKEN) ?? []);

/** Does the item's text/tags conflict with a dietary requirement? */
export function conflictsWithDiet(
  requirementKey: string,
  item: { name: string; description?: string | null; tags?: string[] | null; ingredients?: string[] },
): string | null {
  const excluded = DIET_EXCLUSIONS[requirementKey];
  if (!excluded) return null;
  const tagged = (item.tags ?? []).map((t) => t.toLowerCase());
  if (tagged.includes(requirementKey)) return null; // explicitly certified for this diet
  const haystack = new Set([
    ...tokens(item.name),
    ...tokens(item.description ?? ""),
    ...tagged.flatMap(tokens),
    ...(item.ingredients ?? []).flatMap(tokens),
  ]);
  const hit = excluded.find((e) => haystack.has(e));
  return hit ?? null;
}

/**
 * Statement → structured context. Casual statements become *observed* entries
 * only; nothing here creates strategic memory.
 */
export interface ParsedStatement {
  kind: GuestContextKind;
  key: string;
  value: string;
  confidence: number;
}

const PATTERNS: Array<{ re: RegExp; make: (m: RegExpMatchArray) => ParsedStatement }> = [
  {
    re: /\bi(?:'m| am)\s+(?:a\s+)?(vegetarian|vegan|pescatarian)\b/i,
    make: (m) => ({
      kind: "dietary_requirement",
      key: (m[1] ?? "").toLowerCase(),
      value: (m[1] ?? "").toLowerCase(),
      confidence: 0.8,
    }),
  },
  {
    re: /\b(?:i(?:'m| am)\s+allergic to|allergy to)\s+([a-z ]+)/i,
    make: (m) => ({
      kind: "allergy",
      key: normaliseAllergen((m[1] ?? "").trim()),
      value: (m[1] ?? "").trim(),
      confidence: 0.9,
    }),
  },
  {
    re: /\bi\s+(?:don'?t|do not)\s+eat\s+([a-z ]+)/i,
    make: (m) => ({
      kind: "dietary_requirement",
      key: `no_${(m[1] ?? "").trim().replace(/\s+/g, "_")}`,
      value: (m[1] ?? "").trim(),
      confidence: 0.7,
    }),
  },
  {
    re: /\bi\s+(?:don'?t|do not)\s+like\s+([a-z ]+)/i,
    make: (m) => ({
      kind: "preference",
      key: `dislikes_${(m[1] ?? "").trim().replace(/\s+/g, "_")}`,
      value: (m[1] ?? "").trim(),
      confidence: 0.5,
    }),
  },
  {
    re: /\bi\s+prefer\s+([a-z ]+)/i,
    make: (m) => ({
      kind: "preference",
      key: `prefers_${(m[1] ?? "").trim().replace(/\s+/g, "_")}`,
      value: (m[1] ?? "").trim(),
      confidence: 0.5,
    }),
  },
];

function normaliseAllergen(raw: string): string {
  const t = raw.toLowerCase();
  if (t.includes("gluten") || t.includes("wheat")) return "gluten";
  if (t.includes("nut") && t.includes("pea")) return "peanuts";
  if (t.includes("nut")) return "nuts";
  if (t.includes("milk") || t.includes("dairy") || t.includes("lactose")) return "milk";
  if (t.includes("egg")) return "eggs";
  if (t.includes("fish")) return "fish";
  if (t.includes("shell") || t.includes("prawn") || t.includes("shrimp") || t.includes("crab")) return "crustaceans";
  if (t.includes("soy")) return "soy";
  if (t.includes("sesame")) return "sesame";
  return t.replace(/\s+/g, "_");
}

/** Returns null when nothing confident enough was said. */
export function parseGuestStatement(statement: string): ParsedStatement | null {
  const text = statement.trim();
  if (text.length < 4) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return p.make(m);
  }
  return null;
}

/** Repeated observation promotes state; a single casual remark never does. */
export function promoteState(current: GuestContextState, observedCount: number, confirmed: boolean): GuestContextState {
  if (confirmed) return observedCount >= 3 ? "recurring" : "confirmed";
  if (current === "recurring") return "recurring";
  if (observedCount >= 3) return "recurring";
  return current;
}

/** Memory tier the Intelligence Core should use for a guest statement. */
export function memoryTierFor(entry: Pick<GuestDietaryEntry, "state" | "kind">): "observed" | "learned" {
  return entry.state === "observed" ? "observed" : "learned";
}