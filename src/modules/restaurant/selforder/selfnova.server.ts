/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows / raw catalogue rows are untyped at this boundary. */
/**
 * Ask NOVA — a guest-facing menu-discovery assistant, reusing the exact
 * same guest-authorization boundary (resolveGuestTableContext, via
 * guestMenu) and the exact same sellable catalogue (fetchSellableCatalog)
 * the self-order screen and the POS already use. No second AI transport is
 * created here — this calls the one existing callAiGateway() the
 * Intelligence module's decision narration already uses (see
 * ../intelligence/decisions/decision.server.ts's narrate()), the same
 * try/catch-and-degrade pattern too.
 *
 * The one thing this module exists to guarantee: the model's own words are
 * never trusted as fact. Its structured JSON output is validated
 * (selforder-asknova.ts's validateNovaResponse) against the real catalogue
 * before anything reaches the guest, and every recommended item's name/
 * price/currency shown back is re-read from the catalogue itself — never
 * from whatever the model said about it.
 */
import { guestMenu } from "./selforder.server";
import {
  buildNovaCatalogContext,
  validateNovaResponse,
  type NovaCatalogItem,
} from "./selforder-asknova";

type Sb = any;

type AiTurn = { role: "user" | "assistant"; content: string };
type AiCallOptions = { system: string; user: string; history?: AiTurn[]; jsonMode?: boolean };
type AiCaller = (opts: AiCallOptions) => Promise<{ content: string }>;

/** The real transport, loaded lazily so a test can inject a fake one instead — same DI shape selfpay.server.ts already uses for its payment provider. */
async function defaultAiCaller(opts: AiCallOptions): Promise<{ content: string }> {
  const { callAiGateway } = await import("@/lib/ai-gateway.server");
  return callAiGateway(opts);
}

const NOVA_SYSTEM_PROMPT = `You are NOVA, a friendly restaurant ordering assistant helping a guest at their table decide what to order.

RULES — these must never be broken:
- You may ONLY recommend, describe or price items that appear in the MENU JSON below. Never invent a dish, price, ingredient, modifier or promotion, and never claim an item is available if it isn't in the MENU JSON.
- The "tags" and "allergens" fields are the ONLY dietary/allergen facts you know for each item. If a guest asks about diet or allergies and the relevant item has no tags/allergens listed, say plainly that you don't have reliable information for that item and suggest they ask a member of staff — never guess or infer.
- Keep replies short (2-4 sentences), warm, and focused on helping the guest choose.
- Respond with ONLY a JSON object: {"reply": string, "recommendedItemIds": string[]}. recommendedItemIds must only contain "id" values copied exactly from the MENU JSON items you are recommending in this reply — omit it or leave it empty if you aren't recommending specific items yet (e.g. you're asking a clarifying question).

MENU JSON:
`;

/** Menu-item rows -> the compact shape the model (and the pure grounding builder) work with. Raw-row mapping stays here; the transform itself is pure and tested separately. */
function toNovaCatalogItem(row: any, modifierGroupNameById: Map<string, string>): NovaCatalogItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    price: Number(row.price),
    currency: row.currency,
    categoryId: row.category_id ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    allergens: Array.isArray(row.allergens) ? row.allergens : [],
    variants: ((row.variants ?? []) as any[]).map((v) => ({
      name: v.name,
      priceDelta: Number(v.price),
    })),
    modifierGroupNames: ((row.modifier_group_ids ?? []) as string[])
      .map((id) => modifierGroupNameById.get(id))
      .filter((n): n is string => Boolean(n)),
  };
}

export type AskNovaRecommendedItem = {
  id: string;
  name: string;
  price: number;
  currency: string;
  categoryId: string | null;
};

export type AskNovaResult =
  | { ok: true; reply: string; recommendedItems: AskNovaRecommendedItem[] }
  | { ok: false; reason: "ai_unavailable"; categories: { id: string; name: string }[] };

export async function askNova(
  sb: Sb,
  input: { tableId: string; message: string; history?: AiTurn[] },
  aiCaller: AiCaller = defaultAiCaller,
): Promise<AskNovaResult> {
  // The one and only source of what NOVA is allowed to know — the same
  // guest-authorization boundary and the same sellable catalogue every
  // other guest surface in this module reads.
  const menu = await guestMenu(sb, input.tableId);

  const categories = ((menu.categories ?? []) as any[]).map((c) => ({ id: c.id, name: c.name }));
  const modifierGroupNameById = new Map(
    ((menu.modifierGroups ?? []) as any[]).map((g) => [g.id, g.name]),
  );
  const novaItems = ((menu.items ?? []) as any[]).map((i) =>
    toNovaCatalogItem(i, modifierGroupNameById),
  );
  const itemById = new Map(novaItems.map((i) => [i.id, i]));

  let validated: ReturnType<typeof validateNovaResponse> = null;
  try {
    const context = buildNovaCatalogContext({ items: novaItems, categories });
    const { content } = await aiCaller({
      system: NOVA_SYSTEM_PROMPT + JSON.stringify(context),
      user: input.message,
      history: (input.history ?? []).slice(-6),
      jsonMode: true,
    });
    const { parseAiJson } = await import("@/lib/ai-gateway.server");
    validated = validateNovaResponse(parseAiJson(content), new Set(itemById.keys()));
  } catch {
    // AI not configured, network failure, rate limit, malformed response —
    // all degrade the same way: a graceful fallback, never a technical
    // error, and never a reply presented as if NOVA answered.
    validated = null;
  }

  if (!validated) {
    return { ok: false, reason: "ai_unavailable", categories };
  }

  const recommendedItems: AskNovaRecommendedItem[] = validated.recommendedItemIds
    .map((id) => itemById.get(id))
    .filter((i): i is NovaCatalogItem => Boolean(i))
    .map((i) => ({
      id: i.id,
      name: i.name,
      price: i.price,
      currency: i.currency,
      categoryId: i.categoryId,
    }));

  return { ok: true, reply: validated.reply, recommendedItems };
}
