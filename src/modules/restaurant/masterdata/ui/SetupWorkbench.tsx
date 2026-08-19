/* eslint-disable @typescript-eslint/no-explicit-any -- server function rows are untyped at this boundary. */
/**
 * Restaurant Setup Workbench.
 *
 * A blank tenant becomes an operating restaurant here, in dependency order:
 * business → properties → outlets → stores → units → categories → stock items
 * → suppliers → supplier catalogue → stations → tables → service periods.
 * The readiness list is derived from real rows, never from a stored "step",
 * so it stays honest if data is changed elsewhere.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { StatusChip } from "@/components/os/StatusChip";
import { cn } from "@/lib/utils";
import { useRestaurantWorkspace } from "../../ui/useRestaurantWorkspace";
import { listRestaurantMasterDataFn } from "../masterdata.functions";
import type { MasterData } from "./types";
import { BusinessPanel } from "./panels/BusinessPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { LocationsPanel } from "./panels/LocationsPanel";
import { UnitsPanel } from "./panels/UnitsPanel";
import { CategoriesPanel } from "./panels/CategoriesPanel";
import { ItemsPanel } from "./panels/ItemsPanel";
import { SuppliersPanel } from "./panels/SuppliersPanel";
import { SupplierProductsPanel } from "./panels/SupplierProductsPanel";
import { StationsPanel } from "./panels/StationsPanel";
import { TablesPanel } from "./panels/TablesPanel";
import { ServicePeriodsPanel } from "./panels/ServicePeriodsPanel";

type StepId =
  | "business"
  | "properties"
  | "outlets"
  | "stores"
  | "units"
  | "categories"
  | "items"
  | "suppliers"
  | "supplier-products"
  | "stations"
  | "tables"
  | "service-periods";

interface Step {
  id: StepId;
  label: string;
  requirement: string;
  /** Rows that must exist for this step to count as done. */
  done: (d: MasterData) => boolean;
  count: (d: MasterData) => number;
  /** Setup cannot proceed without it — vs. useful but optional. */
  essential: boolean;
}

const STEPS: Step[] = [
  {
    id: "business",
    label: "Business",
    requirement: "Name the business and its trading identity.",
    done: (d) => Boolean(d.tenant?.name),
    count: (d) => (d.tenant ? 1 : 0),
    essential: true,
  },
  {
    id: "properties",
    label: "Properties",
    requirement: "At least one property with a currency and timezone.",
    done: (d) => d.properties.length > 0,
    count: (d) => d.properties.length,
    essential: true,
  },
  {
    id: "outlets",
    label: "Outlets",
    requirement: "Where guests are served — restaurant, bar, room service.",
    done: (d) => d.locations.some((l) => !l.is_storage),
    count: (d) => d.locations.filter((l) => !l.is_storage).length,
    essential: true,
  },
  {
    id: "stores",
    label: "Stores",
    requirement: "Where stock is held. Requisitions and transfers need these.",
    done: (d) => d.locations.some((l) => l.is_storage),
    count: (d) => d.locations.filter((l) => l.is_storage).length,
    essential: true,
  },
  {
    id: "units",
    label: "Units",
    requirement: "Units of measure before any stock item can be counted.",
    done: (d) => d.units.length > 0,
    count: (d) => d.units.length,
    essential: true,
  },
  {
    id: "categories",
    label: "Categories",
    requirement: "Inventory and product categories for reporting.",
    done: (d) => d.inventoryCategories.length > 0 || d.productCategories.length > 0,
    count: (d) => d.inventoryCategories.length + d.productCategories.length,
    essential: true,
  },
  {
    id: "items",
    label: "Stock items",
    requirement: "The things you buy, count and consume.",
    done: (d) => d.inventoryItems.length > 0,
    count: (d) => d.inventoryItems.length,
    essential: true,
  },
  {
    id: "suppliers",
    label: "Suppliers",
    requirement: "Who you buy from. Required before purchasing.",
    done: (d) => d.suppliers.length > 0,
    count: (d) => d.suppliers.length,
    essential: true,
  },
  {
    id: "supplier-products",
    label: "Supplier catalogue",
    requirement: "Supplier pack sizes and prices for faster ordering.",
    done: (d) => d.supplierProducts.length > 0,
    count: (d) => d.supplierProducts.length,
    essential: false,
  },
  {
    id: "stations",
    label: "Kitchen stations",
    requirement: "Where tickets are routed on the kitchen display.",
    done: (d) => d.stations.length > 0,
    count: (d) => d.stations.length,
    essential: false,
  },
  {
    id: "tables",
    label: "Tables",
    requirement: "Table plan used by the POS.",
    done: (d) => d.tables.length > 0,
    count: (d) => d.tables.length,
    essential: false,
  },
  {
    id: "service-periods",
    label: "Service periods",
    requirement: "Breakfast, lunch, dinner — used by pricing and reporting.",
    done: (d) => d.servicePeriods.length > 0,
    count: (d) => d.servicePeriods.length,
    essential: false,
  },
];

export function SetupWorkbench() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const fn = useServerFn(listRestaurantMasterDataFn);

  const q = useQuery({
    queryKey: ["restaurant.masterdata", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });
  const data = q.data as MasterData | undefined;

  const [step, setStep] = React.useState<StepId>("business");

  if (!ws.isLoading && !ws.data?.tenant) {
    return <EmptyState title="No restaurant tenant" description="You are not a member of a Restaurant & Bar OS tenant." />;
  }
  if (!tenantId || !data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Restaurant setup" description="Loading your configuration…" />
      </div>
    );
  }

  const essential = STEPS.filter((s) => s.essential);
  const essentialDone = essential.filter((s) => s.done(data)).length;
  const ready = essentialDone === essential.length;
  const active = STEPS.find((s) => s.id === step) ?? STEPS[0]!;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Restaurant setup"
        description="Configure a blank restaurant end to end, in the order each step depends on the last."
      />

      <SectionCard
        title="Readiness"
        description="Derived from what actually exists — not from a stored progress flag."
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip tone={ready ? "success" : "warning"}>
            {ready ? "ready to trade" : `${essentialDone}/${essential.length} essentials`}
          </StatusChip>
          <span className="text-xs text-muted-foreground">
            {ready
              ? "Every essential step is configured. Products, recipes and menus are next."
              : "Finish the essential steps below before taking orders."}
          </span>
        </div>
        {ready ? (
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Link to="/admin/restaurant/products" search={{ tab: undefined }} className="underline">
              Products &amp; recipes
            </Link>
            <Link to="/admin/restaurant/menu" className="underline">
              Menus
            </Link>
            <Link to="/admin/restaurant/pricing" className="underline">
              Pricing &amp; tax
            </Link>
          </div>
        ) : null}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <SectionCard title="Steps" description="Dependency order.">
          <ul className="space-y-1">
            {STEPS.map((s) => {
              const done = s.done(data);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setStep(s.id)}
                    className={cn(
                      "flex min-h-12 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm",
                      s.id === step ? "bg-muted font-medium" : "hover:bg-muted/60",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {done ? <Check className="h-4 w-4 text-[color:var(--os-success)]" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      {s.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.count(data)}
                      {s.essential ? "" : " · optional"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title={active.label} description={active.requirement}>
            <StatusChip tone={active.done(data) ? "success" : active.essential ? "warning" : "neutral"}>
              {active.done(data) ? "configured" : active.essential ? "required" : "optional"}
            </StatusChip>
          </SectionCard>

          {step === "business" && <BusinessPanel tenantId={tenantId} data={data} />}
          {step === "properties" && <PropertiesPanel tenantId={tenantId} data={data} />}
          {step === "outlets" && <LocationsPanel tenantId={tenantId} data={data} mode="outlet" />}
          {step === "stores" && <LocationsPanel tenantId={tenantId} data={data} mode="store" />}
          {step === "units" && <UnitsPanel tenantId={tenantId} data={data} />}
          {step === "categories" && <CategoriesPanel tenantId={tenantId} data={data} />}
          {step === "items" && <ItemsPanel tenantId={tenantId} data={data} />}
          {step === "suppliers" && <SuppliersPanel tenantId={tenantId} data={data} />}
          {step === "supplier-products" && <SupplierProductsPanel tenantId={tenantId} data={data} />}
          {step === "stations" && <StationsPanel tenantId={tenantId} data={data} />}
          {step === "tables" && <TablesPanel tenantId={tenantId} data={data} />}
          {step === "service-periods" && <ServicePeriodsPanel tenantId={tenantId} data={data} />}
        </div>
      </div>
    </div>
  );
}