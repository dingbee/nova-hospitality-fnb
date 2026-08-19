/**
 * Phase 4 — Restaurant option catalogues and constraints.
 *
 * Every option is a real operational lever with an `actionType` an owning
 * module can execute. Scores are hand-set business judgement, adjusted by the
 * finding's facts so identical option keys score differently for a star dish
 * versus a dog. Deterministic — no AI, no randomness.
 */
import type {
  DecisionConstraint,
  DecisionDomain,
  DecisionOption,
} from "@/modules/intelligence/decisions/decision.types";
import type { RestaurantFinding, RestaurantFindingKind } from "./decision.types";

export const DOMAIN_FOR_KIND: Record<RestaurantFindingKind, DecisionDomain> = {
  menu_margin: "revenue",
  inventory_shortage: "operations",
  wastage_spike: "operations",
  kitchen_capacity: "operations",
  purchasing_replenishment: "revenue",
  supplier_risk: "revenue",
};

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown) => v === true;

/* ------------------------------ menu ------------------------------ */

function menuOptions(f: RestaurantFinding): DecisionOption[] {
  const isStar = bool(f.facts.isStar);
  const isDog = bool(f.facts.isDog);
  const highVolume = bool(f.facts.highVolume);
  const needsCostReview = bool(f.facts.needsCostReview);

  return [
    {
      key: "supplier_change",
      title: "Reduce ingredient cost through a supplier change",
      summary: "Re-source the highest-cost recipe components before touching the menu price.",
      actionType: "restaurant.purchase.suggest",
      tactics: [
        "Identify the top three cost drivers in the recipe",
        "Request quotes from alternative approved suppliers",
        "Re-cost the recipe with the winning quote",
      ],
      scores: {
        expected_revenue: 0.7,
        margin_impact: 0.85,
        guest_experience: 0.9,
        strategic_alignment: 0.85,
        operational_feasibility: 0.65,
        risk: 0.75,
        historical_evidence: needsCostReview ? 0.7 : 0.6,
      },
      tags: ["supplier_switch"],
      effort: "medium",
    },
    {
      key: "adjust_recipe",
      title: "Adjust the recipe",
      summary: "Re-balance portion sizes or components to recover margin without changing the price.",
      actionType: "restaurant.menu.reprice_review",
      tactics: [
        "Review portion weights against the costed recipe",
        "Trim or substitute the highest-cost component",
        "Re-run recipe costing and taste-check the result",
      ],
      scores: {
        expected_revenue: 0.6,
        margin_impact: 0.8,
        guest_experience: isStar ? 0.4 : 0.55,
        strategic_alignment: 0.6,
        operational_feasibility: 0.75,
        risk: 0.6,
        historical_evidence: 0.55,
      },
      tags: isStar ? ["quality_risk", "signature_dish"] : ["quality_risk"],
      effort: "medium",
    },
    {
      key: "increase_price",
      title: "Increase the menu price",
      summary: "Lift the price one band to restore the target margin.",
      actionType: "restaurant.menu.reprice_review",
      tactics: ["Set the new price against the costed target margin", "Reprint or republish the menu"],
      scores: {
        expected_revenue: highVolume ? 0.8 : 0.55,
        margin_impact: 0.85,
        guest_experience: 0.4,
        strategic_alignment: 0.5,
        operational_feasibility: 0.9,
        risk: 0.45,
        historical_evidence: 0.5,
      },
      tags: ["price_increase", "guest_visible"],
      effort: "low",
    },
    {
      key: "remove_item",
      title: "Remove the item from the menu",
      summary: "Delist the dish and redirect demand to a better-performing alternative.",
      actionType: "restaurant.menu.reprice_review",
      tactics: ["Delist the item at the next menu change", "Brief service on the replacement recommendation"],
      scores: {
        expected_revenue: isDog ? 0.6 : 0.3,
        margin_impact: isDog ? 0.75 : 0.5,
        guest_experience: isStar ? 0.1 : 0.45,
        strategic_alignment: isDog ? 0.7 : 0.35,
        operational_feasibility: 0.85,
        risk: isStar ? 0.2 : 0.6,
        historical_evidence: 0.5,
      },
      tags: isStar || highVolume ? ["menu_removal", "signature_dish"] : ["menu_removal"],
      effort: "low",
    },
    {
      key: "monitor_menu",
      title: "Hold and monitor for one more window",
      summary: "Change nothing and re-measure after the next costing cycle.",
      actionType: "restaurant.no_change",
      tactics: ["Re-run menu intelligence after the next window"],
      scores: {
        expected_revenue: 0.4,
        margin_impact: 0.35,
        guest_experience: 0.7,
        strategic_alignment: 0.4,
        operational_feasibility: 1,
        risk: 0.7,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
  ];
}

/* ---------------------------- inventory ---------------------------- */

function shortageOptions(f: RestaurantFinding): DecisionOption[] {
  const urgent = bool(f.facts.urgent);
  return [
    {
      key: "emergency_purchase",
      title: "Emergency purchase",
      summary: "Raise an immediate order with the fastest available supplier.",
      actionType: "restaurant.inventory.replenish_review",
      tactics: [
        "Raise a purchase order for the shortfall quantity",
        "Confirm same-day or next-day delivery with the supplier",
        "Receive and post the stock movement on arrival",
      ],
      scores: {
        operational_feasibility: urgent ? 0.85 : 0.7,
        guest_experience: 0.9,
        risk: 0.8,
        margin_impact: 0.45,
        expected_revenue: 0.8,
        historical_evidence: 0.65,
      },
      tags: ["premium_cost"],
      effort: "medium",
    },
    {
      key: "substitute_menu_item",
      title: "Substitute the affected menu items",
      summary: "Swap in an alternative dish so service is unaffected while stock is replenished normally.",
      actionType: "restaurant.menu.reprice_review",
      tactics: [
        "Identify dishes that consume the item",
        "Mark them unavailable and promote the substitute",
        "Brief service on the substitution",
      ],
      scores: {
        operational_feasibility: 0.8,
        guest_experience: 0.55,
        risk: 0.7,
        margin_impact: 0.75,
        expected_revenue: 0.55,
        historical_evidence: 0.55,
      },
      tags: ["guest_visible"],
      effort: "low",
    },
    {
      key: "reduce_promotion",
      title: "Pull promotion on the affected dishes",
      summary: "Stop pushing demand toward the constrained item until stock recovers.",
      actionType: "restaurant.menu.reprice_review",
      tactics: ["Remove the item from specials and upsell scripts"],
      scores: {
        operational_feasibility: 0.95,
        guest_experience: 0.7,
        risk: 0.75,
        margin_impact: 0.6,
        expected_revenue: 0.4,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "adjust_ordering",
      title: "Adjust the standing ordering pattern",
      summary: "Raise the reorder point and order cadence so the shortage does not repeat.",
      actionType: "restaurant.inventory.replenish_review",
      tactics: [
        "Recalculate the reorder point from observed velocity",
        "Update the standing order quantity and cadence",
      ],
      scores: {
        operational_feasibility: 0.85,
        guest_experience: 0.65,
        risk: 0.75,
        margin_impact: 0.8,
        expected_revenue: 0.55,
        historical_evidence: 0.7,
      },
      tags: [],
      effort: "low",
    },
  ];
}

function wastageOptions(): DecisionOption[] {
  return [
    {
      key: "tighten_prep_par",
      title: "Tighten prep par levels",
      summary: "Prep to observed demand instead of fixed pars on the highest-waste items.",
      actionType: "restaurant.inventory.replenish_review",
      tactics: ["Reset par levels for the top waste items", "Re-brief the kitchen on prep quantities"],
      scores: {
        operational_feasibility: 0.85,
        guest_experience: 0.7,
        risk: 0.75,
        margin_impact: 0.85,
        historical_evidence: 0.6,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "rotation_audit",
      title: "Run a stock rotation and storage audit",
      summary: "Check FIFO discipline, storage temperatures and receiving quality.",
      actionType: "restaurant.inventory.replenish_review",
      tactics: ["Audit storage and rotation on the waste-heavy items", "Log findings against the stock ledger"],
      scores: {
        operational_feasibility: 0.7,
        guest_experience: 0.75,
        risk: 0.8,
        margin_impact: 0.7,
        historical_evidence: 0.6,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "repurpose_menu",
      title: "Repurpose surplus into specials",
      summary: "Design specials around the items being written off.",
      actionType: "restaurant.menu.reprice_review",
      tactics: ["Build a special using the surplus items", "Price it to recover cost"],
      scores: {
        operational_feasibility: 0.65,
        guest_experience: 0.8,
        risk: 0.65,
        margin_impact: 0.7,
        historical_evidence: 0.5,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "monitor_waste",
      title: "Hold and monitor",
      summary: "Keep logging wastage and re-measure next window.",
      actionType: "restaurant.no_change",
      tactics: ["Re-run inventory intelligence next window"],
      scores: {
        operational_feasibility: 1,
        guest_experience: 0.7,
        risk: 0.6,
        margin_impact: 0.3,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
  ];
}

/* ----------------------------- kitchen ----------------------------- */

function kitchenOptions(f: RestaurantFinding): DecisionOption[] {
  const lowVolume = bool(f.facts.lowVolume);
  return [
    {
      key: "add_staff",
      title: "Add cover on the station at peak",
      summary: "Roster an additional commis or chef de partie for the dinner peak.",
      actionType: "restaurant.kitchen.staffing_review",
      tactics: ["Roster additional cover for the peak service", "Confirm the change with the head chef"],
      scores: {
        operational_feasibility: 0.65,
        guest_experience: 0.85,
        risk: 0.75,
        margin_impact: 0.35,
        historical_evidence: lowVolume ? 0.4 : 0.65,
      },
      tags: ["labour_cost"],
      effort: "medium",
    },
    {
      key: "adjust_workflow",
      title: "Adjust the preparation workflow",
      summary: "Move preparable components upstream so the station only finishes at service.",
      actionType: "restaurant.kitchen.workflow_review",
      tactics: [
        "Identify components that can be pre-prepped",
        "Move them into the mise en place schedule",
        "Re-measure ticket times after one week",
      ],
      scores: {
        operational_feasibility: 0.8,
        guest_experience: 0.8,
        risk: 0.8,
        margin_impact: 0.85,
        historical_evidence: 0.65,
      },
      tags: [],
      effort: "medium",
    },
    {
      key: "reduce_menu_complexity",
      title: "Reduce menu complexity on the station",
      summary: "Trim the number of made-to-order dishes routed to this station at peak.",
      actionType: "restaurant.menu.reprice_review",
      tactics: ["Review the dishes routed to the station", "Remove or re-route the slowest one or two"],
      scores: {
        operational_feasibility: 0.7,
        guest_experience: 0.5,
        risk: 0.6,
        margin_impact: 0.7,
        historical_evidence: 0.55,
      },
      tags: ["guest_visible", "menu_removal"],
      effort: "medium",
    },
    {
      key: "reallocate_stations",
      title: "Change station allocation",
      summary: "Re-route part of the load to a station with spare capacity at peak.",
      actionType: "restaurant.kitchen.workflow_review",
      tactics: ["Re-map dish routing across stations", "Update the kitchen display routing"],
      scores: {
        operational_feasibility: 0.75,
        guest_experience: 0.75,
        risk: 0.7,
        margin_impact: 0.8,
        historical_evidence: 0.55,
      },
      tags: [],
      effort: "low",
    },
  ];
}

/* ---------------------------- purchasing ---------------------------- */

function purchasingOptions(f: RestaurantFinding): DecisionOption[] {
  const unreliable = bool(f.facts.unreliableSupplier);
  const hasSupplier = bool(f.facts.hasSupplier);
  return [
    {
      key: "order_as_recommended",
      title: "Raise the recommended purchase order",
      summary: "Order the forecast quantity from the preferred supplier.",
      actionType: "restaurant.purchase.suggest",
      tactics: ["Create the purchase order at the recommended quantity", "Submit it for approval"],
      scores: {
        expected_revenue: 0.7,
        margin_impact: 0.7,
        guest_experience: 0.8,
        strategic_alignment: 0.7,
        operational_feasibility: hasSupplier ? 0.9 : 0.4,
        risk: unreliable ? 0.45 : 0.8,
        historical_evidence: 0.7,
      },
      tags: hasSupplier ? [] : ["no_supplier"],
      effort: "low",
    },
    {
      key: "split_supplier",
      title: "Split the order across suppliers",
      summary: "Protect against late delivery by splitting volume with a second approved supplier.",
      actionType: "restaurant.purchase.suggest",
      tactics: ["Split the quantity across two approved suppliers", "Track delivery performance on both"],
      scores: {
        expected_revenue: 0.6,
        margin_impact: 0.6,
        guest_experience: 0.8,
        strategic_alignment: 0.7,
        operational_feasibility: 0.6,
        risk: unreliable ? 0.85 : 0.7,
        historical_evidence: 0.55,
      },
      tags: ["supplier_switch"],
      effort: "medium",
    },
    {
      key: "renegotiate_price",
      title: "Renegotiate price before ordering",
      summary: "Take the quote back to the supplier, or re-tender, before committing spend.",
      actionType: "restaurant.purchase.suggest",
      tactics: ["Request a revised quote against our average landed cost", "Re-tender if the gap holds"],
      scores: {
        expected_revenue: 0.6,
        margin_impact: 0.9,
        guest_experience: 0.7,
        strategic_alignment: 0.8,
        operational_feasibility: 0.55,
        risk: 0.6,
        historical_evidence: 0.6,
      },
      tags: ["supplier_switch"],
      effort: "medium",
    },
    {
      key: "reduce_order",
      title: "Order short and re-measure",
      summary: "Buy only to the lead time and re-check velocity before the next cycle.",
      actionType: "restaurant.inventory.replenish_review",
      tactics: ["Reduce the order to lead-time cover only", "Re-run purchasing intelligence next week"],
      scores: {
        expected_revenue: 0.45,
        margin_impact: 0.75,
        guest_experience: 0.55,
        strategic_alignment: 0.55,
        operational_feasibility: 0.9,
        risk: 0.55,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
  ];
}

export function optionsFor(f: RestaurantFinding): DecisionOption[] {
  switch (f.kind) {
    case "menu_margin":
      return menuOptions(f);
    case "inventory_shortage":
      return shortageOptions(f);
    case "wastage_spike":
      return wastageOptions();
    case "kitchen_capacity":
      return kitchenOptions(f);
    case "purchasing_replenishment":
    case "supplier_risk":
      return purchasingOptions(f);
  }
}

/**
 * Restaurant constraints. Brand positioning and guest-visible quality always
 * outrank a short-term margin gain, mirroring how the core weighs strategic
 * memory above tactics.
 */
export function constraintsFor(f: RestaurantFinding): DecisionConstraint[] {
  const constraints: DecisionConstraint[] = [
    {
      key: "brand_positioning",
      label: "Brand positioning",
      source: "policy",
      description:
        "The business positions on quality, so ingredient downgrades and guest-visible cuts are penalised before cost levers are considered.",
      effect: "penalise",
      penalty: 0.08,
      violatedByTags: ["quality_risk", "guest_visible"],
    },
    {
      key: "price_before_cost",
      label: "Cost before price",
      source: "policy",
      description:
        "Standing policy: exhaust ingredient and recipe cost levers before raising a guest-facing price.",
      effect: "penalise",
      penalty: 0.1,
      violatedByTags: ["price_increase"],
    },
  ];

  if (bool(f.facts.isStar) || bool(f.facts.highVolume)) {
    constraints.push({
      key: "protect_signature_dishes",
      label: "Protect signature dishes",
      source: "strategic_memory",
      description: "High-volume and star dishes carry the menu's reputation and are not delisted on margin alone.",
      effect: "exclude",
      penalty: 1,
      violatedByTags: ["menu_removal", "signature_dish"],
    });
  }

  if (!bool(f.facts.hasSupplier) && (f.kind === "purchasing_replenishment" || f.kind === "supplier_risk")) {
    constraints.push({
      key: "no_supplier_on_file",
      label: "No supplier product on file",
      source: "availability",
      description: "There is no priced supplier product for this item, so a direct order cannot be raised yet.",
      effect: "exclude",
      penalty: 1,
      violatedByTags: ["no_supplier"],
    });
  }

  if (num(f.facts.delayedPercent) >= 35 || bool(f.facts.urgent)) {
    constraints.push({
      key: "service_protection",
      label: "Service protection",
      source: "capacity",
      description: "Service is already under pressure, so options that add operational load are penalised.",
      effect: "penalise",
      penalty: 0.06,
      violatedByTags: ["high_ops_load", "labour_cost"],
    });
  }

  return constraints;
}