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
  resolveNovaOperations,
  validateNovaResponse,
  type NovaBasketLine,
  type NovaCatalogItem,
  type NovaResolvableItem,
  type NovaResolvableModifierGroup,
  type ResolvedNovaOperation,
} from "./selforder-asknova";

type Sb = any;

type AiTurn = { role: "user" | "assistant"; content: string };
type AiCallOptions = { system: string; user: string; history?: AiTurn[]; jsonMode?: boolean };
type AiCaller = (opts: AiCallOptions) => Promise<{ content: string }>;

/**
 * The real transport, loaded lazily so a test can inject a fake one instead
 * — same DI shape selfpay.server.ts already uses for its payment provider.
 *
 * Corrective pass: this used to call ai-gateway.server.ts directly, which
 * defaults to the OpenAI Chat Completions endpoint — but the model this
 * deployment configures is Responses-API-only (the same reason INT-01
 * built reasoning-provider.server.ts's explicit "responses" routing for
 * Menu Intelligence in the first place). Guest Ask NOVA now goes through
 * that same, already-proven-working provider abstraction instead of a
 * second, silently-incompatible path — the AiCaller interface (and every
 * caller of it) is unchanged.
 */
async function defaultAiCaller(opts: AiCallOptions): Promise<{ content: string }> {
  const { callReasoningProvider } = await import("@/lib/reasoning-provider.server");
  const result = await callReasoningProvider("openai", opts);
  if (result.unavailable) throw new Error(result.reason);
  return { content: result.content };
}

const NOVA_SYSTEM_PROMPT = `You are NOVA, a friendly restaurant ordering assistant helping a guest at their table decide what to order and, when they ask, preparing a proposed order for them to review.

RULES — these must never be broken:
- You may ONLY recommend, describe or price items that appear in the MENU JSON below. Never invent a dish, price, ingredient, modifier or promotion, and never claim an item is available if it isn't in the MENU JSON.
- The "tags" and "allergens" fields are the ONLY dietary/allergen facts you know for each item. If a guest asks about diet or allergies and the relevant item has no tags/allergens listed, say plainly that you don't have reliable information for that item and suggest they ask a member of staff — never guess or infer.
- Keep replies short (2-4 sentences), warm, and focused on helping the guest choose. Never use technical words like "id", "operation", "payload" or "tool call" — speak like restaurant staff, not a developer.
- You are PREPARING a proposed order for the guest to review, never placing a real order — never say the order has been "placed", "sent" or "confirmed"; say you've "prepared" or "added" it, and that it's ready for the guest's review.
- CURRENT BASKET JSON below lists what the guest already has prepared. "Add another one", "make that two", "remove the drink" etc. refer to that basket — resolve them against it.
- If the guest's request could match more than one real menu item (e.g. two different colas), do NOT guess — ask which one they mean in your reply and leave "operations" empty.
- If the guest confirms a dish you recommended earlier in this conversation ("yes", "please", "sounds good"), look up the matching item by name in MENU JSON and add it.
- Respond with ONLY a JSON object: {"reply": string, "recommendedItemIds": string[], "operations": [{"action": "add"|"remove"|"set_quantity", "itemId": string, "quantity"?: number, "modifierNames"?: string[]}]}.
  - "recommendedItemIds" must only contain "id" values copied exactly from MENU JSON items you are recommending — omit or leave empty otherwise.
  - "operations" describes basket changes the guest actually asked you to make right now — omit or leave empty when you are only discussing/recommending, not adding or changing anything. "itemId" must be copied exactly from MENU JSON. "remove"/"set_quantity" must reference an item already in CURRENT BASKET JSON. "modifierNames" (for "add") must be copied exactly from that item's real modifier options in MENU JSON — never invent one.

CURRENT BASKET JSON:
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
  | {
      ok: true;
      reply: string;
      recommendedItems: AskNovaRecommendedItem[];
      /** GEP2 — basket changes NOVA proposed and the server actually resolved against the real catalogue/basket. Never applied server-side; the caller applies only the "applied" ones to its own basket. */
      operations: ResolvedNovaOperation[];
    }
  | { ok: false; reason: "ai_unavailable"; categories: { id: string; name: string }[] };

export async function askNova(
  sb: Sb,
  input: {
    tableId: string;
    message: string;
    history?: AiTurn[];
    /** GEP2 — the guest's current basket (menuItemId + quantity only), a hint for resolving "remove"/"another one"/"make that two" references. Never trusted for price or identity. */
    basket?: NovaBasketLine[];
  },
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

  // The same raw catalogue rows, projected for resolveNovaOperations
  // instead of for the model's prompt — availability/price-configured/
  // modifier-group membership never reaches the model as fields to
  // reason over, but the server still needs them to validate any
  // operation the model proposes.
  const resolvableItems: NovaResolvableItem[] = ((menu.items ?? []) as any[]).map((i) => ({
    id: i.id,
    name: i.name,
    available: i.available !== false,
    priceConfigured: i.priceConfigured !== false,
    modifierGroupIds: Array.isArray(i.modifier_group_ids) ? i.modifier_group_ids : [],
  }));
  const resolvableGroups: NovaResolvableModifierGroup[] = (
    (menu.modifierGroups ?? []) as any[]
  ).map((g) => ({
    id: g.id,
    name: g.name,
    required: Boolean(g.required),
    minSelect: Number(g.min_select ?? 0),
    modifiers: ((g.modifiers ?? []) as any[]).map((m) => ({ name: m.name })),
  }));
  const basket: NovaBasketLine[] = (input.basket ?? []).map((l) => ({
    menuItemId: l.menuItemId,
    quantity: l.quantity,
  }));

  let validated: ReturnType<typeof validateNovaResponse> = null;
  let rawOperations: unknown = [];
  try {
    const context = buildNovaCatalogContext({ items: novaItems, categories });
    const { content } = await aiCaller({
      system:
        NOVA_SYSTEM_PROMPT + JSON.stringify(basket) + "\n\nMENU JSON:\n" + JSON.stringify(context),
      user: input.message,
      history: (input.history ?? []).slice(-6),
      jsonMode: true,
    });
    const { parseAiJson } = await import("@/lib/ai-gateway.server");
    const parsed = parseAiJson<{ operations?: unknown }>(content);
    validated = validateNovaResponse(parsed, new Set(itemById.keys()));
    rawOperations = parsed && typeof parsed === "object" ? (parsed as any).operations : [];
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

  const operations = resolveNovaOperations(
    rawOperations,
    { items: resolvableItems, modifierGroups: resolvableGroups },
    basket,
  );

  return { ok: true, reply: validated.reply, recommendedItems, operations };
}
