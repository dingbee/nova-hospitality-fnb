/**
 * Pure, client-side guest menu search — extracted out of the
 * order.$tableId.tsx route so it's directly testable without rendering
 * React (this repo has no component-render test setup), matching the
 * selforder-cart.ts pattern.
 *
 * Deterministic, not "AI"/semantic: guestMenuFn already returns the whole
 * published, available, tenant/table-scoped catalogue in one query (see
 * selforder.server.ts's guestMenu), so search is a pure ranked filter over
 * data the route already fetched — no second network call per keystroke, no
 * second catalogue, no cross-tenant risk (there is nothing here that can
 * see another tenant's items; it only ever ranks the array it is given).
 */

export type SearchableMenuItem = {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  tags?: string[];
};

/** Lower is a stronger match. Items that match nothing are excluded entirely. */
const MatchTier = {
  ExactName: 0,
  NamePrefix: 1,
  NameContains: 2,
  Category: 3,
  Description: 4,
  Tag: 5,
  Fuzzy: 6,
} as const;
type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Classic Levenshtein edit distance, bounded to short strings only (menu
 * item names/words) — this runs per keystroke over up to a few hundred
 * items, so it stays a small O(n*m) DP over short tokens, not a general
 * string-similarity service.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j += 1) prev[j] = j;
  for (let i = 1; i <= al; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/** How many typos a token of this length can tolerate before it stops meaning the same word. */
function fuzzyThreshold(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  return 2;
}

/** True when any token of `haystack` is within a sensible edit distance of `query`. */
function fuzzyWordMatch(haystack: string, query: string): boolean {
  const threshold = fuzzyThreshold(query.length);
  if (threshold === 0) return false;
  for (const word of haystack.split(/\s+/)) {
    if (!word) continue;
    // Bound the comparison to tokens of a plausible length — comparing a
    // 4-letter query against a 40-letter word is never a typo relationship.
    if (Math.abs(word.length - query.length) > threshold) continue;
    if (editDistance(word, query) <= threshold) return true;
  }
  return false;
}

function bestTierForItem(
  item: SearchableMenuItem,
  query: string,
  categoryNameById: ReadonlyMap<string, string>,
): MatchTier | null {
  const name = normalize(item.name);
  if (name === query) return MatchTier.ExactName;
  if (name.startsWith(query)) return MatchTier.NamePrefix;
  if (name.includes(query)) return MatchTier.NameContains;

  const categoryName = item.category_id ? categoryNameById.get(item.category_id) : undefined;
  if (categoryName && normalize(categoryName).includes(query)) return MatchTier.Category;

  if (item.description && normalize(item.description).includes(query)) return MatchTier.Description;

  if ((item.tags ?? []).some((t) => normalize(t).includes(query))) return MatchTier.Tag;

  if (fuzzyWordMatch(name, query)) return MatchTier.Fuzzy;
  if (categoryName && fuzzyWordMatch(normalize(categoryName), query)) return MatchTier.Fuzzy;

  return null;
}

/**
 * Ranks `items` against `query`. An empty/whitespace query returns `items`
 * unchanged, in their original (already sort_order-sorted) order — "no
 * search active" is the normal browsing experience, not a zero-result
 * search. A non-empty query returns only items that match at some tier,
 * ordered by tier (exact name > name prefix/partial > category >
 * description > tag > fuzzy typo-tolerance), with original catalogue order
 * as the stable tiebreak within a tier.
 */
export function searchMenuItems<T extends SearchableMenuItem>(
  items: readonly T[],
  query: string,
  categoryNameById: ReadonlyMap<string, string>,
): T[] {
  const q = normalize(query);
  if (!q) return [...items];

  const scored: { item: T; tier: MatchTier; index: number }[] = [];
  items.forEach((item, index) => {
    const tier = bestTierForItem(item, q, categoryNameById);
    if (tier !== null) scored.push({ item, tier, index });
  });

  scored.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return scored.map((s) => s.item);
}
