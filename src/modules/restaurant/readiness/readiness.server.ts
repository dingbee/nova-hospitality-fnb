/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P13 — Configuration & Readiness Centre. The canonical readiness engine.
 *
 * This is the "Final Readiness Check" made real: one function that reads the
 * same authoritative tables every domain's own admin screen reads (via the
 * same tenant-scoped, capability-gated pattern as `masterdata.server.ts`'s
 * `listAllMasterData` and `pricing/readiness.server.ts`'s `pricingReadiness`),
 * and reports what's blocking go-live in plain operational language.
 *
 * It never writes application data and never invents a default — an
 * unconfigured domain is reported unconfigured, exactly like the pricing
 * readiness audit this module borrows its shape from. The one write this
 * module performs (`confirmGoLive`) is a deliberate, audited, owner-only
 * action — never an automatic inference from configuration rows existing.
 */
import { assertCapability, assertTenantRead, getTenantScope } from "../core/access.server";
import { pricingReadiness } from "../pricing/readiness.server";
import type {
  GoLiveState,
  ReadinessDomain,
  ReadinessItem,
  ReadinessReport,
  ReadinessSeverity,
  ReadinessStatus,
} from "./contracts";

type Sb = any;

const SEVERITY_WEIGHT: Record<ReadinessSeverity, number> = {
  CRITICAL: 5,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  OPTIONAL: 0,
};

function item(
  partial: Omit<ReadinessItem, "blockedByDependency"> & { blockedByDependency?: boolean },
): ReadinessItem {
  return { blockedByDependency: false, ...partial };
}

export async function computeReadiness(
  sb: Sb,
  userId: string,
  tenantId: string,
): Promise<ReadinessReport> {
  await assertTenantRead(sb, userId, tenantId);
  const scope = await getTenantScope(sb, userId, tenantId);

  const [
    { data: tenantRow },
    { data: properties },
    { data: locations },
    { data: members },
    { data: menus },
    { data: menuItems },
    { data: products },
    { data: taxRules },
    { data: units },
    { data: inventoryItems },
    { data: suppliers },
    { data: stations },
    { data: tables },
    { data: servicePeriods },
    { data: testOrders },
  ] = await Promise.all([
    sb.from("restaurant_tenants").select("id, name, settings").eq("id", tenantId).single(),
    sb.from("restaurant_properties").select("id, name").eq("tenant_id", tenantId),
    sb.from("restaurant_locations").select("id, name, is_storage").eq("tenant_id", tenantId),
    sb.from("restaurant_members").select("id, role").eq("tenant_id", tenantId),
    sb.from("restaurant_menus").select("id, status").eq("tenant_id", tenantId),
    sb
      .from("restaurant_menu_items")
      .select("id, menu_id, available, archived_at")
      .eq("tenant_id", tenantId)
      .eq("available", true)
      .is("archived_at", null),
    sb.from("restaurant_products").select("id, active, recipe_id").eq("tenant_id", tenantId),
    sb.from("restaurant_tax_rules").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_inventory_units").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_inventory_items").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_suppliers").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_stations").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_tables").select("id").eq("tenant_id", tenantId),
    sb.from("restaurant_service_periods").select("id").eq("tenant_id", tenantId),
    sb
      .from("restaurant_orders")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("payment_state", "paid")
      .limit(1),
  ]);

  const tenant = tenantRow as {
    id: string;
    name: string | null;
    settings: Record<string, any>;
  } | null;
  const settings = (tenant?.settings ?? {}) as Record<string, any>;
  const business = (settings.business ?? {}) as Record<string, any>;
  const onboarding = (settings.onboarding ?? {}) as Record<string, any>;
  const readinessSettings = (settings.readiness ?? {}) as Record<string, any>;

  const propRows = (properties ?? []) as any[];
  const locRows = (locations ?? []) as any[];
  const outlets = locRows.filter((l) => !l.is_storage);
  const stores = locRows.filter((l) => l.is_storage);
  const memberRows = (members ?? []) as any[];
  const publishedMenus = (menus ?? []).filter((m: any) => m.status === "published");
  const menuItemRows = (menuItems ?? []) as any[];
  const productRows = (products ?? []) as any[];
  const activeProducts = productRows.filter((p) => p.active);
  const productsWithRecipe = activeProducts.filter((p) => p.recipe_id);
  const operatingMode = onboarding.operatingMode ?? null;
  const isTakeawayOnly = operatingMode === "takeaway" || operatingMode === "quick_service";
  const requiresFiscalisation = String(onboarding.country ?? "").toLowerCase() === "tanzania";

  const items: ReadinessItem[] = [];

  // 1. Business
  items.push(
    item({
      domain: "business",
      status: tenant?.name ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Business",
      explanation: "Every screen in LexiBite is scoped to your business identity.",
      requirement: "Name your business.",
      currentState: tenant?.name ? `${tenant.name}` : "No business name set.",
      blocker: tenant?.name ? null : "Your business doesn't have a name yet.",
      fixAction: { label: "Set up your business", to: "/admin/restaurant/setup/foundation" },
      dependsOn: [],
    }),
  );

  // 2. Property
  items.push(
    item({
      domain: "property",
      status: propRows.length > 0 ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Property",
      explanation:
        "A property is the site your restaurant runs from — currency and timezone live here.",
      requirement: "At least one property.",
      currentState: `${propRows.length} propert${propRows.length === 1 ? "y" : "ies"} set up.`,
      blocker: propRows.length > 0 ? null : "No property has been created yet.",
      fixAction: { label: "Add a property", to: "/admin/restaurant/setup/foundation" },
      dependsOn: ["business"],
      blockedByDependency: propRows.length === 0 && !tenant?.name,
    }),
  );

  // 3. Outlet
  items.push(
    item({
      domain: "outlet",
      status: outlets.length > 0 ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Outlet",
      explanation: "Where guests are actually served — orders, tables and staff are managed here.",
      requirement: "At least one outlet (restaurant, bar, room service).",
      currentState: `${outlets.length} outlet${outlets.length === 1 ? "" : "s"} set up.`,
      blocker: outlets.length > 0 ? null : "No outlet has been created yet.",
      fixAction: { label: "Add an outlet", to: "/admin/restaurant/setup/foundation" },
      dependsOn: ["property"],
      blockedByDependency: outlets.length === 0 && propRows.length === 0,
    }),
  );

  // 4. Staff & Roles — the owner always counts; more staff is a nudge, never a blocker.
  const staffStatus: ReadinessStatus = memberRows.length > 1 ? "COMPLETE" : "WARNING";
  items.push(
    item({
      domain: "staff",
      status: staffStatus,
      severity: "LOW",
      title: "Staff & roles",
      explanation:
        "Give your team the right access — a chef doesn't need purchasing approval, a cashier doesn't need payroll.",
      requirement: "Add staff and assign roles as your team grows.",
      currentState: `${memberRows.length} team member${memberRows.length === 1 ? "" : "s"} with access.`,
      blocker:
        staffStatus === "WARNING"
          ? "Only the owner has access so far — this is fine to start, but add staff before you need shift coverage."
          : null,
      fixAction: { label: "Manage staff", to: "/admin/restaurant/staff" },
      dependsOn: ["business"],
    }),
  );

  // 5. Operating Model
  items.push(
    item({
      domain: "operating_model",
      status: operatingMode ? "COMPLETE" : "BLOCKED",
      severity: "HIGH",
      title: "Operating model",
      explanation:
        "How you serve guests shapes which setup steps matter next — table service needs tables, takeaway doesn't.",
      requirement: "Choose how you serve guests.",
      currentState: operatingMode ? String(operatingMode).replace(/_/g, " ") : "Not selected.",
      blocker: operatingMode ? null : "No operating model has been selected yet.",
      fixAction: { label: "Choose your operating model", to: "/onboarding" },
      dependsOn: ["outlet"],
      blockedByDependency: !operatingMode && outlets.length === 0,
    }),
  );

  // 6. Menu
  const menuHasAvailableItems = menuItemRows.some((mi) =>
    publishedMenus.some((m: any) => m.id === mi.menu_id),
  );
  items.push(
    item({
      domain: "menu",
      status: publishedMenus.length > 0 && menuHasAvailableItems ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Menu",
      explanation:
        "Guests order from what's on a published menu — nothing else shows up on the POS or guest ordering.",
      requirement: "A published menu with at least one available item.",
      currentState:
        publishedMenus.length === 0
          ? "No published menu."
          : `${publishedMenus.length} published menu${publishedMenus.length === 1 ? "" : "s"}, ${menuItemRows.length} available item${menuItemRows.length === 1 ? "" : "s"}.`,
      blocker:
        publishedMenus.length === 0
          ? "You haven't published a menu yet."
          : !menuHasAvailableItems
            ? "Your published menu has no available items."
            : null,
      fixAction: { label: "Build your menu", to: "/admin/restaurant/menu" },
      dependsOn: ["outlet", "operating_model"],
      blockedByDependency: publishedMenus.length === 0 && (outlets.length === 0 || !operatingMode),
    }),
  );

  // 7. Products
  items.push(
    item({
      domain: "products",
      status: activeProducts.length > 0 ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Products",
      explanation:
        "Products are what menu items are actually made of — they drive recipes, costing and stock deduction.",
      requirement: "At least one active product.",
      currentState: `${activeProducts.length} active product${activeProducts.length === 1 ? "" : "s"}.`,
      blocker: activeProducts.length > 0 ? null : "No products have been created yet.",
      fixAction: { label: "Add products", to: "/admin/restaurant/products" },
      dependsOn: ["outlet"],
    }),
  );

  // 8. Recipes & Costing
  const costingBlocked = activeProducts.length > 0 && productsWithRecipe.length === 0;
  items.push(
    item({
      domain: "recipes_costing",
      status:
        activeProducts.length === 0
          ? "BLOCKED"
          : productsWithRecipe.length > 0
            ? "COMPLETE"
            : "BLOCKED",
      severity: "HIGH",
      title: "Recipes & costing",
      explanation:
        "A recipe tells LexiBite exactly what a dish costs to make and what stock to deduct when it sells.",
      requirement: "Products have recipes with costed ingredients.",
      currentState:
        activeProducts.length === 0
          ? "No products to attach a recipe to yet."
          : `${productsWithRecipe.length} of ${activeProducts.length} products have a recipe.`,
      blocker:
        activeProducts.length === 0
          ? null
          : costingBlocked
            ? "None of your products have a recipe yet, so cost and stock deduction can't be calculated."
            : null,
      fixAction: { label: "Add recipes", to: "/admin/restaurant/recipe-master" },
      dependsOn: ["products"],
      blockedByDependency: activeProducts.length === 0,
    }),
  );

  // 9. Pricing — reuse the real POS pricing engine, never re-derive it.
  const pricing = await pricingReadiness(sb, userId, { tenantId });
  items.push(
    item({
      domain: "pricing",
      status: pricing.total === 0 ? "BLOCKED" : pricing.blocked === 0 ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Pricing",
      explanation:
        "The POS resolves a real price from your pricing rules — a menu item without one can't be sold.",
      requirement: "Every available menu item resolves to a price.",
      currentState:
        pricing.total === 0
          ? "No sellable menu items to price yet."
          : `${pricing.ready} of ${pricing.total} menu items are priced.`,
      blocker:
        pricing.total === 0
          ? null
          : pricing.blocked > 0
            ? `${pricing.blocked} menu item${pricing.blocked === 1 ? "" : "s"} can't be sold — no price resolves.`
            : null,
      fixAction: { label: "Set prices", to: "/admin/restaurant/pricing" },
      dependsOn: ["menu", "products"],
      blockedByDependency: pricing.total === 0,
    }),
  );

  // 10. Tax
  const taxCount = (taxRules ?? []).length;
  items.push(
    item({
      domain: "tax",
      status: taxCount > 0 ? "COMPLETE" : "BLOCKED",
      severity: "HIGH",
      title: "Tax",
      explanation:
        "Tax rules apply automatically at checkout — getting this wrong is a compliance risk, not just a rounding detail.",
      requirement: "At least one tax rule configured.",
      currentState: `${taxCount} tax rule${taxCount === 1 ? "" : "s"} configured.`,
      blocker: taxCount > 0 ? null : "No tax rules have been configured yet.",
      fixAction: { label: "Configure tax", to: "/admin/restaurant/pricing" },
      dependsOn: ["pricing"],
    }),
  );

  // 11. Payments — cash always works; mobile money is a warning, not a blocker, until configured badly.
  // A direct read of the account table (not a live provider health check —
  // that's a heavier, network-dependent concern this report shouldn't pay
  // for on every load; the dedicated Payments screen already does that).
  const { data: mmAccounts } = await sb
    .from("restaurant_mobile_money_accounts")
    .select("id, activation_state")
    .eq("tenant_id", tenantId);
  const activeMmAccount = ((mmAccounts ?? []) as any[]).find(
    (a) => a.activation_state === "active",
  );
  let paymentsStatus: ReadinessStatus = "WARNING";
  let paymentsBlocker: string | null =
    "No mobile money account is configured yet — cash payments still work.";
  if ((mmAccounts ?? []).length > 0) {
    paymentsStatus = activeMmAccount ? "COMPLETE" : "BLOCKED";
    paymentsBlocker = activeMmAccount
      ? null
      : "A mobile money account exists but isn't active yet.";
  }
  items.push(
    item({
      domain: "payments",
      status: paymentsStatus,
      severity: "HIGH",
      title: "Payments",
      explanation:
        "Guests should be able to pay the way they expect — cash always works; mobile money needs setup.",
      requirement: "Cash is always available; mobile money is optional but recommended.",
      currentState:
        paymentsStatus === "WARNING"
          ? "Cash only."
          : paymentsStatus === "COMPLETE"
            ? "Mobile money connected and healthy."
            : "Mobile money configured but unhealthy.",
      blocker: paymentsBlocker,
      fixAction: { label: "Set up payments", to: "/admin/restaurant/payments" },
      dependsOn: ["business"],
    }),
  );

  // 12. Inventory
  const inventoryReady =
    (units ?? []).length > 0 && (inventoryItems ?? []).length > 0 && stores.length > 0;
  items.push(
    item({
      domain: "inventory",
      status: inventoryReady ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Inventory",
      explanation:
        "Recipes deduct stock automatically — without units, stock items and a store, that can't happen.",
      requirement: "Units of measure, stock items, and at least one store.",
      currentState: `${(units ?? []).length} units, ${(inventoryItems ?? []).length} stock items, ${stores.length} store${stores.length === 1 ? "" : "s"}.`,
      blocker: inventoryReady
        ? null
        : "Inventory basics (units, stock items, or a store) are incomplete.",
      fixAction: { label: "Set up inventory", to: "/admin/restaurant/setup/foundation" },
      dependsOn: ["outlet"],
    }),
  );

  // 13. Suppliers & Purchasing
  const supplierCount = (suppliers ?? []).length;
  items.push(
    item({
      domain: "suppliers_purchasing",
      status: supplierCount > 0 ? "COMPLETE" : "WARNING",
      severity: "MEDIUM",
      title: "Suppliers & purchasing",
      explanation: "You'll need suppliers on file before you can raise a purchase order.",
      requirement: "At least one supplier.",
      currentState: `${supplierCount} supplier${supplierCount === 1 ? "" : "s"} on file.`,
      blocker:
        supplierCount > 0
          ? null
          : "No suppliers have been added yet — you can still open, but purchasing won't work.",
      fixAction: { label: "Add suppliers", to: "/admin/restaurant/suppliers" },
      dependsOn: ["inventory"],
    }),
  );

  // 14. Kitchen & Bar
  const stationCount = (stations ?? []).length;
  items.push(
    item({
      domain: "kitchen_bar",
      status: stationCount > 0 ? "COMPLETE" : "WARNING",
      severity: "LOW",
      title: "Kitchen & bar",
      explanation:
        "Stations route tickets to the right screen — the kitchen display, the bar, and so on.",
      requirement: "At least one station, if you run a kitchen display.",
      currentState: `${stationCount} station${stationCount === 1 ? "" : "s"} configured.`,
      blocker: stationCount > 0 ? null : "No kitchen or bar stations are set up yet.",
      fixAction: { label: "Set up stations", to: "/admin/restaurant/kitchen" },
      dependsOn: ["outlet"],
    }),
  );

  // 15. Tables & Service — not applicable to takeaway-only concepts.
  const tableCount = (tables ?? []).length;
  const tablesStatus: ReadinessStatus = isTakeawayOnly
    ? "NOT_APPLICABLE"
    : tableCount > 0
      ? "COMPLETE"
      : "WARNING";
  items.push(
    item({
      domain: "tables_service",
      status: tablesStatus,
      severity: isTakeawayOnly ? "OPTIONAL" : "MEDIUM",
      title: "Tables & service",
      explanation: "Your floor plan and service periods drive the POS table view and reporting.",
      requirement: "A table plan, unless you're takeaway-only.",
      currentState: isTakeawayOnly
        ? "Not needed — takeaway/quick-service."
        : `${tableCount} table${tableCount === 1 ? "" : "s"}, ${(servicePeriods ?? []).length} service period${(servicePeriods ?? []).length === 1 ? "" : "s"}.`,
      blocker: tablesStatus === "WARNING" ? "No tables have been set up yet." : null,
      fixAction: isTakeawayOnly
        ? null
        : { label: "Set up tables", to: "/admin/restaurant/setup/foundation" },
      dependsOn: ["operating_model"],
    }),
  );

  // 16. Guest Ordering — always optional, never blocks go-live.
  items.push(
    item({
      domain: "guest_ordering",
      status: "OPTIONAL",
      severity: "OPTIONAL",
      title: "Guest ordering",
      explanation: "QR ordering lets guests browse and order from their table — entirely optional.",
      requirement: "Nothing required — enable it when you're ready.",
      currentState: "Available whenever you want to turn it on.",
      blocker: null,
      fixAction: { label: "Explore guest ordering", to: "/admin/restaurant/orders" },
      dependsOn: ["menu", "tables_service"],
    }),
  );

  // 17. Fiscalisation — Tanzania-specific requirement (TRA), not applicable elsewhere.
  let fiscalStatus: ReadinessStatus = "NOT_APPLICABLE";
  let fiscalCurrent = "Not required for your market.";
  let fiscalBlocker: string | null = null;
  if (requiresFiscalisation) {
    // Direct row read — the live TRA registration/token check lives on the
    // Fiscal Centre screen; this report only asks "is a device on file".
    const { data: fiscalConfigs } = await sb
      .from("restaurant_fiscal_configurations")
      .select("id")
      .eq("tenant_id", tenantId);
    const configIds = ((fiscalConfigs ?? []) as any[]).map((c) => c.id);
    const { data: fiscalDevices } = configIds.length
      ? await sb
          .from("restaurant_fiscal_devices")
          .select("registration_info")
          .eq("tenant_id", tenantId)
          .in("fiscal_configuration_id", configIds)
      : { data: [] as any[] };
    const registered = ((fiscalDevices ?? []) as any[]).some(
      (d) => (d.registration_info as Record<string, unknown> | null)?.regId,
    );
    fiscalStatus = registered ? "COMPLETE" : "BLOCKED";
    fiscalCurrent = registered ? "Fiscal device registered." : "No fiscal device registered.";
    fiscalBlocker = registered
      ? null
      : "Tanzania requires TRA fiscalisation before you can issue receipts.";
  }
  items.push(
    item({
      domain: "fiscalisation",
      status: fiscalStatus,
      severity: requiresFiscalisation ? "CRITICAL" : "OPTIONAL",
      title: "Fiscalisation",
      explanation:
        "Tanzania requires every receipt to be reported to the TRA through a registered fiscal device.",
      requirement: requiresFiscalisation
        ? "A registered, active fiscal device."
        : "Not required for your market.",
      currentState: fiscalCurrent,
      blocker: fiscalBlocker,
      fixAction: requiresFiscalisation
        ? { label: "Set up fiscalisation", to: "/admin/restaurant/fiscal" }
        : null,
      dependsOn: ["payments"],
    }),
  );

  const criticalBlockers = items.filter(
    (i) => i.status === "BLOCKED" && i.severity === "CRITICAL",
  ).length;
  const highBlockers = items.filter((i) => i.status === "BLOCKED" && i.severity === "HIGH").length;
  const warnings = items.filter((i) => i.status === "WARNING").length;
  const hasRecordedTestSale = ((testOrders ?? []) as any[]).length > 0;

  // 18. Final Readiness Check — the rollup itself, expressed as one more item
  // so the UI can render it uniformly with the other 17.
  const finalOk = criticalBlockers === 0;
  items.push(
    item({
      domain: "final_check",
      status: finalOk ? "COMPLETE" : "BLOCKED",
      severity: "CRITICAL",
      title: "Final readiness check",
      explanation: "Every critical domain above must be resolved before you can take real orders.",
      requirement: "No critical blockers remain.",
      currentState: finalOk
        ? "All critical requirements are met."
        : `${criticalBlockers} critical blocker${criticalBlockers === 1 ? "" : "s"} remain.`,
      blocker: finalOk ? null : "Resolve the critical items above first.",
      fixAction: null,
      dependsOn: items.filter((i) => i.severity === "CRITICAL").map((i) => i.domain),
    }),
  );

  const weighted = items.filter(
    (i) => i.severity !== "OPTIONAL" && i.status !== "NOT_APPLICABLE" && i.domain !== "final_check",
  );
  const totalWeight = weighted.reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0);
  const doneWeight = weighted
    .filter((i) => i.status === "COMPLETE")
    .reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0);
  const progressPercent = totalWeight === 0 ? 100 : Math.round((doneWeight / totalWeight) * 100);

  let goLiveState: GoLiveState = "NOT_READY";
  if (criticalBlockers === 0) {
    goLiveState = "READY_FOR_TEST";
    if (highBlockers === 0 && hasRecordedTestSale) goLiveState = "READY_FOR_GO_LIVE";
  }
  if (goLiveState === "READY_FOR_GO_LIVE" && readinessSettings.liveConfirmedAt) {
    goLiveState = "LIVE";
  }

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    items,
    progressPercent,
    goLiveState,
    criticalBlockers,
    highBlockers,
    warnings,
    hasRecordedTestSale,
    liveConfirmedAt: readinessSettings.liveConfirmedAt ?? null,
    liveConfirmedBy: readinessSettings.liveConfirmedBy ?? null,
  };
}

/**
 * The one deliberate write in this module: an owner confirms go-live. Never
 * inferred automatically from configuration rows existing — this requires a
 * real recorded test sale (checked server-side, not trusted from the client)
 * and an explicit, capability-gated, audited action.
 */
export async function confirmGoLive(sb: Sb, userId: string, tenantId: string) {
  await assertCapability(sb, userId, tenantId, "tenant.manage");
  const report = await computeReadiness(sb, userId, tenantId);
  if (report.goLiveState !== "READY_FOR_GO_LIVE") {
    throw new Error(
      "Not ready to go live yet — resolve the remaining critical items and record a test sale first.",
    );
  }
  const { data: tenantRow, error: readErr } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", tenantId)
    .single();
  if (readErr) throw new Error(readErr.message);
  const existing = (tenantRow?.settings ?? {}) as Record<string, any>;
  const settings = {
    ...existing,
    readiness: {
      ...(existing.readiness ?? {}),
      liveConfirmedAt: new Date().toISOString(),
      liveConfirmedBy: userId,
    },
  };
  const { error } = await sb.from("restaurant_tenants").update({ settings }).eq("id", tenantId);
  if (error) throw new Error(error.message);
  return computeReadiness(sb, userId, tenantId);
}
