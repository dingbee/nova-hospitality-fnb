import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  approvalRuleSchema,
  convertRequestToOrderSchema,
  createReceiptSchema,
  getPurchaseRequestSchema,
  getReceiptSchema,
  listAuditSchema,
  listInvoicesSchema,
  listPriceHistorySchema,
  listPurchaseRequestsSchema,
  listReceiptsSchema,
  listVariancesSchema,
  matchInvoiceSchema,
  postReceiptSchema,
  procurementOverviewSchema,
  recordConfirmationSchema,
  recordInvoiceSchema,
  resolveVarianceSchema,
  savePurchaseRequestSchema,
  setInvoicePaymentStatusSchema,
  supplierPerformanceSchema,
  transitionPurchaseRequestSchema,
} from "./contracts";

/* ---------------- Purchase requests ---------------- */

export const listRestaurantPurchaseRequestsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPurchaseRequestsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requests.server");
    return mod.listPurchaseRequests(context.supabase, context.userId, data);
  });

export const getRestaurantPurchaseRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getPurchaseRequestSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requests.server");
    return mod.getPurchaseRequest(context.supabase, context.userId, data.tenantId, data.id);
  });

export const saveRestaurantPurchaseRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => savePurchaseRequestSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requests.server");
    return mod.savePurchaseRequest(context.supabase, context.userId, data);
  });

export const transitionRestaurantPurchaseRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transitionPurchaseRequestSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requests.server");
    return mod.transitionPurchaseRequest(context.supabase, context.userId, data);
  });

export const convertRestaurantRequestToOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => convertRequestToOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requests.server");
    return mod.convertRequestToOrder(context.supabase, context.userId, data);
  });

/* ---------------- Approval rules ---------------- */

export const listRestaurantApprovalRulesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => procurementOverviewSchema.parse(d))
  .handler(async ({ data, context }) => {
    const [{ assertTenantRead }, mod] = await Promise.all([
      import("../core/access.server"),
      import("./approvals.server"),
    ]);
    await assertTenantRead(context.supabase, context.userId, data.tenantId);
    return mod.listApprovalRules(context.supabase, data.tenantId);
  });

export const saveRestaurantApprovalRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => approvalRuleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const [{ assertCapability }, mod] = await Promise.all([
      import("../core/access.server"),
      import("./approvals.server"),
    ]);
    await assertCapability(context.supabase, context.userId, data.tenantId, "tenant.manage");
    return mod.upsertApprovalRule(context.supabase, data);
  });

/* ---------------- Supplier confirmation ---------------- */

export const recordRestaurantSupplierConfirmationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordConfirmationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./confirmations.server");
    return mod.recordSupplierConfirmation(context.supabase, context.userId, data);
  });

/* ---------------- Goods receiving ---------------- */

export const listRestaurantGoodsReceiptsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listReceiptsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receiving.server");
    return mod.listGoodsReceipts(context.supabase, context.userId, data);
  });

export const getRestaurantGoodsReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receiving.server");
    return mod.getGoodsReceipt(context.supabase, context.userId, data.tenantId, data.id);
  });

export const createRestaurantGoodsReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receiving.server");
    return mod.createGoodsReceipt(context.supabase, context.userId, data);
  });

export const postRestaurantGoodsReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => postReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receiving.server");
    return mod.postGoodsReceipt(context.supabase, context.userId, data.tenantId, data.id);
  });

/* ---------------- Variances ---------------- */

export const listRestaurantProcurementVariancesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listVariancesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./variances.server");
    return mod.listVariances(context.supabase, context.userId, data);
  });

export const resolveRestaurantProcurementVarianceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolveVarianceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./variances.server");
    return mod.resolveVariance(context.supabase, context.userId, data);
  });

/* ---------------- Supplier invoices ---------------- */

export const listRestaurantSupplierInvoicesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listInvoicesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./invoices.server");
    return mod.listSupplierInvoices(context.supabase, context.userId, data);
  });

export const recordRestaurantSupplierInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./invoices.server");
    return mod.recordSupplierInvoice(context.supabase, context.userId, data);
  });

export const matchRestaurantSupplierInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => matchInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./invoices.server");
    return mod.matchSupplierInvoice(context.supabase, context.userId, data.tenantId, data.invoiceId);
  });

export const setRestaurantInvoicePaymentStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setInvoicePaymentStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./invoices.server");
    return mod.setInvoicePaymentStatus(context.supabase, context.userId, data);
  });

/* ---------------- Price history, performance, overview, audit ---------------- */

export const listRestaurantPriceHistoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPriceHistorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listPriceHistory(context.supabase, context.userId, data);
  });

export const restaurantSupplierPerformanceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => supplierPerformanceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.supplierPerformanceEvidence(context.supabase, context.userId, data);
  });

export const restaurantProcurementOverviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => procurementOverviewSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./overview.server");
    return mod.procurementOverview(context.supabase, context.userId, data.tenantId);
  });

export const listRestaurantProcurementAuditFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listAuditSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./overview.server");
    return mod.listProcurementAudit(context.supabase, context.userId, data);
  });
