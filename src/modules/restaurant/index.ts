/**
 * Restaurant & Bar OS — public surface (browser-safe).
 * Server implementations stay behind *.server.ts.
 */
export * from "./core/contracts";
export * from "./core/permissions";
export * from "./events/contracts";
export { registerRestaurantIntelligence } from "./intelligence/provider";

export {
  getRestaurantWorkspaceFn,
  listRestaurantMembersFn,
  upsertRestaurantMemberFn,
  removeRestaurantMemberFn,
} from "./core/tenancy.functions";
export { emitRestaurantEventFn } from "./events/events.functions";
export {
  listRestaurantMenusFn,
  upsertRestaurantMenuFn,
  listRestaurantMenuItemsFn,
  upsertRestaurantMenuItemFn,
  listRestaurantCategoriesFn,
} from "./menu/menu.functions";
export {
  listRestaurantInventoryFn,
  listRestaurantUnitsFn,
  upsertRestaurantInventoryItemFn,
} from "./inventory/inventory.functions";
export {
  listRestaurantSuppliersFn,
  listRestaurantSupplierProductsFn,
  upsertRestaurantSupplierFn,
} from "./suppliers/suppliers.functions";
export {
  listRestaurantPurchaseOrdersFn,
  createRestaurantPurchaseOrderFn,
  transitionRestaurantPurchaseOrderFn,
} from "./purchasing/purchasing.functions";
export {
  listRestaurantRecipeComponentsFn,
  upsertRestaurantRecipeComponentFn,
  computeRestaurantRecipeCostFn,
  listRestaurantRecipeCostsFn,
} from "./costing/costing.functions";
export {
  listRestaurantServicePeriodsFn,
  upsertRestaurantServicePeriodFn,
  listRestaurantTablesFn,
  upsertRestaurantTableFn,
  listRestaurantOrdersFn,
  getRestaurantOrderFn,
  createRestaurantOrderFn,
  addRestaurantOrderItemsFn,
  recordRestaurantPaymentFn,
  transitionRestaurantOrderFn,
} from "./sales/sales.functions";
export {
  listRestaurantStationsFn,
  upsertRestaurantStationFn,
  listRestaurantKitchenTicketsFn,
  fireRestaurantOrderFn,
  advanceRestaurantTicketFn,
  restaurantStationPerformanceFn,
} from "./kitchen/kitchen.functions";
export {
  listRestaurantStockMovementsFn,
  recordRestaurantStockMovementFn,
  transferRestaurantStockFn,
} from "./inventory/movements.functions";
export {
  computeRestaurantProfitabilityFn,
  listRestaurantProfitabilityFn,
} from "./costing/profitability.functions";
export { getRestaurantContextFn } from "./intelligence/context.functions";

/* Phase 3 — Restaurant Intelligence Activation */
export * from "./intelligence/types";
export * from "./intelligence/analysis";
export {
  getRestaurantMenuIntelligenceFn,
  getRestaurantInventoryIntelligenceFn,
  getRestaurantKitchenIntelligenceFn,
  getRestaurantPurchasingIntelligenceFn,
} from "./intelligence/insights.functions";

/* Phase 4 — Restaurant Decision Intelligence */
export * from "./decisions/decision.types";
export { gatherFindings } from "./decisions/findings";
export { optionsFor, constraintsFor, DOMAIN_FOR_KIND } from "./decisions/optionCatalogue";
export {
  buildRestaurantDecision,
  buildRestaurantDecisions,
  restaurantDecisionHeadline,
} from "./decisions/restaurantDecisionEngine";
export {
  getRestaurantDecisionBoardFn,
  runRestaurantDecisionPassFn,
} from "./decisions/decisions.functions";

/* Phase 2 contracts (declared, not implemented) */
export * as SalesContracts from "./sales/contracts";
export * as ServiceOpsContracts from "./operations/contracts";
export * from "./procurement/procurement.functions";
export * from "./procurement/contracts";
export * from "./procurement/lifecycle";

/* Sprint 5.2 — Inventory Control & Multi-Location */
export * from "./inventory/contracts";
export * from "./inventory/units";
export * from "./inventory/control.functions";

/* Sprint 5.3 — Product, Recipe & Production Architecture */
export * as ProductContracts from "./products/contracts";
export * from "./products/catalog.functions";

/* Sprint 5.4 — Pricing, Tax & Commercial Rules */
export * as PricingContracts from "./pricing/contracts";
export * from "./pricing/engine";
export * from "./pricing/pricing.functions";
